import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { ServerEntry } from "pi-mcp-adapter/types.js"

/** Bind-mount target inside Docker solvers (see runtime.ts). */
export const SOLVER_MCP_MOUNT = "/opt/tch-mcp"

export const BUILTIN_MCP_SCRIPT_NAMES = ["ssh_mcp.py", "vuln_intel_mcp.py"] as const

/** Repo-root `mcp/` directory (vendored Python MCP scripts). */
export function resolveRepoMcpDir(): string {
    return resolve(import.meta.dir, "../../../../../mcp")
}

export function containerMcpScriptPath(scriptName: string): string {
    return resolve(SOLVER_MCP_MOUNT, scriptName)
}

/** Legacy seed paths or any checkout-specific absolute path under `.../mcp/<script>`. */
export function isLegacyRepoMcpScriptPath(scriptPath: string): boolean {
    const base = basename(scriptPath)
    return (
        (BUILTIN_MCP_SCRIPT_NAMES as readonly string[]).includes(base) &&
        scriptPath.includes("/mcp/")
    )
}

export function isContainerMcpScriptPath(scriptPath: string): boolean {
    return BUILTIN_MCP_SCRIPT_NAMES.some((name) => scriptPath === containerMcpScriptPath(name))
}

/** Map container mount paths to the repo tree when probing MCP on the host. */
export function resolveMcpScriptPathForHost(scriptPath: string): string {
    if (!isContainerMcpScriptPath(scriptPath)) return scriptPath
    const name = basename(scriptPath)
    const hostPath = resolve(resolveRepoMcpDir(), name)
    return existsSync(hostPath) ? hostPath : scriptPath
}

export function withHostResolvedMcpServer(server: ServerEntry): ServerEntry {
    const args = server.args
    if (!args?.length) return server
    const resolved = args.map((a) => (typeof a === "string" ? resolveMcpScriptPathForHost(a) : a))
    if (resolved.every((a, i) => a === args[i])) return server
    return { ...server, args: resolved }
}
