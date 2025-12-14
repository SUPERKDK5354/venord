import { ModalCloseButton, ModalContent, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Text, MessageActions, SelectedChannelStore, TextInput, useEffect, useRef, useState } from "@webpack/common";
import { UploadManager, UploadSession } from "./UploadManager";
import { ChunkManager, DetectedFileSession, handleFileMerge } from "./ChunkManager";
import * as webpack from "@webpack";
import { settings } from "./settings";

const UserStore = webpack.findByPropsLazy("getCurrentUser");

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

const SidebarItem = ({ label, selected, onClick }: { label: string, selected: boolean, onClick: () => void }) => (
    <div 
        onClick={onClick}
        style={{
            padding: '6px 10px',
            borderRadius: '4px',
            cursor: 'pointer',
            backgroundColor: selected ? 'var(--background-modifier-selected)' : 'transparent',
            color: selected ? 'var(--interactive-active)' : 'var(--interactive-normal)',
            fontWeight: selected ? 500 : 400
        }}
    >
        {label}
    </div>
);

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
        const chunks = ChunkManager.getChunks(session.id);
        if (chunks && chunks.length === session.totalChunks) {
            await handleFileMerge(chunks);
        } else {
            console.error("Missing chunks for download");
        }
        setIsMerging(false);
    };

    return (
        <div style={{
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

const DownloadRow = ({ session }: { session: DetectedFileSession }) => {
    // ... DownloadRow logic ...
    // Note: Re-implementing simplified to fit new layout
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
                        <div style={{ 
                            padding: "2px 6px", borderRadius: "4px", 
                            backgroundColor: dlState?.checksumResult === 'pass' ? "var(--background-message-hover)" : "var(--background-accent)",
                            color: dlState?.checksumResult === 'pass' ? "var(--text-positive)" : "var(--text-danger)",
                            fontSize: "12px", fontWeight: "bold"
                        }}>
                            {dlState?.checksumResult === 'pass' ? "Verified" : "Checksum Fail"}
                        </div>
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

export const UploadsDashboard = (props: any) => {
    const [tab, setTab] = useState("YOUR_UPLOADS");
    const [uploads, setUploads] = useState<UploadSession[]>([]);
    const [detectedFiles, setDetectedFiles] = useState<DetectedFileSession[]>([]);
    
    // Scanner
    const [scanLimit, setScanLimit] = useState("100");
    const [isScanning, setIsScanning] = useState(false);

    // Filters & Sort
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<"date" | "name" | "size">("date");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
    const [filterChannelId, setFilterChannelId] = useState("");
    const [filterUserId, setFilterUserId] = useState("");

    useEffect(() => {
        const updateUploads = () => setUploads(Array.from(UploadManager.sessions.values()));
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

    const currentChannelId = SelectedChannelStore.getChannelId();
    
    let displayList = [];
    if (tab === 'YOUR_UPLOADS') {
        displayList = uploads;
    } else {
        displayList = detectedFiles;
        if (tab === 'CURRENT_CHANNEL') {
            displayList = displayList.filter(f => f.channelId === currentChannelId);
        }
    }

    if (searchQuery) {
        displayList = displayList.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()));
    }

    if (filterChannelId && tab !== 'CURRENT_CHANNEL') {
        displayList = displayList.filter(f => f.channelId === filterChannelId);
    }
    if (filterUserId && tab !== 'YOUR_UPLOADS') {
        displayList = displayList.filter(f => (f as DetectedFileSession).uploader?.id === filterUserId);
    }

    // Sort
    displayList.sort((a, b) => {
        const dateA = (a as any).lastUpdated || (a as any).startTime || 0;
        const dateB = (b as any).lastUpdated || (b as any).startTime || 0;
        
        let res = 0;
        if (sortBy === 'date') res = dateB - dateA;
        if (sortBy === 'name') res = a.name.localeCompare(b.name);
        if (sortBy === 'size') res = b.size - a.size;
        
        return sortDirection === 'asc' ? -res : res;
    });

    return (
        <ModalRoot {...props} size={ModalSize.LARGE} style={{ height: "80vh", width: "80vw", maxHeight: "800px", maxWidth: "1000px" }}>
            <div style={{ display: 'flex', height: '100%', flexDirection: 'row' }}>
                {/* SIDEBAR */}
                <div style={{ 
                    width: '240px', 
                    backgroundColor: 'var(--background-secondary)', 
                    padding: '24px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    borderRight: '1px solid var(--background-modifier-accent)'
                }}>
                    <Text variant="heading-lg/extrabold" style={{ marginBottom: '16px', paddingLeft: '8px' }}>
                        File Splitter
                    </Text>
                    
                    <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '8px', paddingLeft: '8px' }}>Manager</Text>
                    <SidebarItem label="Your Uploads" selected={tab === 'YOUR_UPLOADS'} onClick={() => setTab('YOUR_UPLOADS')} />
                    <SidebarItem label="All Uploads" selected={tab === 'ALL_UPLOADS'} onClick={() => setTab('ALL_UPLOADS')} />
                    <SidebarItem label="Current Channel" selected={tab === 'CURRENT_CHANNEL'} onClick={() => setTab('CURRENT_CHANNEL')} />
                    
                    <div style={{ flexGrow: 1 }} />
                    
                    <div style={{ padding: '8px', backgroundColor: 'var(--background-tertiary)', borderRadius: '8px' }}>
                        <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>Actions</Text>
                        <input 
                            type="file" 
                            id="sidebar-upload-input"
                            style={{ display: 'none' }} 
                            onChange={(e) => {
                                if (e.target.files?.[0]) UploadManager.startUpload(e.target.files[0], settings.store.chunkSize || 9.5);
                                e.target.value = "";
                            }} 
                        />
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} style={{ width: '100%' }} onClick={() => document.getElementById('sidebar-upload-input')?.click()}>
                            New Upload
                        </Button>
                    </div>
                </div>

                {/* CONTENT AREA */}
                <div style={{ flex: 1, padding: '32px 40px', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--background-primary)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                        <Text variant="heading-xl/bold">{
                            tab === 'YOUR_UPLOADS' ? 'Your Uploads' :
                            tab === 'ALL_UPLOADS' ? 'All Uploads' : 'Current Channel'
                        }</Text>
                        <ModalCloseButton onClick={props.onClose} />
                    </div>

                    {/* TOOLBAR */}
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap', alignItems: "end" }}>
                        <div style={{ flexGrow: 1, minWidth: '200px' }}>
                            <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>Search</Text>
                            <TextInput 
                                placeholder="Filename..." 
                                value={searchQuery} 
                                onChange={setSearchQuery} 
                            />
                        </div>
                        
                        <div>
                            <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>Sort By</Text>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} onClick={() => setSortBy(sortBy === 'date' ? 'name' : sortBy === 'name' ? 'size' : 'date')}>
                                    {sortBy === 'date' ? 'Date' : sortBy === 'name' ? 'Name' : 'Size'}
                                </Button>
                                <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} onClick={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')}>
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                </Button>
                            </div>
                        </div>

                        {tab === 'CURRENT_CHANNEL' && (
                            <div>
                                <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>Scanner</Text>
                                <div style={{ display: 'flex', gap: '4px' }}>
                                    <TextInput 
                                        placeholder="100"
                                        value={scanLimit} 
                                        onChange={setScanLimit}
                                        style={{ width: "60px" }}
                                    />
                                    <Button size={Button.Sizes.SMALL} onClick={handleScan} disabled={isScanning}>
                                        {isScanning ? "..." : "Scan"}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* FILTERS ROW */}
                    {tab !== 'YOUR_UPLOADS' && (
                        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
                            <TextInput 
                                placeholder="Filter by User ID" 
                                value={filterUserId} 
                                onChange={setFilterUserId}
                                style={{ flex: 1 }}
                            />
                            {tab === 'ALL_UPLOADS' && (
                                <TextInput 
                                    placeholder="Filter by Channel ID" 
                                    value={filterChannelId} 
                                    onChange={setFilterChannelId}
                                    style={{ flex: 1 }}
                                />
                            )}
                        </div>
                    )}

                    {/* LIST */}
                    <div className="upload-list" style={{ overflowY: 'auto', flex: 1, paddingRight: '8px' }}>
                        {displayList.length === 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '40px', opacity: 0.5 }}>
                                <Text variant="heading-lg/semibold">No files found</Text>
                                <Text variant="text-md/normal">Try scanning or adjusting filters</Text>
                            </div>
                        ) : (
                            displayList.map((item: any) => (
                                tab === 'YOUR_UPLOADS' 
                                    ? <UploadRow key={item.id} session={item} />
                                    : <DownloadRow key={item.id} session={item} />
                            ))
                        )}
                    </div>
                </div>
            </div>
        </ModalRoot>
    );
};