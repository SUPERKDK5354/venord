import definePlugin from "@utils/types";
import { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import * as webpack from "@webpack";
// Patcher is not available in Vencord API
// import { Patcher } from "@utils/webpack";
import { FluxDispatcher as Dispatcher, SelectedChannelStore as ChannelStore, MessageActions, RestAPI, Constants, SnowflakeUtils, Toasts, showToast, Menu, ContextMenuApi } from "@webpack/common";
import { useCallback, useState, useEffect } from "@webpack/common";
import { ChatBarButton } from "@api/ChatButtons";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
// import { NsUI } from "@utils/types"; // Vencord standard type import

// Optimized chunk size. Set to 9.5MB to be safe for 10MB upload limits.
// const CHUNK_SIZE = 9.5 * 1024 * 1024; // Now dynamic
const CHUNK_TIMEOUT = 5 * 60 * 1000; // 5-minute cache expiration for incomplete files.

const CloudUpload = webpack.findLazy(m => m.prototype?.trackUploadFinished);
const ButtonClasses = webpack.findByPropsLazy("lookFilled", "colorBrand", "sizeSmall");

const settings = definePluginSettings({
    bypassLimit: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Allow uploading files larger than 500MB (Bypasses Discord limit via splitting)",
    },
    chunkSize: {
        type: OptionType.NUMBER,
        default: 9.5,
        description: "Chunk Size (MB)",
    }
});

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
    [key: string]: { // Keyed by originalName
        chunks: StoredFileChunk[];
        lastUpdated: number;
    };
}

// --- Webpack Module Resolution ---
// Locating necessary Discord internal modules.

// const FileUploadStore = webpack.findByPropsLazy("upload", "instantBatchUpload");
// Module required for injecting the custom UI component.
// const ChannelTextArea = webpack.find(m => m.type?.displayName === "ChannelTextArea");

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
        const key = chunk.originalName;
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
     * Retrieves all stored chunks for a given file name.
     * @param fileName The original name of the file.
     * @returns An array of stored chunks or null if none found.
     */
    static getChunks(fileName: string): StoredFileChunk[] | null {
        return this.storage[fileName]?.chunks || null;
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
                console.log(`[FileSplitter] Garbage collected stale chunks for: ${key}`);
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

            const chunks = ChunkManager.getChunks(chunkData.originalName);

            

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

            const chunks = ChunkManager.getChunks(chunkData.originalName);

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

const SplitFileComponent = () => {
    const [status, setStatus] = useState("");
    const [isUploading, setIsUploading] = useState(false);
    const [progress, setProgress] = useState(0);

    /**
     * Handles the core logic of splitting a file and uploading it in chunks.
     * @param file The file selected by the user.
     */
    const handleFileSplit = useCallback(async (file: File) => {
        try {
            console.log("[FileSplitter] Starting split upload for:", file.name);
            setIsUploading(true);
            
            const sizeMB = settings.store.chunkSize || 9.5;
            const CHUNK_SIZE = sizeMB * 1024 * 1024;
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

            if (!CloudUpload) {
                 throw new Error("CloudUpload module not found!");
            }

            // Capture channel ID at start to prevent sending to wrong channel on switch
            const channelId = ChannelStore.getChannelId();

            for (let i = 0; i < totalChunks; i++) {
                console.log(`[FileSplitter] Processing chunk ${i + 1}/${totalChunks}`);
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);

                const chunkBlob = file.slice(start, end);
                
                // Sanitize filename to prevent upload errors with special chars
                const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
                const chunkFile = new File(
                    [chunkBlob],
                    `${safeName}.part${String(i + 1).padStart(3, '0')}`,
                    { type: '' }
                );

                const metadata: FileChunkMetadata = {
                    type: "FileSplitterChunk",
                    index: i,
                    total: totalChunks,
                    originalName: file.name, // Keep original name in metadata for display/merge? 
                    // Actually, if we rename the chunks, we should probably keep originalName for the final file.
                    // But we need to ensure we can look it up. ChunkManager keys by originalName.
                    originalSize: file.size,
                    timestamp: Date.now()
                };

                // Upload logic using CloudUpload
                await new Promise<void>((resolve, reject) => {
                    const upload = new CloudUpload({
                        file: chunkFile,
                        isClip: false,
                        isThumbnail: false,
                        platform: CloudUploadPlatform.WEB // Use enum
                    }, channelId, false, 0);

                    upload.on("complete", () => {
                        console.log(`[FileSplitter] Chunk ${i + 1} uploaded to cloud. Sending message...`);
                        
                        if (!upload.uploadedFilename) {
                             reject(new Error("Upload complete but no uploadedFilename found"));
                             return;
                        }

                        RestAPI.post({ // Use RestAPI.post
                            url: Constants.Endpoints.MESSAGES(channelId),
                            body: {
                                content: JSON.stringify(metadata),
                                flags: 0, 
                                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                                sticker_ids: [],
                                type: 0,
                                attachments: [{
                                    id: "0",
                                    filename: chunkFile.name, // Use local variable
                                    uploaded_filename: upload.uploadedFilename,
                                    file_size: chunkFile.size // Use local variable
                                }]
                            }
                        }).then(() => resolve()).catch(reject);
                    });

                    upload.on("error", (error: any) => {
                        console.error("[FileSplitter] Cloud upload internal error:", error);
                        showToast(`Chunk ${i + 1} upload failed! See console for details.`, Toasts.Type.FAILURE);
                        reject(new Error(`Cloud upload failed for chunk ${i + 1}: ${error?.message || error}`));
                    });
                    upload.upload();
                });

                setProgress(Math.round(((i + 1) / totalChunks) * 100));
                // Add delay to prevent rate limits
                await delay(5000); 
            }

            console.log("[FileSplitter] Upload complete.");
            setStatus(`Successfully uploaded ${totalChunks} parts for ${file.name}`);
        } catch (error: any) {
            console.error("[FileSplitter] Upload failed:", error);
            setStatus(`Error: ${error.message}`);
        } finally {
            setIsUploading(false);
            setProgress(0);
        }
    }, []);

    /**
     * Handler for the file input change event.
     * @param e The React change event from the file input.
     */
    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        console.log("[FileSplitter] File selected:", file);
        if (!file) return;

        // Pre-flight check: Enforce Discord's absolute 500MB (Nitro) file size limit.
        if (file.size > 500 * 1024 * 1024 && !settings.store.bypassLimit) {
             console.log("[FileSplitter] File too large (>500MB)");
             setStatus("File > 500MB. Right click to enable bypass.");
             return;
        }

        // Only split if the file is larger than our defined CHUNK_SIZE.
        if (file.size > CHUNK_SIZE) {
            console.log(`[FileSplitter] Splitting ${file.name} into ~${Math.ceil(file.size / CHUNK_SIZE)} chunks...`);
            setStatus(`Splitting ${file.name} into ~${Math.ceil(file.size / CHUNK_SIZE)} chunks...`);
            await handleFileSplit(file);
        } else {
            console.log("[FileSplitter] File small enough, no split needed.");
            setStatus("File is small enough to be sent directly.");
        }

        // Reset the file input to allow re-selection of the same file.
        e.target.value = "";
    }, [handleFileSplit]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(e, () => <FileSplitterContextMenu />);
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
                tooltip={isUploading ? `Uploading... ${progress}%` : "Upload Large File"}
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

    

                                        const chunks = ChunkManager.getChunks(chunkData.originalName);

    

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
