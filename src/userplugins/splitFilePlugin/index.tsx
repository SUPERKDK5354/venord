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

import { ChunkManager, handleFileMerge, isValidChunk, StoredFileChunk } from "./ChunkManager";
import { settings } from "./settings";

const ButtonClasses = webpack.findByPropsLazy("lookFilled", "colorBrand", "sizeSmall");

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

            const session = ChunkManager.getSession(chunkData.timestamp);
            const chunks = session?.chunks;

            

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
                }, message.channel_id, message.author);
            }

            const session = ChunkManager.getSession(chunkData.timestamp);
            const chunks = session?.chunks;

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
import { DownloadManager } from "./DownloadManager";

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
                <Menu.MenuItem 
                    id="file-splitter-settings" 
                    label="File Splitter Settings" 
                    action={() => openModal(props => <UploadsDashboard initialTab="SETTINGS" {...props} />)} 
                />
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

    commands: [
        {
            name: "scanfiles",
            description: "Scan the current channel for split file chunks to populate the download manager.",
            options: [
                {
                    name: "limit",
                    description: "Number of messages to scan (default 100)",
                    type: 4, // Integer
                    required: false
                }
            ],
            execute(args, ctx) {
                const limit = args[0]?.value || 100;
                const channelId = ctx.channel.id;
                DownloadManager.scanChannel(channelId, Number(limit));
            }
        }
    ],

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
                                        proxyUrl: attachment.proxy_url,
                                        messageId: message.id
                                    };

                                    ChunkManager.addChunk(storedChunk, message.channel_id, message.author);

                                        // Check if all chunks have been received.
                                        const session = ChunkManager.getSession(chunkData.timestamp);
                                        const count = session ? session.chunks.length : 0;
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

        onMessageDelete({ id }: { id: string }) {
            ChunkManager.removeChunk(id);
        },

        start() {
            UploadManager.init();

            // Initiate periodic garbage collection for expired chunk data.
            this.chunkCleanupInterval = setInterval(() => {
                ChunkManager.cleanOldChunks();
            }, 60000); // Run every 60 seconds.

            // 1. Subscribe to the 'MESSAGE_CREATE' event to intercept incoming messages.
            Dispatcher.subscribe("MESSAGE_CREATE", this.onMessageCreate);
            Dispatcher.subscribe("MESSAGE_DELETE", this.onMessageDelete);
        },

        stop() {
            // Perform complete cleanup: remove all patches and event subscriptions.
            // Patcher.unpatchAll("FileSplitter");
            Dispatcher.unsubscribe("MESSAGE_CREATE", this.onMessageCreate);
            Dispatcher.unsubscribe("MESSAGE_DELETE", this.onMessageDelete);

            if (this.chunkCleanupInterval) {
                clearInterval(this.chunkCleanupInterval);
            }
        }
    });
