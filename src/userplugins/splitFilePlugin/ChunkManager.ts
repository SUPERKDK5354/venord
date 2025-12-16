import { Toasts, showToast } from "@webpack/common";

const CHUNK_TIMEOUT = 15 * 60 * 1000; // Increased timeout to 15 mins for better scanning/history retention

export interface FileChunkMetadata {
    type: "FileSplitterChunk";
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
    checksum?: string;
    chunkChecksum?: string;
}

export interface StoredFileChunk extends FileChunkMetadata {
    url: string;
    proxyUrl?: string;
    messageId?: string;
}

// Info about the user who uploaded the file
export interface UploaderInfo {
    id: string;
    username: string;
    avatar?: string;
    discriminator?: string;
}

// Represents a complete or partial file detected in chat
export interface DetectedFileSession {
    id: number; // timestamp
    name: string;
    size: number;
    totalChunks: number;
    channelId: string;
    uploader: UploaderInfo;
    chunks: StoredFileChunk[]; // The chunks we have found so far
    lastUpdated: number;
    isComplete: boolean; // Do we have all chunks?
}

interface ChunkStorage {
    [sessionId: string]: DetectedFileSession;
}

export const calculateChecksum = async (file: File | Blob): Promise<string> => {
    try {
        const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB slices for hashing
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const hashes: string[] = [];

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const slice = file.slice(start, end);
            const buffer = await slice.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            hashes.push(hashArray.map(b => b.toString(16).padStart(2, '0')).join(''));
        }
        
        // Final hash of the hashes
        const combined = new TextEncoder().encode(hashes.join(''));
        const finalBuffer = await crypto.subtle.digest('SHA-256', combined);
        return Array.from(new Uint8Array(finalBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.error("[FileSplitter] Checksum calculation failed:", e);
        return "error";
    }
};

export class ChunkManager {
    static storage: ChunkStorage = {};
    private static listeners = new Set<() => void>();

    static addListener(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    static emitChange() {
        this.listeners.forEach(l => l());
    }

    static addChunk(chunk: StoredFileChunk, channelId: string, uploader: UploaderInfo): void {
        const key = chunk.timestamp.toString();
        
        if (!this.storage[key]) {
            this.storage[key] = {
                id: chunk.timestamp,
                name: chunk.originalName,
                size: chunk.originalSize,
                totalChunks: chunk.total,
                channelId: channelId,
                uploader: uploader,
                chunks: [],
                lastUpdated: Date.now(),
                isComplete: false
            };
        }

        const session = this.storage[key];
        
        // Idempotency: Don't add if we already have this index
        if (!session.chunks.some(c => c.index === chunk.index)) {
            session.chunks.push(chunk);
            session.lastUpdated = Date.now();
            session.isComplete = session.chunks.length === session.totalChunks;
            this.emitChange();
        }
    }

    static removeChunk(messageId: string) {
        let changed = false;
        Object.keys(this.storage).forEach(key => {
            const session = this.storage[key];
            const initialLength = session.chunks.length;
            session.chunks = session.chunks.filter(c => c.messageId !== messageId);
            
            if (session.chunks.length !== initialLength) {
                changed = true;
                session.isComplete = false; // Became incomplete
                
                // If no chunks left, remove session?
                if (session.chunks.length === 0) {
                    delete this.storage[key];
                }
            }
        });
        if (changed) this.emitChange();
    }

    static removeChunkByIndex(sessionId: number, index: number) {
        const session = this.getSession(sessionId);
        if (!session) return;
        
        const initialLength = session.chunks.length;
        session.chunks = session.chunks.filter(c => c.index !== index);
        
        if (session.chunks.length !== initialLength) {
            session.isComplete = false;
            this.emitChange();
        }
    }

    static getSession(sessionId: number): DetectedFileSession | null {
        return this.storage[sessionId.toString()] || null;
    }

    // Get all sessions, optionally filtered by channel
    static getSessions(channelId?: string): DetectedFileSession[] {
        const sessions = Object.values(this.storage);
        if (channelId) {
            return sessions.filter(s => s.channelId === channelId);
        }
        return sessions;
    }

    static cleanOldChunks(): void {
        const now = Date.now();
        let changed = false;
        Object.keys(this.storage).forEach(key => {
            if (now - this.storage[key].lastUpdated > CHUNK_TIMEOUT) {
                delete this.storage[key];
                changed = true;
                // console.log(`[FileSplitter] Garbage collected session: ${key}`);
            }
        });
        if (changed) this.emitChange();
    }

    /**
     * Verifies downloaded chunks against a local original file to find corruption.
     * @returns Array of corrupt chunk indices.
     */
    static async verifySessionAgainstFile(sessionId: number, originalFile: File): Promise<number[]> {
        const session = this.getSession(sessionId);
        if (!session) throw new Error("Session not found");
        
        const chunks = [...session.chunks].sort((a, b) => a.index - b.index);
        const corruptIndices: number[] = [];
        
        if (chunks.length === 0) return [];
        
        let chunkSize = 0;
        const fetcher = (window as any).VencordNative?.net?.fetch;
        if (!fetcher) throw new Error("Fetch missing");

        // Concurrent Verification Queue
        const concurrency = 4; // Verify 4 chunks at a time
        let activeCount = 0;
        let index = 0;
        const total = session.totalChunks;

        const verifyChunk = async (i: number) => {
            if (i % Math.max(1, Math.floor(total / 10)) === 0) {
                console.log(`[Verify] Checking chunk ${i + 1}/${total} (${Math.round(i / total * 100)}%)`);
            }

            const chunkMeta = chunks.find(c => c.index === i);
            if (!chunkMeta) {
                console.warn(`[Verify] Missing chunk ${i}`);
                corruptIndices.push(i);
                return;
            }

            try {
                // 1. Fetch remote chunk data
                const responseBuffer = await fetcher(chunkMeta.url);
                if (!responseBuffer) throw new Error("Empty response");
                const remoteData = new Uint8Array(responseBuffer);

                // 2. Read local file slice
                if (chunkSize === 0) chunkSize = remoteData.length;
                
                const start = i * chunkSize;
                const end = Math.min(start + remoteData.length, originalFile.size);
                
                // If local file is smaller than expected start, it's corrupt/wrong file
                if (start >= originalFile.size) {
                    throw new Error("Local file too small");
                }

                const localSlice = originalFile.slice(start, end);
                const localBuffer = await localSlice.arrayBuffer();
                const localData = new Uint8Array(localBuffer);

                if (remoteData.length !== localData.length) {
                    console.warn(`[Verify] Chunk ${i} size mismatch.`);
                    corruptIndices.push(i);
                    return;
                }

                // 3. Hash & Compare
                const remoteHashBuffer = await crypto.subtle.digest('SHA-256', remoteData);
                const localHashBuffer = await crypto.subtle.digest('SHA-256', localData);
                
                const remoteHash = Array.from(new Uint8Array(remoteHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
                const localHash = Array.from(new Uint8Array(localHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

                if (remoteHash !== localHash) {
                    console.warn(`[Verify] Chunk ${i} hash mismatch.`);
                    corruptIndices.push(i);
                }

            } catch (e) {
                console.error(`[Verify] Error checking chunk ${i}`, e);
                corruptIndices.push(i);
            }
        };

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        while (index < total || activeCount > 0) {
            while (activeCount < concurrency && index < total) {
                const idx = index++;
                activeCount++;
                verifyChunk(idx).then(() => activeCount--).catch(() => activeCount--);
            }
            
            if (activeCount > 0) await sleep(50);
            else if (index >= total) break;
        }

        console.log(`[Verify] Complete. Found ${corruptIndices.length} bad chunks.`);
        return corruptIndices;
    }
}

export const isValidChunk = (chunk: any): chunk is FileChunkMetadata => {
    return (
        typeof chunk === 'object' &&
        chunk.type === "FileSplitterChunk" &&
        typeof chunk.index === 'number' &&
        typeof chunk.total === 'number' &&
        typeof chunk.originalName === 'string' &&
        typeof chunk.originalSize === 'number' &&
        typeof chunk.timestamp === 'number'
    );
};

export const handleFileMerge = async (chunks: StoredFileChunk[]) => {
    try {
        chunks.sort((a, b) => a.index - b.index);
        console.log(`[FileSplitter] Merging ${chunks.length} chunks. Metadata of first chunk:`, chunks[0]);

        const blobParts: Blob[] = [];
        for (const chunk of chunks) {
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

        const finalBlob = new Blob(blobParts);
        const finalFile = new File([finalBlob], chunks[0].originalName);

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
        showToast("Merge failed. See console.", Toasts.Type.FAILURE);
    }
};