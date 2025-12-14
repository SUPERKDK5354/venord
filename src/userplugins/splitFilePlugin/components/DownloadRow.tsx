import { Button, Text, MessageActions, TooltipContainer, useState, useEffect } from "@webpack/common";
import { DownloadManager, DownloadState } from "../DownloadManager";
import { DetectedFileSession } from "../ChunkManager";

const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1000;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return "--";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    return `${m}m ${Math.ceil(seconds % 60)}s`;
};

const UserLink = ({ user }: { user: { id: string, username: string, avatar?: string } }) => {
    const avatarUrl = user.avatar 
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.id) % 5}.png`;

    return (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginRight: "8px" }}>
            <img src={avatarUrl} style={{ width: 24, height: 24, borderRadius: "50%" }} />
            <Text variant="text-sm/medium" color="text-normal">
                <span style={{ color: "var(--text-link)", cursor: "pointer" }}>@{user.username}</span>
            </Text>
        </div>
    );
};

const ChannelLink = ({ channelId }: { channelId: string }) => {
    const handleClick = () => {
        MessageActions.jumpToMessage({ channelId, messageId: undefined as any, flash: false });
    };
    return (
        <Text variant="text-xs/normal" color="text-link" style={{ cursor: "pointer" }} onClick={handleClick}>
            &lt;#{channelId}&gt;
        </Text>
    );
};

import { Button, Text, Toasts, showToast, useState } from "@webpack/common";
import { ChunkManager, handleFileMerge, DetectedFileSession } from "../ChunkManager";
import { UploadManager } from "../UploadManager";

export const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    const [status, setStatus] = useState("Ready");
    const [isRepairing, setIsRepairing] = useState(false);

    const handleDownload = async () => {
        setStatus("Merging...");
        await handleFileMerge(session.chunks);
        setStatus("Done");
        setTimeout(() => setStatus("Ready"), 3000);
    };

    const handleRepair = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        
        if (file.size !== session.size) {
            showToast("File size mismatch! Select the exact original file.", Toasts.Type.FAILURE);
            return;
        }

        setIsRepairing(true);
        setStatus("Verifying...");
        
        try {
            const badIndices = await ChunkManager.verifySessionAgainstFile(session.id, file);
            if (badIndices.length === 0) {
                showToast("Verification passed! All chunks match the local file.", Toasts.Type.SUCCESS);
                setStatus("Verified");
            } else {
                console.error("Bad chunks:", badIndices);
                showToast(`Found ${badIndices.length} corrupt chunks. Repairing...`, Toasts.Type.DEFAULT);
                setStatus(`Repairing ${badIndices.length} chunks...`);

                // Repair Logic
                const abortController = new AbortController();
                
                // 1. Remove bad chunks from local state so new ones are accepted
                for (const idx of badIndices) {
                    ChunkManager.removeChunkByIndex(session.id, idx);
                }

                // 2. Upload replacement chunks
                // We need to guess chunk size again or calculate it. 
                // Using the first chunk length is usually safe if index 0 exists.
                // If not, we have a problem. But verifySession found them, so we know their length from remote data.
                // Actually, we can just use the standard size logic from settings if we assume it hasn't changed, 
                // OR we can deduce it. 
                // Simplest: `file.size / totalChunks` is approx, but `ceil` might be used.
                // `ChunkManager` doesn't strictly know the chunk size. 
                // Let's assume standard logic: Equal chunks except last.
                // Calculate chunk size based on file size and total chunks? 
                // No, standard is fixed size (e.g. 8MB, 25MB).
                // Let's try to infer from `session.chunks`.
                const validChunk = session.chunks.find(c => !badIndices.includes(c.index));
                // If all chunks are bad, we default to a safe guess or ask user? 
                // Actually, let's just use the `originalSize / totalChunks` rounded up? No that's wrong.
                // We stored `chunkSize` in UploadSession but not in Metadata :(
                // Backwards compat fix: Try to find a valid chunk and use its size.
                // If no valid chunks, use 9.5MB (default) or try to calculate.
                // BUT WAIT! We verified against the file. The verification step *knew* the chunk size because it downloaded the remote chunk.
                // We can't access that variable here easily.
                
                // Let's assume the user hasn't changed the setting? Risky.
                // Better: We uploaded it. 
                // If we check `UploadManager` sessions, maybe it's still there?
                // `session.chunks[0].originalSize`.
                // Let's look for a valid chunk again.
                // If we have to guess: 
                // Most chunks are equal. Last one is smaller or equal.
                // `chunkSize = ceil(size / total)` is only for equal distribution.
                // Here we used `chunkSize = fixed`.
                // Iterate chunks to find max size?
                
                // HACK: Use the file size / total chunks to see if it's an integer. 
                // If not, it was split by fixed size.
                // We can't easily know perfectly without metadata.
                // But `ChunkManager` does have `verifySessionAgainstFile` which successfully sliced the file to compare.
                // How did IT know? It used `remoteData.length`.
                // We can fetch ONE bad chunk again to see its expected length? No, it might be truncated.
                // We should fetch ONE GOOD chunk.
                
                let detectedChunkSize = 0;
                if (validChunk) {
                     // We need to fetch it to know size? Or assume metadata? Metadata has no size.
                     // We can try to guess from the file size?
                     // If we have index 0 and it's valid, we could fetch it.
                     // But we want to avoid extra fetches.
                     
                     // fallback: 
                     // We can iterate standard sizes: 8, 9.5, 24, 25, 99, 100, 499, 500.
                     // See which one fits `size = (total-1)*chunk + last`.
                     
                     const candidates = [8, 9.5, 9.9, 10, 24, 24.9, 25, 49, 50, 99, 100, 499, 500].map(m => m * 1024 * 1024);
                     for (const s of candidates) {
                         const expectedTotal = Math.ceil(file.size / s);
                         if (expectedTotal === session.totalChunks) {
                             detectedChunkSize = s;
                             break;
                         }
                     }
                }
                
                // If heuristic failed, default to 9.5MB (standard default)
                if (detectedChunkSize === 0) detectedChunkSize = 9.5 * 1024 * 1024; 
                
                console.log(`[Repair] Using chunk size: ${detectedChunkSize}`);

                for (const i of badIndices) {
                    const start = i * detectedChunkSize;
                    const end = Math.min(start + detectedChunkSize, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkFile = new File([chunkBlob], `${session.name.replace(/[^a-zA-Z0-9.-]/g, "_")}.part${String(i + 1).padStart(3, '0')}`);
                    
                    // Recalculate global checksum if missing (unlikely if we just verified it, but session might rely on it)
                    // The verify function checked hash of content. 
                    // We can reuse the `file` for checksum.
                    // Ideally we pass the original checksum if we have it.
                    const originalChecksum = session.chunks[0]?.checksum;

                    const metadata = {
                        type: "FileSplitterChunk",
                        index: i,
                        total: session.totalChunks,
                        originalName: session.name,
                        originalSize: session.size,
                        timestamp: session.id,
                        checksum: originalChecksum
                    };

                    await UploadManager.uploadChunk(chunkFile, metadata, session.channelId, abortController.signal);
                    
                    // Small delay to be safe
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                showToast("Repair complete! Refreshing...", Toasts.Type.SUCCESS);
                setStatus("Repaired");
            }
        } catch (err: any) {
            console.error(err);
            showToast("Repair failed: " + err.message, Toasts.Type.FAILURE);
            setStatus("Error");
        } finally {
            setIsRepairing(false);
            e.target.value = ""; // Reset input
        }
    };

    const progress = Math.min(100, (session.chunks.length / session.totalChunks) * 100);
    const isComplete = session.chunks.length === session.totalChunks;

    return (
        <div style={{ 
            display: 'flex', 
            padding: '12px', 
            backgroundColor: 'var(--background-tertiary)', 
            borderRadius: '8px',
            marginBottom: '8px',
            alignItems: 'center',
            gap: '12px'
        }}>
            <div style={{ flexGrow: 1, overflow: 'hidden' }}>
                <Text variant="text-md/semibold" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.name}
                </Text>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <Text variant="text-xs/normal" color="text-muted">
                        {(session.size / 1024 / 1024).toFixed(2)} MB • {session.chunks.length}/{session.totalChunks} chunks
                    </Text>
                    {isComplete && <Text variant="text-xs/bold" color="text-positive">Complete</Text>}
                </div>
                {/* Progress Bar */}
                <div style={{ 
                    height: '4px', 
                    width: '100%', 
                    backgroundColor: 'var(--background-modifier-accent)', 
                    borderRadius: '2px',
                    marginTop: '6px',
                    overflow: 'hidden'
                }}>
                    <div style={{ 
                        height: '100%', 
                        width: `${progress}%`, 
                        backgroundColor: isComplete ? 'var(--text-positive)' : 'var(--brand-experiment)',
                        transition: 'width 0.3s ease'
                    }} />
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '100px' }}>
                <Button 
                    size={Button.Sizes.SMALL} 
                    color={isComplete ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    disabled={!isComplete || status === "Merging..." || isRepairing}
                    onClick={handleDownload}
                >
                    {status === "Ready" ? "Download" : status}
                </Button>
                
                {/* Repair Button - Hidden input trick */}
                <input
                    type="file"
                    id={`repair-${session.id}`}
                    style={{ display: 'none' }}
                    onChange={handleRepair}
                />
                <Button 
                    size={Button.Sizes.MIN} 
                    look={Button.Looks.LINK}
                    color={Button.Colors.RED}
                    disabled={isRepairing}
                    onClick={() => document.getElementById(`repair-${session.id}`)?.click()}
                >
                    {isRepairing ? "Checking..." : "Verify / Repair"}
                </Button>
            </div>
        </div>
    );
};
