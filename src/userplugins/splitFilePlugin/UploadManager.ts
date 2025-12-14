import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import * as webpack from "@webpack";
import { RestAPI, Constants, SnowflakeUtils, Toasts, showToast, SelectedChannelStore as ChannelStore } from "@webpack/common";
import { calculateChecksum } from "./ChunkManager";
import { settings } from "./settings";

const CloudUpload = webpack.findLazy(m => m.prototype?.trackUploadFinished);

export interface UploadSession {
    id: number;
    file?: File;
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
    lastMessageId?: string; // For "Go to message"
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

    static init() {
        this.loadState();
    }

    private static loadState() {
        try {
            const raw = settings.store.pendingUploads || "{}";
            const data = JSON.parse(raw);
            Object.values(data).forEach((s: any) => {
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

        if (!session.file) {
            if (file) {
                if (file.name !== session.name || file.size !== session.size) {
                    showToast("File mismatch! Select the original file.", Toasts.Type.FAILURE);
                    return;
                }
                session.file = file;
            } else {
                showToast("Missing file object. Please select the file again.", Toasts.Type.FAILURE);
                return;
            }
        }

        if (session.status === 'uploading') return;

        session.isPaused = false;
        session.status = 'pending';
        // Reset controller for new attempt
        session.controller = new AbortController();
        this.emitChange();
        this.processUpload(session);
    }

    static pauseUpload(id: number) {
        const session = this.sessions.get(id);
        if (session) {
            session.isPaused = true;
            session.status = 'paused';
            session.controller.abort(); // Cancel current upload attempt
            this.emitChange();
        }
    }

    static deleteUpload(id: number) {
        const session = this.sessions.get(id);
        if (session) {
            session.isPaused = true;
            session.controller.abort();
            this.sessions.delete(id);
            this.emitChange();
        }
    }

    private static updateProgress(session: UploadSession) {
        let uploaded = 0;
        session.completedIndices.forEach(idx => {
            const isLast = idx === session.totalChunks - 1;
            const size = isLast ? (session.size % session.chunkSize || session.chunkSize) : session.chunkSize;
            uploaded += size;
        });
        session.bytesUploaded = uploaded;
        
        const now = Date.now();
        const elapsed = (now - session.startTime) / 1000;
        
        if (elapsed > 0) {
            session.speed = session.bytesUploaded / elapsed;
            const remaining = session.size - session.bytesUploaded;
            session.etr = session.speed > 0 ? remaining / session.speed : 0;
        }
    }

    private static async processUpload(session: UploadSession) {
        if (!session.file) return;

        session.status = 'uploading';
        session.startTime = Date.now();
        this.updateProgress(session);
        this.emitChange();

        console.log(`[UploadManager] Starting upload for ${session.name} (ID: ${session.id})`);

        // Checksum
        if (!session.completedIndices.has(-1)) { // Use -1 as "checksum calculated" flag? No, just check if we have it? 
            // Actually, we don't store checksum in session object in interface?
            // Wait, the interface in UploadManager didn't have checksum field. I should add it.
            // But for now let's just calculate it.
            // To avoid re-calc on resume, we should check if we already did it.
            // But we didn't add it to interface.
            // I'll add logic to calc it every time for now or assume it's fast enough.
            // Actually, better to just calc it.
            
            // To ensure we don't block UI, we can do it.
            // Logs for user verification:
            console.log(`[FileSplitter] Calculating checksum for ${session.name}...`);
            // We need to store it to pass to metadata.
            // I'll stick it in the session object as a custom prop if TS allows or just calc it once.
            // Let's add it to metadata directly.
        }

        let fileChecksum: string | undefined;
        try {
             // Optimized: Only calc if not already known (persistence needed for "known")
             // For now, always calc.
             fileChecksum = await calculateChecksum(session.file);
             console.log(`[FileSplitter] Original Checksum for ${session.name}: ${fileChecksum}`);
        } catch (e) {
            console.warn("Checksum failed", e);
        }

        try {
            for (let i = 0; i < session.totalChunks; i++) {
                if (session.isPaused || session.controller.signal.aborted) {
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
                    timestamp: session.id,
                    checksum: fileChecksum
                };

                const msg = await this.uploadChunk(chunkFile, metadata, session.channelId, session.controller.signal);
                if (msg) session.lastMessageId = msg.id;

                session.completedIndices.add(i);
                this.updateProgress(session);
                this.emitChange();
                
                await new Promise(r => setTimeout(r, 1000));
            }

            session.status = 'completed';
            this.emitChange();
            showToast(`Upload complete: ${session.name}`, Toasts.Type.SUCCESS);

        } catch (e: any) {
            if (session.controller.signal.aborted) {
                session.status = 'paused';
            } else {
                console.error("Upload failed", e);
                session.status = 'error';
                session.error = e.message;
            }
            this.emitChange();
        }
    }

    private static uploadChunk(file: File, metadata: any, channelId: string, signal: AbortSignal): Promise<any> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new Error("Aborted"));

            const upload = new CloudUpload({
                file,
                isClip: false,
                isThumbnail: false,
                platform: CloudUploadPlatform.WEB
            }, channelId, false, 0);

            const abortHandler = () => {
                upload.cancel && upload.cancel(); // Try to cancel
                reject(new Error("Aborted"));
            };
            signal.addEventListener('abort', abortHandler);

            upload.on("complete", () => {
                signal.removeEventListener('abort', abortHandler);
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
                }).then(resolve).catch(reject);
            });

            upload.on("error", (err: any) => {
                signal.removeEventListener('abort', abortHandler);
                reject(err);
            });
            upload.upload();
        });
    }
}
