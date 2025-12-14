import { RestAPI, Constants, Toasts, showToast } from "@webpack/common";
import { calculateChecksum, ChunkManager, DetectedFileSession, StoredFileChunk, isValidChunk } from "./ChunkManager";
import { settings } from "./settings";
import { showNotification } from "@api/Notifications";

export interface DownloadState {
    sessionId: number;
    status: 'pending' | 'downloading' | 'merging' | 'paused' | 'completed' | 'error';
    
    // Progress
    chunksDownloaded: Set<number>;
    bytesDownloaded: number;
    totalBytes: number;
    
    // Stats
    startTime: number;
    speed: number;
    etr: number;
    
    // Result
    fileBlob?: Blob;
    checksumResult?: 'pass' | 'fail' | 'skipped';
    error?: string;
    
    // Control
    controller: AbortController;
    isPaused: boolean;
}

type Listener = () => void;

export class DownloadManager {
    static downloads = new Map<number, DownloadState>();
    private static listeners = new Set<Listener>();

    static addListener(listener: Listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    static emitChange() {
        this.listeners.forEach(l => l());
    }

    static startDownload(sessionId: number) {
        const session = ChunkManager.getSession(sessionId);
        if (!session) {
            showToast("Session expired or not found", Toasts.Type.FAILURE);
            return;
        }
        
        if (!session.isComplete) {
            showToast(`Cannot download: Missing chunks (${session.chunks.length}/${session.totalChunks})`, Toasts.Type.FAILURE);
            return;
        }

        let download = this.downloads.get(sessionId);
        if (download && download.status === 'downloading') return;

        if (!download) {
            download = {
                sessionId,
                status: 'pending',
                chunksDownloaded: new Set(),
                bytesDownloaded: 0,
                totalBytes: session.size,
                startTime: 0,
                speed: 0,
                etr: 0,
                controller: new AbortController(),
                isPaused: false
            };
            this.downloads.set(sessionId, download);
        }

        download.isPaused = false;
        download.status = 'downloading';
        download.controller = new AbortController(); // Reset controller
        this.emitChange();
        
        this.processDownload(download, session);
    }

    static pauseDownload(sessionId: number) {
        const dl = this.downloads.get(sessionId);
        if (dl) {
            dl.isPaused = true;
            dl.status = 'paused';
            dl.controller.abort();
            this.emitChange();
        }
    }

    static cancelDownload(sessionId: number) {
        this.pauseDownload(sessionId);
        this.downloads.delete(sessionId);
        this.emitChange();
    }

    // Trigger the actual browser download for a completed file
    static saveFileToDisk(sessionId: number) {
        const dl = this.downloads.get(sessionId);
        const session = ChunkManager.getSession(sessionId);
        if (!dl || !dl.fileBlob || !session) return;

        const url = URL.createObjectURL(dl.fileBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = session.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    private static async processDownload(dl: DownloadState, session: DetectedFileSession) {
        dl.startTime = Date.now();
        
        // Sort chunks to ensure order (though we download in parallel or sequence, order matters for merge)
        // We will download in sequence to track speed easily.
        const sortedChunks = [...session.chunks].sort((a, b) => a.index - b.index);

        try {
            const blobParts: Blob[] = new Array(sortedChunks.length);

            // If we are resuming, we might have some blobs in memory? 
            // Complexity: Storing partial blobs in memory for resume is heavy on RAM.
            // For simplicity in this version, "Resume" will re-download missing chunks 
            // but we won't keep the actual Blobs of *paused* downloads in RAM indefinitely if we can help it.
            // Actually, if we pause, we KEEP the blobs in memory in `blobParts`? 
            // We can't easily persist blobs across reloads.
            // Let's assume standard behavior: We keep downloaded chunks in memory while the app is open.
            
            // Wait, `blobParts` is local to this function. If we pause and exit function, we lose data.
            // We need to store `blobParts` in `DownloadState` if we want true resume without re-download.
            // For now, let's implement "Pause" as "Stop fetching new chunks".
            // To support resume, we need a cache. 
            // I'll stick to a simpler model: Re-download everything if paused? No, that's annoying.
            // I will add `downloadedBlobs` to `DownloadState`.
            
            // NOTE: Implementing true resume requires storing blobs. 
            // I will add `downloadedBlobs: Map<number, Blob>` to DownloadState.
        } catch (e: any) {
            // ...
        }
        
        // RE-IMPLEMENTATION WITH BLOB STORAGE
        await this.downloadLoop(dl, session);
    }

    private static async downloadLoop(dl: DownloadState, session: DetectedFileSession) {
        // Initialize storage if needed
        const state = dl as any; 
        if (!state.blobs) state.blobs = new Map<number, Blob>();

        const pendingChunks = [...session.chunks]
            .sort((a, b) => a.index - b.index)
            .filter(c => !state.blobs.has(c.index)); // Only queue missing chunks

        const parallel = settings.store.parallelDownloading ?? true;
        const concurrency = parallel ? (settings.store.downloadWorkers || 3) : 1;

        let activeCount = 0;
        let index = 0;

        const processChunk = async (chunk: StoredFileChunk) => {
            if (dl.isPaused || dl.controller.signal.aborted) return;

            const fetcher = (window as any).VencordNative?.net?.fetch;
            if (!fetcher) throw new Error("VencordNative fetch missing");

            // console.log(`[DownloadManager] Fetching chunk ${chunk.index}...`);
            const arrayBuffer = await fetcher(chunk.url);
            if (!arrayBuffer) throw new Error(`Fetch failed for chunk ${chunk.index}`);
            
            const blob = new Blob([arrayBuffer]);
            state.blobs.set(chunk.index, blob);
            dl.chunksDownloaded.add(chunk.index);
            
            // Update Stats
            dl.bytesDownloaded += blob.size;
            const now = Date.now();
            const elapsed = (now - dl.startTime) / 1000;
            if (elapsed > 0) {
                dl.speed = dl.bytesDownloaded / elapsed;
                dl.etr = (dl.totalBytes - dl.bytesDownloaded) / dl.speed;
            }
            this.emitChange();
        };

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        try {
            while (index < pendingChunks.length || activeCount > 0) {
                if (dl.isPaused || dl.controller.signal.aborted) {
                    dl.status = 'paused';
                    this.emitChange();
                    return;
                }

                // Start new tasks
                while (activeCount < concurrency && index < pendingChunks.length && !dl.isPaused) {
                    const chunk = pendingChunks[index++];
                    activeCount++;
                    
                    processChunk(chunk).then(() => {
                        activeCount--;
                    }).catch(e => {
                        activeCount--;
                        if (!dl.controller.signal.aborted) {
                            console.error(`Chunk ${chunk.index} failed`, e);
                            dl.error = `Chunk ${chunk.index} failed`;
                            // Ideally retries? For now fail or continue? 
                            // Let's just continue, it will remain in pending for next retry?
                            // No, we filtered pending at start.
                            // Simple retry logic:
                            dl.controller.abort(); 
                        }
                    });
                }

                if (activeCount > 0) await sleep(50);
                else if (index >= pendingChunks.length) break;
            }

            if (dl.controller.signal.aborted) return;

            // Merge
            dl.status = 'merging';
            this.emitChange();

            // Check if we actually have all chunks
            if (state.blobs.size !== session.totalChunks) {
                throw new Error(`Download incomplete: ${state.blobs.size}/${session.totalChunks}`);
            }

            const orderedBlobs: Blob[] = [];
            for (let i = 0; i < session.totalChunks; i++) {
                orderedBlobs.push(state.blobs.get(i));
            }
            
            const finalBlob = new Blob(orderedBlobs);
            dl.fileBlob = finalBlob; // Store ready for save

            // Checksum
            if (session.chunks[0].checksum) { 
                const calculated = await calculateChecksum(finalBlob);
                if (calculated === session.chunks[0].checksum) {
                    dl.checksumResult = 'pass';
                } else {
                    dl.checksumResult = 'fail';
                }
            } else {
                dl.checksumResult = 'skipped';
            }

            dl.status = 'completed';
            this.emitChange();
            showToast(`Download ready: ${session.name}`, Toasts.Type.SUCCESS);

        } catch (e: any) {
            if (dl.controller.signal.aborted) return;
            console.error("Download error", e);
            dl.status = 'error';
            dl.error = e.message;
            this.emitChange();
        }
    }

    // --- SCANNER ---
    static async scanChannel(channelId: string, limit: number) {
        showToast(`Scanning last ${limit} messages...`, Toasts.Type.INFO);
        let fetched = 0;
        let beforeId: string | undefined = undefined;

        try {
            while (fetched < limit) {
                const batchSize = Math.min(50, limit - fetched);
                const response: any = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query: { limit: batchSize, before: beforeId }
                });

                // Vencord RestAPI might return the array directly or in .body depending on version/config
                const messages = Array.isArray(response) ? response : response.body;

                if (!Array.isArray(messages)) {
                    console.error("[FileSplitter] Scan received non-array:", response);
                    break;
                }

                if (messages.length === 0) break;

                messages.forEach((msg: any) => {
                    // Manual parsing because onMessageCreate isn't triggered for REST fetch
                    if (msg.content && msg.attachments?.length) {
                        try {
                            const data = JSON.parse(msg.content);
                            if (isValidChunk(data)) {
                                ChunkManager.addChunk({
                                    ...data,
                                    url: msg.attachments[0].url,
                                    proxyUrl: msg.attachments[0].proxy_url
                                }, msg.channel_id, msg.author);
                            }
                        } catch {}
                    }
                    beforeId = msg.id;
                });

                fetched += messages.length;
                // Tiny delay to be nice to API
                await new Promise(r => setTimeout(r, 200));
            }
            showToast(`Scan complete. Found ${ChunkManager.getSessions(channelId).length} files.`, Toasts.Type.SUCCESS);
        } catch (e) {
            console.error("Scan failed", e);
            showToast("Scan failed", Toasts.Type.FAILURE);
        }
    }
}
