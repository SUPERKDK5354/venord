import { ModalCloseButton, ModalContent, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Text, MessageActions, SelectedChannelStore, TextInput, useEffect, useRef, useState } from "@webpack/common";
import { UploadManager, UploadSession } from "./UploadManager";
import { ChunkManager, DetectedFileSession } from "./ChunkManager";
import { DownloadManager } from "./DownloadManager";
import { settings } from "./settings";
import { UploadRow } from "./components/UploadRow";
import { DownloadRow } from "./components/DownloadRow";

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

export const UploadsDashboard = (props: { initialTab?: string } & any) => {
    // Use the settings.use() hook to ensure re-renders when settings change
    const pluginSettings = settings.use(); 
    
    const [tab, setTab] = useState(props.initialTab || "YOUR_UPLOADS");
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
        // Use ID (timestamp) for date sorting
        const dateA = a.id;
        const dateB = b.id;
        
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
                    <SidebarItem label="Activity" selected={tab === 'ACTIVITY'} onClick={() => setTab('ACTIVITY')} />
                    <SidebarItem label="Your Uploads" selected={tab === 'YOUR_UPLOADS'} onClick={() => setTab('YOUR_UPLOADS')} />
                    <SidebarItem label="All Uploads" selected={tab === 'ALL_UPLOADS'} onClick={() => setTab('ALL_UPLOADS')} />
                    <SidebarItem label="Current Channel" selected={tab === 'CURRENT_CHANNEL'} onClick={() => setTab('CURRENT_CHANNEL')} />
                    <SidebarItem label="Settings" selected={tab === 'SETTINGS'} onClick={() => setTab('SETTINGS')} />
                    
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
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                    <Text variant="heading-xl/bold">{
                        tab === 'ACTIVITY' ? 'Ongoing Activity' :
                        tab === 'YOUR_UPLOADS' ? 'Your Uploads' :
                        tab === 'ALL_UPLOADS' ? 'All Uploads' :
                        tab === 'SETTINGS' ? 'Settings' : 'Current Channel'
                    }</Text>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.BLANK} onClick={() => { ChunkManager.emitChange(); UploadManager.emitChange(); }}>
                            Refresh
                        </Button>
                        <ModalCloseButton onClick={props.onClose} />
                    </div>
                </div>

                    {tab === 'SETTINGS' ? (
                        <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '24px', overflowY: 'auto' }}>
                            <div style={{ padding: '16px', backgroundColor: 'var(--background-secondary)', borderRadius: '8px' }}>
                                <Text variant="heading-md/bold" style={{ marginBottom: '8px' }}>Performance & Safety</Text>
                                
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <div>
                                        <Text variant="text-md/semibold">Parallel Uploading</Text>
                                        <Text variant="text-xs/normal" color="text-muted">Simultaneous uploads increase speed but risk rate limits.</Text>
                                    </div>
                                    <input 
                                        type="checkbox" 
                                        checked={settings.store.parallelUploads} 
                                        onChange={() => settings.store.parallelUploads = !settings.store.parallelUploads} 
                                        style={{ transform: 'scale(1.5)' }}
                                    />
                                </div>

                                {settings.store.parallelUploads && (
                                    <div style={{ marginBottom: '16px' }}>
                                        <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>
                                            Worker Count ({settings.store.parallelCount || 2})
                                        </Text>
                                        <input 
                                            type="range" 
                                            min="2" max="5" 
                                            value={settings.store.parallelCount || 2} 
                                            onChange={(e) => settings.store.parallelCount = parseInt(e.target.value)}
                                            style={{ width: '100%' }}
                                        />
                                    </div>
                                )}

                                <div style={{ marginBottom: '16px' }}>
                                    <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>
                                        Base Delay ({settings.store.baseDelay || 1500}ms)
                                    </Text>
                                    <input 
                                        type="range" 
                                        min="500" max="5000" step="100"
                                        value={settings.store.baseDelay || 1500} 
                                        onChange={(e) => settings.store.baseDelay = parseInt(e.target.value)}
                                        style={{ width: '100%' }}
                                    />
                                </div>

                                <div style={{ marginBottom: '16px' }}>
                                    <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>
                                        Random Jitter ({settings.store.jitter || 1000}ms)
                                    </Text>
                                    <Text variant="text-xs/normal" color="text-muted" style={{ marginBottom: '8px' }}>
                                        Adds 0-{settings.store.jitter || 1000}ms random delay to mimic human behavior.
                                    </Text>
                                    <input 
                                        type="range" 
                                        min="0" max="3000" step="100"
                                        value={settings.store.jitter || 1000} 
                                        onChange={(e) => settings.store.jitter = parseInt(e.target.value)}
                                        style={{ width: '100%' }}
                                    />
                                </div>
                            </div>

                            <div style={{ padding: '16px', backgroundColor: 'var(--background-secondary)', borderRadius: '8px' }}>
                                <Text variant="heading-md/bold" style={{ marginBottom: '8px' }}>Downloads</Text>
                                
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <div>
                                        <Text variant="text-md/semibold">Parallel Downloading</Text>
                                        <Text variant="text-xs/normal" color="text-muted">Download multiple chunks simultaneously.</Text>
                                    </div>
                                    <input 
                                        type="checkbox" 
                                        checked={settings.store.parallelDownloading ?? true} 
                                        onChange={() => settings.store.parallelDownloading = !settings.store.parallelDownloading} 
                                        style={{ transform: 'scale(1.5)' }}
                                    />
                                </div>

                                {settings.store.parallelDownloading !== false && (
                                    <div style={{ marginBottom: '16px' }}>
                                        <Text variant="eyebrow" color="text-muted" style={{ marginBottom: '4px' }}>
                                            Download Workers ({settings.store.downloadWorkers || 3})
                                        </Text>
                                        <input 
                                            type="range" 
                                            min="2" max="10" 
                                            value={settings.store.downloadWorkers || 3} 
                                            onChange={(e) => settings.store.downloadWorkers = parseInt(e.target.value)}
                                            style={{ width: '100%' }}
                                        />
                                    </div>
                                )}
                            </div>

                            <div style={{ padding: '16px', backgroundColor: 'var(--background-secondary)', borderRadius: '8px' }}>
                                <Text variant="heading-md/bold" style={{ marginBottom: '8px' }}>Core</Text>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <div>
                                        <Text variant="text-md/semibold">Bypass 500MB Limit</Text>
                                        <Text variant="text-xs/normal" color="text-muted">Allow selecting files larger than 500MB.</Text>
                                    </div>
                                    <input 
                                        type="checkbox" 
                                        checked={settings.store.bypassLimit} 
                                        onChange={() => settings.store.bypassLimit = !settings.store.bypassLimit} 
                                        style={{ transform: 'scale(1.5)' }}
                                    />
                                </div>
                                <div style={{ marginBottom: '16px' }}>
                                    <Text variant="text-md/semibold" style={{ marginBottom: '8px' }}>Chunk Size</Text>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        {[9.5, 49, 99, 499].map(size => (
                                            <Button 
                                                key={size}
                                                size={Button.Sizes.SMALL} 
                                                look={settings.store.chunkSize === size ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                                color={settings.store.chunkSize === size ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                                onClick={() => settings.store.chunkSize = size}
                                            >
                                                {size} MB
                                            </Button>
                                        ))}
                                    </div>
                                    <Text variant="text-xs/normal" color="text-muted" style={{ marginTop: '8px' }}>Files are split into chunks of this size (MB).</Text>
                                </div>
                            </div>
                        </div>
                    ) : (
                    <>
                    {/* TOOLBAR */}
                    {tab !== 'ACTIVITY' && (
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
                    )}

                    {/* FILTERS ROW */}
                    {tab !== 'YOUR_UPLOADS' && tab !== 'ACTIVITY' && (
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
                    <div className="upload-list" key={tab} style={{ overflowY: 'auto', flex: 1, paddingRight: '8px' }}>
                        {tab === 'ACTIVITY' ? (
                            <>
                                {uploads.filter(u => u.status === 'uploading' || u.status === 'pending' || u.status === 'paused').length > 0 && (
                                    <div style={{ marginBottom: '24px' }}>
                                        <Text variant="heading-sm/bold" style={{ marginBottom: '8px', opacity: 0.8 }}>Active Uploads</Text>
                                        {uploads.filter(u => u.status === 'uploading' || u.status === 'pending' || u.status === 'paused').map(item => (
                                            <UploadRow key={`up-${item.id}`} session={item} />
                                        ))}
                                    </div>
                                )}
                                
                                {detectedFiles.filter(f => {
                                    const dl = DownloadManager.downloads.get(f.id);
                                    return dl && (dl.status === 'downloading' || dl.status === 'merging' || dl.status === 'pending' || dl.status === 'paused');
                                }).length > 0 && (
                                    <div style={{ marginBottom: '24px' }}>
                                        <Text variant="heading-sm/bold" style={{ marginBottom: '8px', opacity: 0.8 }}>Active Downloads</Text>
                                        {detectedFiles.filter(f => {
                                            const dl = DownloadManager.downloads.get(f.id);
                                            return dl && (dl.status === 'downloading' || dl.status === 'merging' || dl.status === 'pending' || dl.status === 'paused');
                                        }).map(item => (
                                            <DownloadRow key={`dl-${item.id}`} session={item} />
                                        ))}
                                    </div>
                                )}

                                {detectedFiles.filter(f => DownloadManager.activeRepairs.has(f.id)).length > 0 && (
                                    <div style={{ marginBottom: '24px' }}>
                                        <Text variant="heading-sm/bold" style={{ marginBottom: '8px', opacity: 0.8 }}>Active Repairs</Text>
                                        {detectedFiles.filter(f => DownloadManager.activeRepairs.has(f.id)).map(item => (
                                            <DownloadRow key={`rep-${item.id}`} session={item} />
                                        ))}
                                    </div>
                                )}

                                {uploads.filter(u => u.status === 'uploading' || u.status === 'pending' || u.status === 'paused').length === 0 &&
                                 detectedFiles.filter(f => {
                                     const dl = DownloadManager.downloads.get(f.id);
                                     return dl && (dl.status === 'downloading' || dl.status === 'merging' || dl.status === 'pending' || dl.status === 'paused');
                                 }).length === 0 &&
                                 detectedFiles.filter(f => DownloadManager.activeRepairs.has(f.id)).length === 0 && (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '40px', opacity: 0.5 }}>
                                        <Text variant="heading-lg/semibold">No active tasks</Text>
                                        <Text variant="text-md/normal">Relax, everything is quiet.</Text>
                                    </div>
                                )}
                            </>
                        ) : (
                            displayList.length === 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '40px', opacity: 0.5 }}>
                                    <Text variant="heading-lg/semibold">No files found</Text>
                                    <Text variant="text-md/normal">Try scanning or adjusting filters</Text>
                                </div>
                            ) : (
                                displayList.map((item: any) => (
                                    tab === 'YOUR_UPLOADS' 
                                        ? <UploadRow key={`up-${item.id}`} session={item} />
                                        : <DownloadRow key={`dl-${item.id}`} session={item} />
                                ))
                            )
                        )}
                    </div>
                    </>
                    )}
                </div>
            </div>
        </ModalRoot>
    );
};
