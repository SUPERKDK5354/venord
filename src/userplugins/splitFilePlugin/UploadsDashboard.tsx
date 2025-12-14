import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Text, useEffect, useRef, useState } from "@webpack/common";
import { UploadManager, UploadSession } from "./UploadManager";

// Helper for formatting bytes
const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1000;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

// Helper for formatting time
const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return "--";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    return `${m}m ${Math.ceil(seconds % 60)}s`;
};

const UploadRow = ({ session }: { session: UploadSession }) => {
    const progress = Math.round((session.completedIndices.size / session.totalChunks) * 100);
    const isPaused = session.status === 'paused' || session.status === 'pending'; // Treat pending as paused for UI
    const isError = session.status === 'error';
    const isDone = session.status === 'completed';
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleResume = () => {
        if (!session.file) {
            // Need to re-select file
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

    return (
        <div style={{
            display: "flex",
            flexDirection: "column",
            padding: "8px",
            marginBottom: "8px",
            backgroundColor: "var(--background-secondary)",
            borderRadius: "4px"
        }}>
            <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                onChange={handleFileSelect} 
            />
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <Text variant="text-md/bold" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {session.name}
                </Text>
                <div style={{ display: "flex", gap: "8px" }}>
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

            {/* Progress Bar */}
            <div style={{ height: "8px", width: "100%", backgroundColor: "var(--background-tertiary)", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ 
                    height: "100%", 
                    width: `${progress}%`, 
                    backgroundColor: isError ? "var(--text-danger)" : isDone ? "var(--text-positive)" : "var(--brand-experiment)",
                    transition: "width 0.2s ease" 
                }} />
            </div>

            {/* Stats */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px" }}>
                <Text variant="text-xs/normal" color="text-muted">
                    {progress}% • {formatSize(session.completedIndices.size * session.chunkSize)} / {formatSize(session.size)}
                </Text>
                {!isDone && !isPaused && !isError && (
                    <Text variant="text-xs/normal" color="text-muted">
                        {formatSize(session.speed)}/s • {formatTime(session.etr)} left
                    </Text>
                )}
                {isPaused && <Text variant="text-xs/normal" color="text-warning">
                    {session.file ? "Paused" : "Paused (Select file to resume)"}
                </Text>}
                {isDone && <Text variant="text-xs/normal" color="text-positive">Completed</Text>}
                {isError && <Text variant="text-xs/normal" color="text-danger">{session.error || "Error"}</Text>}
            </div>
        </div>
    );
};

export const UploadsDashboard = (props: any) => {
    const [sessions, setSessions] = useState<UploadSession[]>([]);

    useEffect(() => {
        const update = () => {
            setSessions(Array.from(UploadManager.sessions.values()).sort((a, b) => b.id - a.id));
        };
        update(); // Initial
        return UploadManager.addListener(update);
    }, []);

    return (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/bold">Upload Manager</Text>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {sessions.length === 0 ? (
                        <Text variant="text-md/normal" color="text-muted" style={{ textAlign: "center" }}>
                            No active uploads.
                        </Text>
                    ) : (
                        sessions.map(s => <UploadRow key={s.id} session={s} />)
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
};