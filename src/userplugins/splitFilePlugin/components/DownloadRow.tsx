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
import { showNotification } from "@api/Notifications";

export const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    const [status, setStatus] = useState("Ready");
    const [dlState, setDlState] = useState<DownloadState | undefined>(DownloadManager.downloads.get(session.id));
    const [repairState, setRepairState] = useState(DownloadManager.activeRepairs.get(session.id));

    useEffect(() => {
        return DownloadManager.addListener(() => {
            const dl = DownloadManager.downloads.get(session.id);
            if (dl) setDlState({ ...dl });
            
            const rep = DownloadManager.activeRepairs.get(session.id);
            if (rep) setRepairState({ ...rep });
            else setRepairState(undefined);
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
        
        e.target.value = "";
        DownloadManager.repairSession(session.id, file);
    };

    const handleQuickVerify = async () => {
        setStatus("Checking...");
        try {
            // 1. Check if we have blobs downloaded
            const dlState = DownloadManager.downloads.get(session.id);
            const state = dlState as any;
            if (!state?.blobs || state.blobs.size === 0) {
                showToast("No downloaded data to verify. Download first.", Toasts.Type.INFO);
                setStatus("No Data");
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
                    showToast(`Integrity Failed: ${session.name} (${failedChunks.length} chunks)`, Toasts.Type.FAILURE);
                    showNotification({ title: "Integrity Failed", body: `${session.name}: ${failedChunks.length} chunks corrupt`, icon: "CloseSmallIcon" });
                    setStatus("Corrupt!");
                } else if (verifiedCount === 0) {
                    showToast("Verification Failed: No chunks verified", Toasts.Type.WARNING);
                    setStatus("Unknown");
                } else {
                    showToast(`Integrity Passed: ${session.name}`, Toasts.Type.SUCCESS);
                    showNotification({ title: "Integrity Passed", body: `${session.name}: ${verifiedCount} chunks verified`, icon: "CheckmarkLargeIcon" });
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
                    showToast("Verification Failed: Missing chunks", Toasts.Type.FAILURE);
                    return;
                }

                const finalBlob = new Blob(orderedBlobs);
                const hash = await calculateChecksum(finalBlob);
                
                if (hash === session.chunks[0].checksum) {
                    showToast(`Integrity Passed: ${session.name}`, Toasts.Type.SUCCESS);
                    showNotification({ title: "Integrity Passed", body: `${session.name}: Checksum valid`, icon: "CheckmarkLargeIcon" });
                    setStatus("Verified");
                } else {
                    showToast(`Integrity Failed: ${session.name} (Global Mismatch)`, Toasts.Type.FAILURE);
                    showNotification({ title: "Integrity Failed", body: `${session.name}: Global Checksum Mismatch`, icon: "CloseSmallIcon" });
                    setStatus("Corrupt!");
                }
            } else {
                showToast("Verification Unavailable: No checksums", Toasts.Type.WARNING);
                setStatus("No Hash");
            }

        } catch (e: any) {
            console.error(e);
            showToast(`Verification Error: ${e.message}`, Toasts.Type.FAILURE);
            showNotification({ title: "Verification Error", body: e.message, icon: "CloseSmallIcon" });
            setStatus("Error");
        }
    };

    const isDownloading = dlState?.status === 'downloading';
    // Calculate progress
    const progress = isDownloading && dlState
        ? Math.min(100, (dlState.bytesDownloaded / dlState.totalBytes) * 100)
        : Math.min(100, (session.chunks.length / session.totalChunks) * 100);
    
    const isComplete = session.chunks.length === session.totalChunks;
    const isDlComplete = dlState?.status === 'completed';
    
    const repairStatus = repairState ? (repairState.status === 'verifying' ? "Verifying..." : repairState.status === 'repairing' ? `Repairing ${repairState.repairedChunks}/${repairState.totalBadChunks}` : "Complete") : null;

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
                    disabled={!!repairState || !dlState || (dlState.status !== 'completed' && dlState.status !== 'merging') || !(dlState as any).blobs?.size}
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
                    disabled={!!repairState}
                    onClick={() => document.getElementById(`repair-${session.id}`)?.click()}
                >
                    {repairStatus || "Repair (File)"}
                </Button>
            </div>
        </div>
    );
};
