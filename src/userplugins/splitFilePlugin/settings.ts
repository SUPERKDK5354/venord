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
    }
});
