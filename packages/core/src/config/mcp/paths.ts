import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { ServerEntry } from "pi-mcp-adapter/types.js"

/** Bind-mount target inside Docker solvers (see runtime.ts). */
export const SOLVER_MCP_MOUNT = "/opt/tch-mcp"

/** Host-side MCP script directory (repo checkout or `~/.tch-agent/config/mcp` after release extract). */
export const TCH_MCP_DIR_ENV = "TCH_MCP_DIR"

export const BUILTIN_MCP_SCRIPT_NAMES = ["ssh_mcp.py", "vuln_intel_mcp.py"] as const

/** Repo-root `mcp/` directory (vendored Python MCP scripts). */
export function getRepoMcpDir(): string {
    return resolve(import.meta.dir, "../../../../../mcp")
}

/** @deprecated Use {@link getRepoMcpDir} */
export function resolveRepoMcpDir(): string {
    return getRepoMcpDir()
}

/** Resolve MCP scripts for host probe / local solver (repo tree → config dir → env). */
export function resolveMcpDir(configDir: string): string {
    const repoDir = getRepoMcpDir()
    if (existsSync(resolve(repoDir, "ssh_mcp.py"))) return repoDir
    const configMcp = resolve(configDir, "mcp")
    if (existsSync(resolve(configMcp, "ssh_mcp.py"))) return configMcp
    const fromEnv = process.env[TCH_MCP_DIR_ENV]?.trim()
    if (fromEnv) return fromEnv
    return configMcp
}

export function applyMcpDirEnv(configDir: string): string {
    const dir = resolveMcpDir(configDir)
    process.env[TCH_MCP_DIR_ENV] = dir
    return dir
}

export function containerMcpScriptPath(scriptName: string): string {
    return resolve(SOLVER_MCP_MOUNT, scriptName)
}

export function isSolverMcpMountAvailable(): boolean {
    return existsSync(containerMcpScriptPath("ssh_mcp.py"))
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

/** Map container mount paths to the host tree when probing MCP on the host or running local solvers. */
export function resolveMcpScriptPathForHost(scriptPath: string, configDir?: string): string {
    if (!isContainerMcpScriptPath(scriptPath)) return scriptPath
    const name = basename(scriptPath)
    const mcpDir = configDir ? resolveMcpDir(configDir) : resolveMcpDirFromEnvOrRepo()
    const hostPath = resolve(mcpDir, name)
    return existsSync(hostPath) ? hostPath : scriptPath
}

function resolveMcpDirFromEnvOrRepo(): string {
    const fromEnv = process.env[TCH_MCP_DIR_ENV]?.trim()
    if (fromEnv) return fromEnv
    return getRepoMcpDir()
}

export function withHostResolvedMcpServer(server: ServerEntry, configDir?: string): ServerEntry {
    const args = server.args
    if (!args?.length) return server
    const resolved = args.map((a) => (typeof a === "string" ? resolveMcpScriptPathForHost(a, configDir) : a))
    if (resolved.every((a, i) => a === args[i])) return server
    return { ...server, args: resolved }
}
