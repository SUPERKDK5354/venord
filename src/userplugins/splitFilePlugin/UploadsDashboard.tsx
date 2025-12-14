import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Text, MessageActions, SelectedChannelStore, TabBar, TooltipContainer, useState, useEffect, useRef } from "@webpack/common";
import { UploadManager, UploadSession } from "./UploadManager";
import { ChunkManager, DetectedFileSession, handleFileMerge } from "./ChunkManager";
import { DownloadManager, DownloadState } from "./DownloadManager";

// --- Helpers ---
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
    // Construct avatar URL. 
    // Format: https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.png
    const avatarUrl = user.avatar 
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.id) % 5}.png`; // Fallback

    const handleClick = () => {
        // Open user profile? Not easy API exposed. 
        // Just jumping to channel/message is better context.
    };

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

// --- Components ---

const UploadRow = ({ session }: { session: UploadSession }) => {
    const progress = Math.round((session.completedIndices.size / session.totalChunks) * 100);
    const isPaused = session.status === 'paused' || session.status === 'pending';
    const isDone = session.status === 'completed';
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isMerging, setIsMerging] = useState(false);

    const handleResume = () => {
        if (!session.file) {
            fileInputRef.current?.click();
        } else {
            UploadManager.resumeUpload(session.id);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            UploadManager.resumeUpload(session.id, file);
        }
        e.target.value = "";
    };

    const handleJump = () => {
        if (session.lastMessageId && session.channelId) {
            MessageActions.jumpToMessage({ channelId: session.channelId, messageId: session.lastMessageId, flash: true });
        }
    };

    const handleDownload = async () => {
        setIsMerging(true);
        // For own uploads, we might not have them in ChunkManager if we reloaded?
        // Actually onMessageCreate populates ChunkManager. So it should be there.
        const chunks = ChunkManager.getChunks(session.id);
        if (chunks && chunks.length === session.totalChunks) {
            await handleFileMerge(chunks);
        } else {
            // Fallback: If we just uploaded, we might need to rely on local file? 
            // But user wants to download *from Discord* to verify.
            // If chunks are missing in ChunkManager (e.g. filtered), we can't download.
            console.error("Missing chunks for download");
        }
        setIsMerging(false);
    };

    return (
        <div className="vc-upload-row" style={{
            padding: "8px", marginBottom: "8px", backgroundColor: "var(--background-secondary)", borderRadius: "4px"
        }}>
            <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} />
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <Text 
                    variant="text-md/bold" 
                    style={{ 
                        overflow: "hidden", 
                        textOverflow: "ellipsis", 
                        whiteSpace: "nowrap", 
                        cursor: session.lastMessageId ? "pointer" : "default",
                        textDecoration: session.lastMessageId ? "underline" : "none"
                    }}
                    onClick={handleJump}
                >
                    {session.name}
                </Text>
                <div style={{ display: "flex", gap: "8px" }}>
                    {isDone && (
                        <Button 
                            size={Button.Sizes.TINY} 
                            color={Button.Colors.BRAND} 
                            onClick={handleDownload}
                            disabled={isMerging}
                        >
                            {isMerging ? "Merging..." : "Download"}
                        </Button>
                    )}
                    {!isDone && (
                        <Button 
                            size={Button.Sizes.TINY} 
                            color={isPaused ? Button.Colors.GREEN : Button.Colors.YELLOW}
                            onClick={() => isPaused ? handleResume() : UploadManager.pauseUpload(session.id)}
                        >
                            {isPaused ? "Resume" : "Pause"}
                        </Button>
                    )}
                    <Button 
                        size={Button.Sizes.TINY} 
                        color={Button.Colors.RED}
                        onClick={() => UploadManager.deleteUpload(session.id)}
                    >
                        {isDone ? "Clear" : "Cancel"}
                    </Button>
                </div>
            </div>

            <div style={{ height: "8px", width: "100%", backgroundColor: "var(--background-tertiary)", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${progress}%`, backgroundColor: "var(--brand-experiment)", transition: "width 0.2s" }} />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <Text variant="text-xs/normal" color="text-muted">
                        {progress}% • {formatSize(session.bytesUploaded)} / {formatSize(session.size)}
                    </Text>
                    <ChannelLink channelId={session.channelId} />
                </div>
                {!isDone && !isPaused && (
                    <Text variant="text-xs/normal" color="text-muted">
                        {formatSize(session.speed)}/s • {formatTime(session.etr)} left
                    </Text>
                )}
            </div>
        </div>
    );
};

const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    const [dlState, setDlState] = useState<DownloadState | undefined>(DownloadManager.downloads.get(session.id));
    
    useEffect(() => {
        return DownloadManager.addListener(() => {
            setDlState(DownloadManager.downloads.get(session.id));
        });
    }, [session.id]);

    const isDownloading = dlState && dlState.status === 'downloading';
    const isDone = dlState && dlState.status === 'completed';
    const progress = dlState ? Math.round((dlState.bytesDownloaded / dlState.totalBytes) * 100) : 0;

    // Use chunks to find a message ID to jump to (any chunk works, last one is best)
    // Actually session.chunks might be empty if we just detected it via header but haven't fetched?
    // No, session.chunks has the chunks we found.
    const lastChunk = session.chunks[session.chunks.length - 1];
    // We don't store messageId in Chunk? We store url. 
    // Wait, ChunkManager doesn't store message ID.
    // I need to add messageId to StoredFileChunk or something if I want to jump.
    // Or just jump to channel.
    // I'll leave name unclickable for now if I don't have message ID, or just Channel Link.
    
    return (
        <div style={{
            padding: "8px", marginBottom: "8px", backgroundColor: "var(--background-secondary)", borderRadius: "4px"
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Text variant="text-md/bold">{session.name}</Text>
                    {isDone && (
                        <TooltipContainer text={dlState?.checksumResult === 'pass' ? "Integrity Verified" : "Checksum Mismatch!"}>
                            <div style={{ 
                                width: 16, height: 16, borderRadius: "50%", 
                                backgroundColor: dlState?.checksumResult === 'pass' ? "var(--text-positive)" : "var(--text-danger)",
                                display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: "10px"
                            }}>
                                {dlState?.checksumResult === 'pass' ? "✓" : "✕"}
                            </div>
                        </TooltipContainer>
                    )}
                </div>
                
                <div style={{ display: "flex", gap: "8px" }}>
                    {isDone ? (
                        <Button size={Button.Sizes.TINY} color={Button.Colors.BRAND} onClick={() => DownloadManager.saveFileToDisk(session.id)}>
                            Save
                        </Button>
                    ) : isDownloading ? (
                        <Button size={Button.Sizes.TINY} color={Button.Colors.YELLOW} onClick={() => DownloadManager.pauseDownload(session.id)}>
                            Pause
                        </Button>
                    ) : (
                        <Button size={Button.Sizes.TINY} color={Button.Colors.GREEN} onClick={() => DownloadManager.startDownload(session.id)}>
                            {dlState?.status === 'paused' ? "Resume" : "Download"}
                        </Button>
                    )}
                </div>
            </div>

            {/* Progress (Only if downloading/paused/done) */}
            {(dlState) && (
                <div style={{ height: "8px", width: "100%", backgroundColor: "var(--background-tertiary)", borderRadius: "4px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${progress}%`, backgroundColor: isDone ? "var(--text-positive)" : "var(--brand-experiment)", transition: "width 0.2s" }} />
                </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                    {session.uploader && <UserLink user={session.uploader} />}
                    <Text variant="text-xs/normal" color="text-muted" style={{ marginRight: "8px" }}>
                        {formatSize(session.size)}
                    </Text>
                    <ChannelLink channelId={session.channelId} />
                </div>
                
                {isDownloading && (
                    <Text variant="text-xs/normal" color="text-muted">
                        {formatSize(dlState.speed)}/s • {formatTime(dlState.etr)} left
                    </Text>
                )}
            </div>
        </div>
    );
};

export const UploadsDashboard = (props: any) => {
    const [tab, setTab] = useState("YOUR_UPLOADS");
    const [uploads, setUploads] = useState<UploadSession[]>([]);
    const [detectedFiles, setDetectedFiles] = useState<DetectedFileSession[]>([]);
    
    // Scanner
    const [scanLimit, setScanLimit] = useState("100");
    const [isScanning, setIsScanning] = useState(false);

    useEffect(() => {
        const updateUploads = () => setUploads(Array.from(UploadManager.sessions.values()).sort((a, b) => b.id - a.id));
        const updateFiles = () => setDetectedFiles(ChunkManager.getSessions());
        
        updateUploads();
        updateFiles();

        const unsub1 = UploadManager.addListener(updateUploads);
        const unsub2 = ChunkManager.addListener(updateFiles);
        return () => { unsub1(); unsub2(); };
    }, []);

    const handleScan = async () => {
        setIsScanning(true);
        const limit = parseInt(scanLimit) || 100;
        await DownloadManager.scanChannel(SelectedChannelStore.getChannelId(), limit);
        setIsScanning(false);
    };

    // Filter Logic
    const currentChannelId = SelectedChannelStore.getChannelId();
    const filteredFiles = tab === 'CURRENT_CHANNEL' 
        ? detectedFiles.filter(f => f.channelId === currentChannelId)
        : detectedFiles;

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader style={{ flexDirection: "column", alignItems: "start", gap: "16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                    <Text variant="heading-lg/bold">Upload Manager</Text>
                    
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        {tab === 'YOUR_UPLOADS' ? (
                            <>
                                <input 
                                    type="file" 
                                    id="header-upload-input"
                                    style={{ display: 'none' }} 
                                    onChange={(e) => {
                                        if (e.target.files?.[0]) UploadManager.startUpload(e.target.files[0], 9.5);
                                        e.target.value = "";
                                    }} 
                                />
                                <Button size={Button.Sizes.SMALL} onClick={() => document.getElementById('header-upload-input')?.click()}>
                                    New Upload
                                </Button>
                            </>
                        ) : tab === 'CURRENT_CHANNEL' ? (
                            <>
                                <input 
                                    type="number" 
                                    value={scanLimit} 
                                    onChange={(e) => setScanLimit(e.target.value)}
                                    style={{ 
                                        width: "60px", padding: "4px", borderRadius: "4px", 
                                        backgroundColor: "var(--background-tertiary)", color: "var(--text-normal)", border: "none" 
                                    }}
                                />
                                <Button size={Button.Sizes.SMALL} onClick={handleScan} disabled={isScanning}>
                                    {isScanning ? "Scanning..." : "Scan"}
                                </Button>
                            </>
                        ) : null}
                        <ModalCloseButton onClick={props.onClose} />
                    </div>
                </div>

                <TabBar selectedItem={tab} onItemSelect={setTab} type="top">
                    <TabBar.Item id="YOUR_UPLOADS">Your Uploads</TabBar.Item>
                    <TabBar.Item id="ALL_UPLOADS">All Uploads</TabBar.Item>
                    <TabBar.Item id="CURRENT_CHANNEL">Current Channel</TabBar.Item>
                </TabBar>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {tab === 'YOUR_UPLOADS' ? (
                        uploads.length === 0 ? (
                            <Text variant="text-md/normal" color="text-muted" style={{ textAlign: "center" }}>
                                No active uploads.
                            </Text>
                        ) : uploads.map(s => <UploadRow key={s.id} session={s} />)
                    ) : (
                        filteredFiles.length === 0 ? (
                            <Text variant="text-md/normal" color="text-muted" style={{ textAlign: "center" }}>
                                No files found. {tab === 'CURRENT_CHANNEL' && "Try scanning!"}
                            </Text>
                        ) : filteredFiles.sort((a, b) => b.lastUpdated - a.lastUpdated).map(f => (
                            <DownloadRow key={f.id} session={f} />
                        ))
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
};