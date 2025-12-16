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

    static async resurrectSession(file: File, existingChunks: number[], totalChunks: number, channelId: string, originalId: number) {
        // Check if session already exists
        if (this.sessions.has(originalId)) {
            // If it exists, just resume it
            this.resumeUpload(originalId, file);
            return;
        }

        // Infer chunk size from file size and total chunks
        // If totalChunks > 1, assume standard splitting.
        // We can try to match the setting or calculate.
        // `Math.ceil(size / chunkSize) === totalChunks`
        // It's safer to use the default setting or try to calculate, but we need exact chunk size.
        // However, `processUpload` recalculates bounds based on `chunkSize`.
        // If we get it wrong, we upload bad chunks.
        // Ideally we pass `chunkSize` from DownloadManager (which deduced it).
        // I will add `chunkSize` param.
        
        // Actually, let's recalculate it or default to settings?
        // Risky if settings changed.
        // Let's assume 9.5MB if not provided? 
        // No, `resurrectSession` will be called from `DownloadManager` which calculated it.
        // I will add `chunkSize` to arguments.
    }

    static async resurrectSessionWithParams(file: File, existingChunks: number[], totalChunks: number, chunkSize: number, channelId: string, originalId: number) {
        const id = originalId || Date.now();
        
        const session: UploadSession = {
            id,
            file,
            name: file.name,
            size: file.size,
            status: 'pending',
            chunkSize,
            channelId,
            totalChunks,
            completedIndices: new Set(existingChunks),
            startTime: 0,
            bytesUploaded: 0,
            speed: 0,
            etr: 0,
            controller: new AbortController(),
            isPaused: false
        };

        // Recalculate bytes already uploaded for progress bar
        let uploaded = 0;
        session.completedIndices.forEach(idx => {
            const isLast = idx === session.totalChunks - 1;
            const size = isLast ? (session.size % session.chunkSize || session.chunkSize) : session.chunkSize;
            uploaded += size;
        });
        session.bytesUploaded = uploaded;

        this.sessions.set(id, session);
        this.emitChange();
        
        console.log(`[UploadManager] Resurrected session ${id} with ${existingChunks.length}/${totalChunks} chunks.`);
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

        let fileChecksum: string | undefined;
        try {
             fileChecksum = await calculateChecksum(session.file);
             console.log(`[FileSplitter] Original Checksum for ${session.name}: ${fileChecksum}`);
        } catch (e) {
            console.warn("Checksum failed", e);
        }

        try {
            const pendingIndices = [];
            for (let i = 0; i < session.totalChunks; i++) {
                if (!session.completedIndices.has(i)) pendingIndices.push(i);
            }

            const parallel = settings.store.parallelUploads;
            const concurrency = parallel ? (settings.store.parallelCount || 2) : 1;
            
            // Queue system
            let activeCount = 0;
            let index = 0;
            let consecutiveErrors = 0;

            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

            const processChunk = async (i: number) => {
                const start = i * session.chunkSize;
                const end = Math.min(start + session.chunkSize, session.size);
                const chunkBlob = session.file!.slice(start, end);
                const chunkFile = new File([chunkBlob], `${session.name.replace(/[^a-zA-Z0-9.-]/g, "_")}.part${String(i + 1).padStart(3, '0')}`);

                let chunkChecksum: string | undefined;
                try {
                    const buffer = await chunkBlob.arrayBuffer();
                    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                    chunkChecksum = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
                } catch (e) {
                    console.warn(`Failed to calc chunk checksum for ${i}`, e);
                }

                const metadata = {
                    type: "FileSplitterChunk",
                    index: i,
                    total: session.totalChunks,
                    originalName: session.name,
                    originalSize: session.size,
                    timestamp: session.id,
                    checksum: fileChecksum,
                    chunkChecksum: chunkChecksum
                };

                const msg = await this.uploadChunk(chunkFile, metadata, session.channelId, session.controller.signal);
                if (msg) session.lastMessageId = msg.id;

                session.completedIndices.add(i);
                this.updateProgress(session);
                this.emitChange();
            };

            while (index < pendingIndices.length || activeCount > 0) {
                // Dynamic Settings Read
                const parallel = settings.store.parallelUploads;
                const concurrency = parallel ? (settings.store.parallelCount || 2) : 1;

                if (session.isPaused || session.controller.signal.aborted) {
                    session.status = 'paused';
                    this.emitChange();
                    return;
                }

                while (activeCount < concurrency && index < pendingIndices.length && !session.isPaused) {
                    const idx = pendingIndices[index]; // Read first
                    activeCount++;
                    index++;
                    
                    processChunk(idx).then(() => {
                        activeCount--;
                    }).catch(e => {
                        activeCount--;
                        console.error(`Chunk ${idx} failed`, e);
                        
                        // Safe Mode / Anti-Logout Logic
                        const isRateLimit = e?.message?.includes("429") || e?.status === 429;
                        if (settings.store.safeMode && isRateLimit) {
                            console.warn("[UploadManager] Rate limit hit! Entering Safe Mode cooldown.");
                            session.isPaused = true;
                            session.status = 'paused';
                            showToast(`Rate limit hit. Pausing for ${settings.store.safeModeCooldown || 60}s`, Toasts.Type.WARNING);
                            this.emitChange();
                            
                            setTimeout(() => {
                                if (session.status === 'paused') {
                                    console.log("Resuming from Safe Mode...");
                                }
                            }, (settings.store.safeModeCooldown || 60) * 1000);
                            return;
                        }

                        if (!session.controller.signal.aborted) {
                            session.controller.abort();
                            session.error = e.message;
                            session.status = 'error';
                            this.emitChange();
                        }
                    });

                    const base = settings.store.baseDelay || 1500;
                    const jitter = settings.store.jitter || 1000;
                    const delay = base + Math.random() * jitter;
                    await sleep(delay);
                }

                if (activeCount > 0) await sleep(100);
                else if (index >= pendingIndices.length) break;
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

    public static uploadChunk(file: File, metadata: any, channelId: string, signal: AbortSignal): Promise<any> {
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
