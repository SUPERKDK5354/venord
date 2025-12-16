import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    bypassLimit: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Allow uploading files larger than 500MB (Bypasses Discord limit via splitting)",
    },
    chunkSize: {
        type: OptionType.NUMBER,
        default: 9.5,
        description: "Chunk Size (MB)",
    },
    // Hidden store for pending uploads persistence
    pendingUploads: {
        type: OptionType.STRING,
        default: "{}",
        hidden: true // Hide from settings panel now that we have a GUI
    },
    parallelUploads: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Enable Parallel Uploading (Warning: Higher risk of rate limits)",
    },
    parallelCount: {
        type: OptionType.NUMBER,
        default: 2,
        description: "Number of parallel uploads (Max 5 recommended)",
    },
    parallelDownloading: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Enable Parallel Downloading",
    },
    downloadWorkers: {
        type: OptionType.NUMBER,
        default: 3,
        description: "Number of parallel download streams (Max 5 recommended)",
    },
    // Advanced / Dynamic
    enableDynamicMode: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Dynamically adjust workers based on performance (Experimental)",
    },
    safeMode: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Anti-Logout: Automatically pause on rate limits to prevent bans",
    },
    safeModeCooldown: {
        type: OptionType.NUMBER,
        default: 60,
        description: "Seconds to wait before resuming after a rate limit hit",
    },
    baseDelay: {
        type: OptionType.NUMBER,
        default: 1500,
        description: "Base Delay between uploads (ms)",
    },
    jitter: {
        type: OptionType.NUMBER,
        default: 1000,
        description: "Random Jitter added to delay (ms)",
    }
});
