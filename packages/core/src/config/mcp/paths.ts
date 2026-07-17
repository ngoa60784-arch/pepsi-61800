import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, delimiter, posix, resolve } from "node:path"
import type { ServerEntry } from "pi-mcp-adapter/types.js"

/** Bind-mount target inside Docker solvers (see runtime.ts). */
export const SOLVER_MCP_MOUNT = "/opt/tch-mcp"

/** Host-side MCP script directory (repo checkout or `~/.tch-agent/config/mcp` after release extract). */
export const TCH_MCP_DIR_ENV = "TCH_MCP_DIR"

/** Optional override for the dedicated Python virtualenv that hosts the built-in MCP deps. */
export const TCH_MCP_VENV_ENV = "TCH_MCP_VENV"

export const BUILTIN_MCP_SCRIPT_NAMES = ["ssh_mcp.py", "vuln_intel_mcp.py"] as const

const PYTHON_COMMAND_NAMES = ["python", "python3", "python.exe", "python3.exe"]

/** Directory of the dedicated tch-agent virtualenv (env override or `~/.tch-agent/venv`). */
export function resolveMcpVenvDir(): string {
    const override = process.env[TCH_MCP_VENV_ENV]?.trim()
    if (override) return override
    return resolve(homedir(), ".tch-agent", "venv")
}

/** Path to the interpreter inside {@link resolveMcpVenvDir}, if the venv has been created. */
export function resolveMcpVenvPython(platform = process.platform): string | undefined {
    const venvDir = resolveMcpVenvDir()
    const candidate =
        platform === "win32" ? resolve(venvDir, "Scripts", "python.exe") : resolve(venvDir, "bin", "python")
    return existsSync(candidate) ? candidate : undefined
}

/**
 * Resolve the seeded Linux-style `python3` command to a concrete interpreter:
 * explicit `TCH_PYTHON_COMMAND` → dedicated tch-agent venv → installed Windows interpreter → original.
 * The venv step lets PEP 668 externally-managed hosts (Kali/Debian) run the built-in MCP servers
 * without polluting system Python.
 */
export function resolvePythonCommandForHost(command: string, platform = process.platform): string {
    if (!PYTHON_COMMAND_NAMES.includes(command.toLowerCase())) return command

    const configured = process.env.TCH_PYTHON_COMMAND?.trim()
    if (configured && existsSync(configured)) return configured

    const venvPython = resolveMcpVenvPython(platform)
    if (venvPython) return venvPython

    if (platform !== "win32") return command

    const pathCandidates = (process.env.PATH ?? "")
        .split(delimiter)
        .flatMap((dir) => [resolve(dir, "python3.exe"), resolve(dir, "python.exe")])
    const localPrograms = process.env.LOCALAPPDATA
        ? resolve(process.env.LOCALAPPDATA, "Programs", "Python")
        : ""
    const installedCandidates: string[] = []
    if (localPrograms && existsSync(localPrograms)) {
        try {
            for (const entry of readdirSync(localPrograms, { withFileTypes: true }).sort((left, right) => right.name.localeCompare(left.name))) {
                if (entry.isDirectory()) installedCandidates.push(resolve(localPrograms, entry.name, "python.exe"))
            }
        } catch {
            // Fall through to PATH or the original command.
        }
    }
    return [...pathCandidates, ...installedCandidates].find((candidate) => existsSync(candidate)) ?? command
}

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
    const pythonCommand = resolvePythonCommandForHost("python3")
    if (pythonCommand !== "python3") process.env.TCH_PYTHON_COMMAND = pythonCommand
    return dir
}

export function containerMcpScriptPath(scriptName: string): string {
    return posix.join(SOLVER_MCP_MOUNT, scriptName)
}

export function isSolverMcpMountAvailable(): boolean {
    return existsSync(containerMcpScriptPath("ssh_mcp.py"))
}

/** Legacy seed paths or any checkout-specific absolute path under `.../mcp/<script>`. */
export function isLegacyRepoMcpScriptPath(scriptPath: string): boolean {
    const base = basename(scriptPath)
    const normalized = scriptPath.replaceAll("\\", "/")
    return (
        (BUILTIN_MCP_SCRIPT_NAMES as readonly string[]).includes(base) &&
        normalized.includes("/mcp/")
    )
}

export function isContainerMcpScriptPath(scriptPath: string): boolean {
    const normalized = scriptPath.replaceAll("\\", "/")
    return BUILTIN_MCP_SCRIPT_NAMES.some(
        (name) =>
            normalized === containerMcpScriptPath(name) ||
            (/^[a-zA-Z]:\/opt\/tch-mcp\//.test(normalized) && normalized.endsWith(`/${name}`)),
    )
}

/** Map container mount paths to the host tree when probing MCP on the host or running local solvers. */
export function resolveMcpScriptPathForHost(scriptPath: string, configDir?: string): string {
    if (!isContainerMcpScriptPath(scriptPath)) return scriptPath
    const name = basename(scriptPath)
    const mcpDir = configDir ? resolveMcpDir(configDir) : resolveMcpDirFromEnvOrRepo()
    const hostPath = resolve(mcpDir, name).replaceAll("\\", "/")
    return existsSync(hostPath) ? hostPath : scriptPath
}

function resolveMcpDirFromEnvOrRepo(): string {
    const fromEnv = process.env[TCH_MCP_DIR_ENV]?.trim()
    if (fromEnv) return fromEnv
    return getRepoMcpDir()
}

export function withHostResolvedMcpServer(server: ServerEntry, configDir?: string): ServerEntry {
    const args = server.args
    const command = typeof server.command === "string" ? resolvePythonCommandForHost(server.command) : undefined
    if (!args?.length) return command === server.command ? server : { ...server, ...(command ? { command } : {}) }
    const resolved = args.map((a) => (typeof a === "string" ? resolveMcpScriptPathForHost(a, configDir) : a))
    if (command === server.command && resolved.every((a, i) => a === args[i])) return server
    return { ...server, ...(command ? { command } : {}), args: resolved }
}
