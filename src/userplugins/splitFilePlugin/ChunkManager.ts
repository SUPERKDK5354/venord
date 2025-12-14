import { Toasts, showToast } from "@webpack/common";

const CHUNK_TIMEOUT = 5 * 60 * 1000;

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

interface ChunkStorage {
    [key: string]: {
        chunks: StoredFileChunk[];
        lastUpdated: number;
    };
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
    private static storage: ChunkStorage = {};

    static addChunk(chunk: StoredFileChunk): void {
        const key = chunk.timestamp.toString();
        if (!this.storage[key]) {
            this.storage[key] = {
                chunks: [],
                lastUpdated: Date.now()
            };
        }

        if (!this.storage[key].chunks.some(c => c.index === chunk.index)) {
            this.storage[key].chunks.push(chunk);
            this.storage[key].lastUpdated = Date.now();
        }
    }

    static getChunks(sessionId: number): StoredFileChunk[] | null {
        return this.storage[sessionId.toString()]?.chunks || null;
    }

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
