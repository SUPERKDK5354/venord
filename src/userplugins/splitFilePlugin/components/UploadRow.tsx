import { Button, Text, MessageActions, useRef, useState } from "@webpack/common";
import { UploadManager, UploadSession } from "../UploadManager";
import { ChunkManager, handleFileMerge } from "../ChunkManager";

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

export const UploadRow = ({ session }: { session: UploadSession }) => {
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
        const sessionData = ChunkManager.getSession(session.id);
        const chunks = sessionData?.chunks;
        if (chunks && chunks.length === session.totalChunks) {
            await handleFileMerge(chunks);
        } else {
            console.error("Missing chunks for download");
        }
        setIsMerging(false);
    };

    return (
        <div className="vc-upload-row" style={{
            padding: "12px", marginBottom: "8px", backgroundColor: "var(--background-secondary)", borderRadius: "8px",
            border: "1px solid var(--background-modifier-accent)"
        }}>
            <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} />
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <Text 
                    variant="text-md/bold" 
                    style={{ 
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", 
                        cursor: session.lastMessageId ? "pointer" : "default",
                        textDecoration: session.lastMessageId ? "underline" : "none"
                    }}
                    onClick={handleJump}
                >
                    {session.name}
                </Text>
                <div style={{ display: "flex", gap: "8px" }}>
                    {isDone && (
                        <Button size={Button.Sizes.TINY} color={Button.Colors.BRAND} onClick={handleDownload} disabled={isMerging}>
                            {isMerging ? "Merging..." : "Download"}
                        </Button>
                    )}
                    {!isDone && (
                        <Button size={Button.Sizes.TINY} color={isPaused ? Button.Colors.GREEN : Button.Colors.YELLOW} onClick={() => isPaused ? handleResume() : UploadManager.pauseUpload(session.id)}>
                            {isPaused ? "Resume" : "Pause"}
                        </Button>
                    )}
                    <Button size={Button.Sizes.TINY} color={Button.Colors.RED} onClick={() => UploadManager.deleteUpload(session.id)}>
                        {isDone ? "Clear" : "Cancel"}
                    </Button>
                </div>
            </div>

            <div style={{ height: "6px", width: "100%", backgroundColor: "var(--background-tertiary)", borderRadius: "3px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${progress}%`, backgroundColor: "var(--brand-experiment)", transition: "width 0.2s" }} />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
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
