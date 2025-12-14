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

export const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    const [dlState, setDlState] = useState<DownloadState | undefined>(DownloadManager.downloads.get(session.id));
    
    useEffect(() => {
        return DownloadManager.addListener(() => {
            setDlState(DownloadManager.downloads.get(session.id));
        });
    }, [session.id]);

    const isDownloading = dlState && dlState.status === 'downloading';
    const isDone = dlState && dlState.status === 'completed';
    const progress = dlState ? Math.round((dlState.bytesDownloaded / dlState.totalBytes) * 100) : 0;

    return (
        <div style={{
            padding: "12px", marginBottom: "8px", backgroundColor: "var(--background-secondary)", borderRadius: "8px",
            border: "1px solid var(--background-modifier-accent)"
        }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
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
                    {(isDownloading || dlState?.status === 'paused') && (
                        <Button size={Button.Sizes.TINY} color={Button.Colors.RED} onClick={() => DownloadManager.cancelDownload(session.id)}>
                            Cancel
                        </Button>
                    )}
                </div>
            </div>

            {dlState && (
                <div style={{ height: "6px", width: "100%", backgroundColor: "var(--background-tertiary)", borderRadius: "3px", overflow: "hidden", marginBottom: "6px" }}>
                    <div style={{ height: "100%", width: `${progress}%`, backgroundColor: isDone ? "var(--text-positive)" : "var(--brand-experiment)", transition: "width 0.2s" }} />
                </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    {session.uploader && <UserLink user={session.uploader} />}
                    <Text variant="text-xs/normal" color="text-muted">{formatSize(session.size)}</Text>
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
