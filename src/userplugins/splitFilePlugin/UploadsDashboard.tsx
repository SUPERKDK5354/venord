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
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                    <Text variant="heading-xl/bold">{
                        tab === 'YOUR_UPLOADS' ? 'Your Uploads' :
                        tab === 'ALL_UPLOADS' ? 'All Uploads' : 'Current Channel'
                    }</Text>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <Button size={Button.Sizes.SMALL} look={Button.Looks.BLANK} onClick={() => { ChunkManager.emitChange(); UploadManager.emitChange(); }}>
                            Refresh
                        </Button>
                        <ModalCloseButton onClick={props.onClose} />
                    </div>
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
                    <div className="upload-list" key={tab} style={{ overflowY: 'auto', flex: 1, paddingRight: '8px' }}>
                        {displayList.length === 0 ? (
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
                        )}
                    </div>
                </div>
            </div>
        </ModalRoot>
    );
};
