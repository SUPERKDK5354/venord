import { Button, Text, MessageActions, TooltipContainer, useState, useEffect } from "@webpack/common";
import { DownloadManager, DownloadState } from "../DownloadManager";
import { DetectedFileSession } from "../ChunkManager";
import { showNotification } from "@api/Notifications";

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
import { ChunkManager, handleFileMerge, DetectedFileSession, calculateChecksum } from "../ChunkManager";
import { UploadManager } from "../UploadManager";

export const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    const [status, setStatus] = useState("Ready");
    const [isRepairing, setIsRepairing] = useState(false);
    const [dlState, setDlState] = useState<DownloadState | undefined>(DownloadManager.downloads.get(session.id));

    useEffect(() => {
        return DownloadManager.addListener(() => {
            const dl = DownloadManager.downloads.get(session.id);
            if (dl) setDlState({ ...dl });
        });
    }, [session.id]);

    const handleDownload = async () => {
        if (dlState?.status === 'downloading') {
            DownloadManager.pauseDownload(session.id);
        } else if (dlState?.status === 'paused') {
            DownloadManager.startDownload(session.id);
        } else {
            DownloadManager.startDownload(session.id);
        }
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
                showNotification({
                    title: "Verification Passed",
                    body: `${session.name}: All chunks match the local file.`,
                    icon: "CheckmarkLargeIcon"
                });
                setStatus("Verified");
            } else {
                console.error("Bad chunks:", badIndices);
                showNotification({
                    title: "Corruption Detected",
                    body: `${session.name}: Found ${badIndices.length} corrupt chunks. Starting repair...`,
                    icon: "WarningIcon"
                });
                setStatus(`Repairing ${badIndices.length} chunks...`);

                const abortController = new AbortController();
                
                for (const idx of badIndices) {
                    ChunkManager.removeChunkByIndex(session.id, idx);
                }

                const validChunk = session.chunks.find(c => !badIndices.includes(c.index));
                let detectedChunkSize = 0;
                if (validChunk) {
                     const candidates = [8, 9.5, 9.9, 10, 24, 24.9, 25, 49, 50, 99, 100, 499, 500].map(m => m * 1024 * 1024);
                     for (const s of candidates) {
                         const expectedTotal = Math.ceil(file.size / s);
                         if (expectedTotal === session.totalChunks) {
                             detectedChunkSize = s;
                             break;
                         }
                     }
                }
                if (detectedChunkSize === 0) detectedChunkSize = 9.5 * 1024 * 1024; 

                for (const i of badIndices) {
                    const start = i * detectedChunkSize;
                    const end = Math.min(start + detectedChunkSize, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkFile = new File([chunkBlob], `${session.name.replace(/[^a-zA-Z0-9.-]/g, "_")}.part${String(i + 1).padStart(3, '0')}`);
                    
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
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                showNotification({
                    title: "Repair Complete",
                    body: `${session.name}: Successfully repaired ${badIndices.length} chunks.`,
                    icon: "CheckmarkLargeIcon"
                });
                setStatus("Repaired");
            }
        } catch (err: any) {
            console.error(err);
            showNotification({
                title: "Repair Failed",
                body: `${session.name}: ${err.message}`,
                icon: "CloseSmallIcon"
            });
            setStatus("Error");
        } finally {
            setIsRepairing(false);
            e.target.value = "";
        }
    };

    const handleQuickVerify = async () => {
        setIsRepairing(true);
        setStatus("Checking...");
        try {
            // 1. Check if we have blobs downloaded
            const dlState = DownloadManager.downloads.get(session.id);
            const state = dlState as any;
            if (!state?.blobs || state.blobs.size === 0) {
                showToast("No downloaded data to verify. Download first.", Toasts.Type.INFO);
                setStatus("No Data");
                setIsRepairing(false);
                return;
            }

            let verifiedCount = 0;
            let failedChunks: number[] = [];

            // 2. Try Chunk-Level Verification
            const hasChunkChecksums = session.chunks.some(c => c.chunkChecksum);
            
            if (hasChunkChecksums) {
                for (const chunk of session.chunks) {
                    const blob = state.blobs.get(chunk.index);
                    if (!blob || !chunk.chunkChecksum) continue;

                    const buffer = await blob.arrayBuffer();
                    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

                    if (hash !== chunk.chunkChecksum) {
                        failedChunks.push(chunk.index);
                    } else {
                        verifiedCount++;
                    }
                }

                if (failedChunks.length > 0) {
                    showNotification({
                        title: "Integrity Failed",
                        body: `${session.name}: Corrupt chunks detected: ${failedChunks.join(', ')}`,
                        icon: "CloseSmallIcon"
                    });
                    setStatus("Corrupt!");
                } else if (verifiedCount === 0) {
                    showNotification({
                        title: "Verification Failed",
                        body: `${session.name}: No chunks could be verified (missing metadata).`,
                        icon: "WarningIcon"
                    });
                    setStatus("Unknown");
                } else {
                    showNotification({
                        title: "Integrity Passed",
                        body: `${session.name}: Successfully verified ${verifiedCount} chunks.`,
                        icon: "CheckmarkLargeIcon"
                    });
                    setStatus("Verified");
                }
            } else if (session.chunks[0]?.checksum) {
                // 3. Fallback to Global Verification (Merge & Hash)
                showToast("Verifying global checksum (this may take a moment)...", Toasts.Type.INFO);
                
                // Merge in memory
                const orderedBlobs: Blob[] = [];
                for (let i = 0; i < session.totalChunks; i++) {
                    const b = state.blobs.get(i);
                    if (b) orderedBlobs.push(b);
                }
                
                if (orderedBlobs.length !== session.totalChunks) {
                    showNotification({
                        title: "Verification Failed",
                        body: `${session.name}: Cannot verify global checksum: Missing chunks.`,
                        icon: "CloseSmallIcon"
                    });
                    setIsRepairing(false);
                    return;
                }

                const finalBlob = new Blob(orderedBlobs);
                const hash = await calculateChecksum(finalBlob);
                
                if (hash === session.chunks[0].checksum) {
                    showNotification({
                        title: "Integrity Passed",
                        body: `${session.name}: Global checksum matches.`,
                        icon: "CheckmarkLargeIcon"
                    });
                    setStatus("Verified");
                } else {
                    showNotification({
                        title: "Integrity Failed",
                        body: `${session.name}: Global checksum mismatch!`,
                        icon: "CloseSmallIcon"
                    });
                    setStatus("Corrupt!");
                }
            } else {
                showNotification({
                    title: "Verification Unavailable",
                    body: `${session.name}: No checksums found in metadata.`,
                    icon: "WarningIcon"
                });
                setStatus("No Hash");
            }

        } catch (e: any) {
            console.error(e);
            showNotification({
                title: "Verification Error",
                body: `${session.name}: ${e.message}`,
                icon: "CloseSmallIcon"
            });
            setStatus("Error");
        }
        setIsRepairing(false);
    };

    const isDownloading = dlState?.status === 'downloading';
    // Calculate progress: if downloading, use bytes; else use chunk count
    const progress = isDownloading && dlState
        ? Math.min(100, (dlState.bytesDownloaded / dlState.totalBytes) * 100)
        : Math.min(100, (session.chunks.length / session.totalChunks) * 100);
    
    const isComplete = session.chunks.length === session.totalChunks;
    const isDlComplete = dlState?.status === 'completed';

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
                    {isDownloading && dlState && (
                        <TooltipContainer text={`Active Chunks: ${dlState.chunksDownloaded.size}/${session.totalChunks}`}>
                            <Text variant="text-xs/normal" color="text-brand" style={{ cursor: 'help' }}>
                                • {formatSize(dlState.speed)}/s
                            </Text>
                        </TooltipContainer>
                    )}
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
                    color={isDlComplete ? Button.Colors.GREEN : isComplete ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    disabled={!isComplete && !isDlComplete}
                    onClick={isDlComplete ? () => DownloadManager.saveFileToDisk(session.id) : handleDownload}
                >
                    {isDlComplete ? "Save" : isDownloading ? "Pause" : dlState?.status === 'paused' ? "Resume" : "Download"}
                </Button>
                
                <Button 
                    size={Button.Sizes.MIN} 
                    look={Button.Looks.LINK}
                    color={Button.Colors.PRIMARY}
                    disabled={isRepairing || !dlState || (dlState.status !== 'completed' && dlState.status !== 'merging') || !(dlState as any).blobs?.size}
                    onClick={handleQuickVerify}
                    title={!dlState ? "Download first to verify" : "Verify integrity of downloaded data"}
                >
                    Verify (Meta)
                </Button>

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
                    {isRepairing ? "Checking..." : "Repair (File)"}
                </Button>
            </div>
        </div>
    );
};
