import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { PromptSessionExtensionLike } from "../../config/index"

const noopFactory: ExtensionFactory = () => {}

/** P5-B: append execution-surface rules based on TCH_EXEC_SURFACE injected at solver launch. */
export function execSurfaceExtension(): PromptSessionExtensionLike {
    const surface = process.env.TCH_EXEC_SURFACE?.trim() || "remote-vps"
    if (surface !== "local-host") {
        return { factory: noopFactory }
    }
    return {
        factory: noopFactory,
        appendSystemPrompt: () =>
            [
                "## Local-host execution mode (TCH_EXEC_SURFACE=local-host)",
                "The operator configured authorized target commands to run on this control-plane host.",
                "You MAY use local `bash` with installed offensive tools (nmap, curl, ffuf, nuclei, …) when they can reach in-scope targets.",
                "kali-arsenal MCP remains available as a fallback. Never attack localhost, control-plane APIs, or the remote Kali admin host itself.",
                "Stay within the engagement scope file and task boundaries.",
            ].join("\n"),
    }
}
