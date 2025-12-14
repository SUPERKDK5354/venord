import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import * as webpack from "@webpack";
import { RestAPI, Constants, SnowflakeUtils, Toasts, showToast, SelectedChannelStore as ChannelStore } from "@webpack/common";
import { settings } from "./settings";

const CloudUpload = webpack.findLazy(m => m.prototype?.trackUploadFinished);

export interface UploadSession {
    id: number;
    file?: File; // Optional because it might be missing after reload
    name: string;
    size: number;
    status: 'pending' | 'uploading' | 'paused' | 'completed' | 'error';
    chunkSize: number;
    channelId: string;
    totalChunks: number;
    completedIndices: Set<number>;
    startTime: number;
    bytesUploaded: number;
    speed: number;
    etr: number;
    error?: string;
    controller: AbortController;
    isPaused: boolean;
}

type Listener = () => void;

export class UploadManager {
    static sessions = new Map<number, UploadSession>();
    private static listeners = new Set<Listener>();

    static addListener(listener: Listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    static emitChange() {
        this.listeners.forEach(l => l());
        this.saveState();
    }

    // Call this from the plugin 'start()' method
    static init() {
        this.loadState();
    }

    private static loadState() {
        try {
            const raw = settings.store.pendingUploads || "{}";
            const data = JSON.parse(raw);
            Object.values(data).forEach((s: any) => {
                // Restore session without File object
                this.sessions.set(s.id, {
                    ...s,
                    status: 'paused',
                    completedIndices: new Set(s.completedIndices),
                    controller: new AbortController(),
                    isPaused: true
                });
            });
        } catch (e) {
            console.error("[UploadManager] Failed to load state:", e);
        }
    }

    private static saveState() {
        const toSave: Record<string, any> = {};
        this.sessions.forEach((s) => {
            if (s.status !== 'completed' && s.status !== 'error') {
                const { file, controller, completedIndices, ...rest } = s;
                toSave[s.id] = {
                    ...rest,
                    completedIndices: Array.from(completedIndices)
                };
            }
        });
        settings.store.pendingUploads = JSON.stringify(toSave);
    }

    static async startUpload(file: File, chunkSizeMB: number) {
        if (!CloudUpload) {
            showToast("CloudUpload module not found!", Toasts.Type.FAILURE);
            return;
        }

        const chunkSize = Math.round(chunkSizeMB * 1024 * 1024);
        const totalChunks = Math.ceil(file.size / chunkSize);
        const id = Date.now();

        const session: UploadSession = {
            id,
            file,
            name: file.name,
            size: file.size,
            status: 'pending',
            chunkSize,
            channelId: ChannelStore.getChannelId(),
            totalChunks,
            completedIndices: new Set(),
            startTime: 0,
            bytesUploaded: 0,
            speed: 0,
            etr: 0,
            controller: new AbortController(),
            isPaused: false
        };

        this.sessions.set(id, session);
        this.emitChange();
        
        this.processUpload(session);
    }

    static async resumeUpload(id: number, file?: File) {
        const session = this.sessions.get(id);
        if (!session) return;

        // If we don't have the file object (e.g. after reload), we need it passed in
        if (!session.file) {
            if (file) {
                // Verify file matches
                if (file.name !== session.name || file.size !== session.size) {
                    showToast("File mismatch! Select the original file.", Toasts.Type.FAILURE);
                    return;
                }
                session.file = file;
            } else {
                // We need to ask for the file. 
                // The UI should handle asking the user to pick the file, then call this method with it.
                showToast("Missing file object. Please select the file again.", Toasts.Type.FAILURE);
                return;
            }
        }

        if (session.status === 'uploading') return;

        session.isPaused = false;
        session.status = 'pending';
        this.emitChange();
        this.processUpload(session);
    }

    static pauseUpload(id: number) {
        const session = this.sessions.get(id);
        if (session) {
            session.isPaused = true;
            session.status = 'paused';
            this.emitChange();
        }
    }

    static deleteUpload(id: number) {
        const session = this.sessions.get(id);
        if (session) {
            session.isPaused = true;
            this.sessions.delete(id);
            this.emitChange();
        }
    }

    private static async processUpload(session: UploadSession) {
        if (!session.file) return;

        session.status = 'uploading';
        session.startTime = Date.now();
        // Recalculate bytes uploaded so far
        session.bytesUploaded = session.completedIndices.size * session.chunkSize;
        this.emitChange();

        console.log(`[UploadManager] Starting upload for ${session.name} (ID: ${session.id})`);

        try {
            for (let i = 0; i < session.totalChunks; i++) {
                if (session.isPaused) {
                    session.status = 'paused';
                    this.emitChange();
                    return;
                }

                if (session.completedIndices.has(i)) continue;

                // Upload Chunk
                const start = i * session.chunkSize;
                const end = Math.min(start + session.chunkSize, session.size);
                const chunkBlob = session.file.slice(start, end);
                const chunkFile = new File([chunkBlob], `${session.name.replace(/[^a-zA-Z0-9.-]/g, "_")}.part${String(i + 1).padStart(3, '0')}`);

                const metadata = {
                    type: "FileSplitterChunk",
                    index: i,
                    total: session.totalChunks,
                    originalName: session.name,
                    originalSize: session.size,
                    timestamp: session.id
                };

                await this.uploadChunk(chunkFile, metadata, session.channelId);

                // Update Progress & Stats
                session.completedIndices.add(i);
                
                const now = Date.now();
                const elapsed = (now - session.startTime) / 1000;
                session.bytesUploaded += chunkFile.size;
                
                if (elapsed > 0) {
                    session.speed = session.bytesUploaded / elapsed; // B/s
                    const remainingBytes = session.size - session.bytesUploaded;
                    session.etr = remainingBytes / session.speed;
                }

                this.emitChange();
                
                // Rate limit delay
                await new Promise(r => setTimeout(r, 1000));
            }

            session.status = 'completed';
            this.emitChange();
            showToast(`Upload complete: ${session.name}`, Toasts.Type.SUCCESS);
            // Auto-delete from list after a while? Or keep it?
            // Keep for now.

        } catch (e: any) {
            console.error("Upload failed", e);
            session.status = 'error';
            session.error = e.message;
            this.emitChange();
        }
    }

    private static uploadChunk(file: File, metadata: any, channelId: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const upload = new CloudUpload({
                file,
                isClip: false,
                isThumbnail: false,
                platform: CloudUploadPlatform.WEB
            }, channelId, false, 0);

            upload.on("complete", () => {
                if (!upload.uploadedFilename) return reject(new Error("No uploadedFilename"));
                
                RestAPI.post({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    body: {
                        content: JSON.stringify(metadata),
                        flags: 0,
                        nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                        type: 0,
                        attachments: [{
                            id: "0",
                            filename: file.name,
                            uploaded_filename: upload.uploadedFilename,
                            file_size: file.size
                        }]
                    }
                }).then(() => resolve()).catch(reject);
            });

            upload.on("error", (err: any) => reject(err));
            upload.upload();
        });
    }
}