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
}

export interface StoredFileChunk extends FileChunkMetadata {
    url: string;
    proxyUrl?: string;
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
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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