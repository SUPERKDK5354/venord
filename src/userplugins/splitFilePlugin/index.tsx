import definePlugin from "@utils/types";
import { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import * as webpack from "@webpack";
// Patcher is not available in Vencord API
// import { Patcher } from "@utils/webpack";
import { FluxDispatcher as Dispatcher, SelectedChannelStore as ChannelStore, MessageActions, RestAPI, Constants, SnowflakeUtils, Toasts, showToast, Menu, ContextMenuApi } from "@webpack/common";
import { useCallback, useState, useEffect, useRef } from "@webpack/common";
import { ChatBarButton } from "@api/ChatButtons";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
// import { NsUI } from "@utils/types"; // Vencord standard type import

// Optimized chunk size. Set to 9.5MB to be safe for 10MB upload limits.
// const CHUNK_SIZE = 9.5 * 1024 * 1024; // Now dynamic
const CHUNK_TIMEOUT = 5 * 60 * 1000; // 5-minute cache expiration for incomplete files.

const CloudUpload = webpack.findLazy(m => m.prototype?.trackUploadFinished);
const ButtonClasses = webpack.findByPropsLazy("lookFilled", "colorBrand", "sizeSmall");

import { settings } from "./settings";

interface PendingUpload {
    id: number; // timestamp
    name: string;
    size: number;
    chunkSize: number;
    totalChunks: number;
    completedIndices: number[];
    channelId: string;
    lastUpdated: number;
}

/**
 * Metadata structure for a file chunk.
 * This object is JSON-stringified and sent as the message content,
 * excluding the binary payload which is sent as an attachment.
 */
interface FileChunkMetadata {
    type: "FileSplitterChunk"; // A unique identifier to distinguish chunk messages.
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
    checksum?: string; // SHA-256 hex string
}

/**
 * Represents a chunk stored in the local ChunkManager.
 * Correlates the metadata with the attachment's resolvable CDN URL.
 */
interface StoredFileChunk extends FileChunkMetadata {
    url: string; // The Discord CDN URL for the attached file part.
    proxyUrl?: string; // The Discord Media Proxy URL
}

// Interface for the local chunk storage.
interface ChunkStorage {
    [key: string]: { // Keyed by timestamp (session ID)
        chunks: StoredFileChunk[];
        lastUpdated: number;
    };
}

// --- Webpack Module Resolution ---
// Locating necessary Discord internal modules.

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const calculateChecksum = async (file: File | Blob): Promise<string> => {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.error("[FileSplitter] Checksum calculation failed:", e);
        return "error";
    }
};


const FileSplitterContextMenu = () => {
    const { bypassLimit, chunkSize } = settings.use(["bypassLimit", "chunkSize"]);
    return (
        <Menu.Menu navId="file-splitter-context" onClose={ContextMenuApi.closeContextMenu}>
            <Menu.MenuGroup label="Settings">
                <Menu.MenuCheckboxItem
                    id="bypass-limit"
                    label="Allow >500MB Uploads (might not work)"
                    checked={bypassLimit}
                    action={() => {
                        settings.store.bypassLimit = !bypassLimit;
                    }}
                />
            </Menu.MenuGroup>
            <Menu.MenuGroup label="Chunk Size">
                <Menu.MenuRadioItem
                    id="size-9.5"
                    label="9.5 MB (Free)"
                    checked={chunkSize === 9.5}
                    action={() => settings.store.chunkSize = 9.5}
                />
                <Menu.MenuRadioItem
                    id="size-49"
                    label="49 MB (Nitro Basic / Boost L2)"
                    checked={chunkSize === 49}
                    action={() => settings.store.chunkSize = 49}
                />
                <Menu.MenuRadioItem
                    id="size-99"
                    label="99 MB (Boost L3)"
                    checked={chunkSize === 99}
                    action={() => settings.store.chunkSize = 99}
                />
                <Menu.MenuRadioItem
                    id="size-499"
                    label="499 MB (Nitro Full)"
                    checked={chunkSize === 499}
                    action={() => settings.store.chunkSize = 499}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
};

// Temporary workaround for missing native fetch
// We will try to rely on RestAPI if possible, but if not, we might need to add native support.
// For now, let's try RestAPI.get which might handle Discord CDN better?
// Actually, let's not edit the core files unless requested.
// I will try RestAPI first.

/**
 * Manages the assembly of file chunks received from messages.
 * This is a static class acting as a singleton storage manager.
 */
class ChunkManager {
    private static storage: ChunkStorage = {};

    /**
     * Adds a received chunk to the storage.
     * @param chunk The stored chunk object containing metadata and URL.
     */
    static addChunk(chunk: StoredFileChunk): void {
        const key = chunk.timestamp.toString(); // Use unique session ID
        if (!this.storage[key]) {
            this.storage[key] = {
                chunks: [],
                lastUpdated: Date.now()
            };
        }

        // Idempotency check: prevent processing or storing the same chunk index multiple times.
        if (!this.storage[key].chunks.some(c => c.index === chunk.index)) {
            this.storage[key].chunks.push(chunk);
            this.storage[key].lastUpdated = Date.now();
        }
    }

    /**
     * Retrieves all stored chunks for a given file session.
     * @param sessionId The timestamp/ID of the upload session.
     * @returns An array of stored chunks or null if none found.
     */
    static getChunks(sessionId: number): StoredFileChunk[] | null {
        return this.storage[sessionId.toString()]?.chunks || null;
    }

    /**
     * Garbage collection: Removes chunk data that hasn't been updated
     * within the CHUNK_TIMEOUT window.
     */
    static cleanOldChunks(): void {
        const now = Date.now();
        Object.keys(this.storage).forEach(key => {
            if (now - this.storage[key].lastUpdated > CHUNK_TIMEOUT) {
                delete this.storage[key];
                console.log(`[FileSplitter] Garbage collected stale chunks for session: ${key}`);
            }
        });
    }
}

// --- Core Utilities ---

/**
 * Type guard to validate if a parsed message object is a valid FileChunk.
 * @param chunk The object to validate (parsed from JSON).
 * @returns True if the object adheres to the FileChunkMetadata protocol.
 */
const isValidChunk = (chunk: any): chunk is FileChunkMetadata => {
    return (
        typeof chunk === 'object' &&
        chunk.type === "FileSplitterChunk" && // Verify the unique identifier.
        typeof chunk.index === 'number' &&
        typeof chunk.total === 'number' &&
        typeof chunk.originalName === 'string' &&
        typeof chunk.originalSize === 'number' &&
        typeof chunk.timestamp === 'number'
    );
};

/**
 * Asynchronously merges all file chunks into a single file and triggers a download.
 * @param chunks An array of StoredFileChunk objects.
 */
const handleFileMerge = async (chunks: StoredFileChunk[]) => {
    try {
        // Ensure chunks are in the correct order.
        chunks.sort((a, b) => a.index - b.index);

        console.log(`[FileSplitter] Merging ${chunks.length} chunks. Metadata of first chunk:`, chunks[0]);

        const blobParts: Blob[] = [];
        for (const chunk of chunks) {
            // Use Vencord's native fetch to bypass CORS
            // This requires the corresponding IPC handler we added to ipcMain.ts
            // VencordNative is exposed directly on window by preload.ts
            const fetcher = (window as any).VencordNative?.net?.fetch;
            if (!fetcher) {
                console.error("VencordNative:", (window as any).VencordNative);
                throw new Error("VencordNative.net.fetch is missing! Update Vencord.");
            }

            const arrayBuffer = await fetcher(chunk.url);
            if (!arrayBuffer) {
                throw new Error(`Failed to fetch chunk ${chunk.index + 1}`);
            }
            const blob = new Blob([arrayBuffer]);
            blobParts.push(blob);
        }

        // Assemble the final file.
        const finalBlob = new Blob(blobParts);
        const finalFile = new File([finalBlob], chunks[0].originalName);

        // Verify Checksum
        if (chunks[0].checksum) {
            console.log("[FileSplitter] Verifying checksum...");
            const mergedChecksum = await calculateChecksum(finalFile);
            if (mergedChecksum === chunks[0].checksum) {
                console.log("FILECHECKSUM OUTPUT: 100%");
                console.log("[FileSplitter] Integrity check passed!");
            } else {
                console.error("FILECHECKSUM OUTPUT: FAILED");
                console.error(`[FileSplitter] Checksum mismatch! Expected ${chunks[0].checksum}, got ${mergedChecksum}`);
                showToast("File checksum mismatch! The download may be corrupted.", Toasts.Type.FAILURE);
            }
        } else {
            console.warn("[FileSplitter] No checksum found in metadata. Skipping verification.");
        }

        // Generates a client-side download by creating a virtual link.
        const url = URL.createObjectURL(finalFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = finalFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`[FileSplitter] File merged and downloaded successfully: ${finalFile.name}`);

    } catch (error) {
        console.error('[FileSplitter] Error during file merge process:', error);
    }
};

// --- React Component: UI ---



const UploadIcon = (props: any) => (

    <svg {...props} viewBox="0 0 24 24" fill="currentColor">

        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z" />

    </svg>

);



const DownloadButton = ({ message }: { message: any }) => {

    const [status, setStatus] = useState("Checking...");

    const [disabled, setDisabled] = useState(false);



    const handleClick = useCallback(() => {

        try {

            const chunkData = JSON.parse(message.content);

            const chunks = ChunkManager.getChunks(chunkData.timestamp); // Use timestamp as key

            

            if (!chunks || chunks.length !== chunkData.total) {

                setStatus(`Missing chunks (${chunks?.length || 0}/${chunkData.total})`);

                return;

            }



            setStatus("Merging...");

            setDisabled(true);

            handleFileMerge(chunks).then(() => {

                setStatus("Downloaded!");

                setDisabled(false);

            });

        } catch (e) {

            console.error(e);

            setStatus("Error");

        }

    }, [message]);



    // Initial check and auto-registration
    useEffect(() => {
        try {
            const chunkData = JSON.parse(message.content);

            // Auto-register this chunk if it's valid (re-hydrating state from history)
            if (isValidChunk(chunkData) && message.attachments?.length > 0) {
                const attachment = message.attachments[0];
                ChunkManager.addChunk({
                    ...chunkData,
                    url: attachment.url,
                    proxyUrl: attachment.proxy_url
                });
            }

            const chunks = ChunkManager.getChunks(chunkData.timestamp); // Use timestamp as key

            if (chunks && chunks.length === chunkData.total) {
                setStatus("Download Merged File");
            } else {
                setStatus(`Waiting for chunks (${chunks?.length || 0}/${chunkData.total})...`);
            }
        } catch {}
    }, [message]);



    return (
        <button
            className={`${ButtonClasses.button} ${ButtonClasses.lookFilled} ${ButtonClasses.colorBrand} ${ButtonClasses.sizeSmall} ${ButtonClasses.grow}`}
            onClick={handleClick}
            disabled={disabled}
            style={{ marginTop: 4, width: '100%' }}
        >
            <div className={ButtonClasses.contents}>{status}</div>
        </button>
    );
};



/**

 * The React component that provides the UI for selecting and uploading large files.

 */

import { openModal } from "@utils/modal";
import { UploadManager } from "./UploadManager";
import { UploadsDashboard } from "./UploadsDashboard";

const SplitFileComponent = () => {
    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Pre-flight check
        if (file.size > 500 * 1024 * 1024 && !settings.store.bypassLimit) {
             showToast("File > 500MB. Enable bypass in settings.", Toasts.Type.FAILURE);
             return;
        }

        const sizeMB = settings.store.chunkSize || 9.5;
        // Trigger global upload
        UploadManager.startUpload(file, sizeMB);
        
        // Open dashboard immediately for feedback
        openModal(props => <UploadsDashboard {...props} />);
        
        e.target.value = "";
    }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="file-splitter-context" onClose={ContextMenuApi.closeContextMenu}>
                <Menu.MenuItem 
                    id="manage-uploads" 
                    label="Manage Uploads" 
                    action={() => openModal(props => <UploadsDashboard {...props} />)} 
                />
                <Menu.MenuGroup label="Settings">
                    <Menu.MenuCheckboxItem
                        id="bypass-limit"
                        label="Allow >500MB Uploads"
                        checked={settings.store.bypassLimit}
                        action={() => settings.store.bypassLimit = !settings.store.bypassLimit}
                    />
                </Menu.MenuGroup>
                <Menu.MenuGroup label="Chunk Size">
                    {[9.5, 49, 99, 499].map(size => (
                        <Menu.MenuRadioItem
                            key={size}
                            id={`size-${size}`}
                            label={`${size} MB`}
                            checked={settings.store.chunkSize === size}
                            action={() => settings.store.chunkSize = size}
                        />
                    ))}
                </Menu.MenuGroup>
            </Menu.Menu>
        ));
    }, []);

    return (
        <>
            <input
                type="file"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="file-splitter-input"
            />
            <ChatBarButton
                onClick={() => document.getElementById('file-splitter-input')?.click()}
                onContextMenu={handleContextMenu}
                tooltip="Upload Large File"
            >
                <UploadIcon />
            </ChatBarButton>
        </>
    );
};

// --- Vencord Plugin Definition ---

export default definePlugin({
    name: "FileSplitter",
    description: "Splits large files into 25MB chunks to bypass Discord's default limit.",
    authors: [
        {
            id: 1234567890n,
            name: "Your Name",
        },
    ],
    settings,

    // This property is used to store the interval ID for cleanup.
    chunkCleanupInterval: null as NodeJS.Timeout | null,

        chatBarButton: {

            render: SplitFileComponent,

            icon: UploadIcon

        },

    

        renderMessageAccessory({ message }: { message: any }) {

            try {

                if (!message.content) return null;

                const data = JSON.parse(message.content);

                if (isValidChunk(data)) {

                    return <DownloadButton message={message} />;

                }

            } catch { }

            return null;

        },

    

        /**

         * Handler for the 'MESSAGE_CREATE' dispatch event.

         * Intercepts incoming messages to find and assemble chunks.

         * @param { message: any } The message payload from Discord.

         */

        onMessageCreate({ message }: { message: any }) {

            try {

                // console.log("[FileSplitter] Message received:", message.id);

                // Optimization: If there's no content or no attachment, it can't be a chunk.

                if (!message.content || !message.attachments?.length) return;

    

                // Try to parse content

                let chunkData;

                try {

                    chunkData = JSON.parse(message.content);

                } catch {

                    return; // Not JSON, ignore silently

                }

    

                // Validate if this message is one of our file chunks.

                if (isValidChunk(chunkData)) {

                    console.log(`[FileSplitter] Received chunk ${chunkData.index + 1}/${chunkData.total} for ${chunkData.originalName}`);

                    

                                    const attachment = message.attachments[0];

                    

                                    if (!attachment?.url) return; // Should not happen, but safeguard.

                    

                    

                    

                                    const storedChunk: StoredFileChunk = {

                    

                                        ...chunkData,

                    

                                        url: attachment.url,

                    

                                        proxyUrl: attachment.proxy_url

                    

                                    };

                    

                    

                    

                                    ChunkManager.addChunk(storedChunk);

    

                                        // Check if all chunks have been received.

    

                                        const chunks = ChunkManager.getChunks(chunkData.timestamp);

    

                                        const count = chunks ? chunks.length : 0;

    

                                        console.log(`[FileSplitter] Collected ${count}/${chunkData.total} chunks.`);

    

                    

    

                                        // Auto-merge disabled. Waiting for user interaction via UI.

    

                                        /*

    

                                        if (chunks && chunks.length === chunkData.total) {

    

                                            console.log(`[FileSplitter] All ${chunkData.total} chunks received for ${chunkData.originalName}. Initiating merge...`);

    

                                            handleFileMerge(chunks);

    

                                        }

    

                                        */

    

                                    }

    

                                } catch (e) {

    

                                    console.error("[FileSplitter] Error in onMessageCreate:", e);

    

                                }

    

                            },

                start() {

                    UploadManager.init();

        

                    // Initiate periodic garbage collection for expired chunk data.

            this.chunkCleanupInterval = setInterval(() => {

                ChunkManager.cleanOldChunks();

            }, 60000); // Run every 60 seconds.

    

            // 1. Subscribe to the 'MESSAGE_CREATE' event to intercept incoming messages.

            Dispatcher.subscribe("MESSAGE_CREATE", this.onMessageCreate);

        },

    

        stop() {

            // Perform complete cleanup: remove all patches and event subscriptions.

            // Patcher.unpatchAll("FileSplitter");

            Dispatcher.unsubscribe("MESSAGE_CREATE", this.onMessageCreate);

            if (this.chunkCleanupInterval) {

                clearInterval(this.chunkCleanupInterval);

            }

        }

    });
