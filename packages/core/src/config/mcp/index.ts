import { readFileSync } from "fs"
import { writeFile } from "fs/promises"
import { resolve } from "path"
import type { ServerEntry, McpConfig, McpSettings } from "pi-mcp-adapter/types.js"
import {
    BUILTIN_MCP_SCRIPT_NAMES,
    containerMcpScriptPath,
    isContainerMcpScriptPath,
    isLegacyRepoMcpScriptPath,
    withHostResolvedMcpServer,
} from "./paths"
export {
    BUILTIN_MCP_SCRIPT_NAMES,
    SOLVER_MCP_MOUNT,
    containerMcpScriptPath,
    resolveRepoMcpDir,
    resolveMcpScriptPathForHost,
    withHostResolvedMcpServer,
} from "./paths"
import { loadMcpConfig } from "pi-mcp-adapter/config.js"
import { McpServerManager } from "pi-mcp-adapter/server-manager.js"
import { computeServerHash } from "pi-mcp-adapter/metadata-cache.js"

export interface McpServerItem {
    name: string
    server: ServerEntry
}

export interface McpToolCache {
    version: number
    servers: Record<string, McpServerCacheEntry>
}

export interface McpServerCacheEntry {
    configHash: string
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
    resources: Array<{ uri: string; name: string; description?: string }>
    cachedAt: number
}

// ── Cache ──

export function loadMcpToolCache(dir: string): McpToolCache | null {
    try {
        const text = readFileSync(resolve(dir, "mcp-cache.json"), "utf-8")
        const raw = JSON.parse(text)
        if (!raw?.servers || raw.version !== 1) return null
        return raw as McpToolCache
    } catch {
        return null
    }
}

export async function saveMcpToolCache(dir: string, cache: McpToolCache) {
    await writeFile(resolve(dir, "mcp-cache.json"), JSON.stringify(cache, null, 2))
}

// ── mcp.json CRUD ──

export function mcpJsonPath(dir: string) {
    return resolve(dir, "mcp.json")
}

export function getMcpConfig(dir: string): McpConfig {
    return loadMcpConfig(mcpJsonPath(dir))
}

/**
 * Default config for the built-in MCP servers. Seeded into mcp.json on first
 * startup so a fresh clone ships with the solver attack tools (kali-arsenal)
 * and vulnerability intel (vuln-intel) out of the box, no manual entry needed.
 *
 * - command/args use `/opt/tch-mcp/*.py` (bind-mounted from the repo `mcp/` tree in Docker solvers).
 *   Host-side probe resolves those paths back to the repo checkout.
 * - env left as empty placeholders: SSH credentials and API keys are filled in by
 *   the user under Config → MCP (no credentials are ever bundled).
 * - Only missing entries are seeded; existing ones (already configured by the user /
 *   already populated with credentials) are never touched.
 */
function builtinMcpServers(): Record<string, ServerEntry> {
    return {
        "kali-arsenal": {
            command: "python3",
            args: [containerMcpScriptPath("ssh_mcp.py")],
            env: { SSH_HOST: "", SSH_PORT: "22", SSH_USER: "root", SSH_PASS: "", SSH_ALIAS: "" },
            lifecycle: "keep-alive",
        },
        "vuln-intel": {
            command: "python3",
            args: [containerMcpScriptPath("vuln_intel_mcp.py")],
            env: { NVD_API_KEY: "", GITHUB_TOKEN: "" },
            lifecycle: "keep-alive",
        },
    }
}

/** Rewrite legacy host checkout paths to the solver mount (preserves env / credentials). */
export async function migrateMcpPathsToContainerMount(dir: string) {
    const config = getMcpConfig(dir)
    let changed = false
    for (const server of Object.values(config.mcpServers)) {
        const arg0 = server.args?.[0]
        if (typeof arg0 !== "string") continue
        const scriptName = BUILTIN_MCP_SCRIPT_NAMES.find(
            (name) => arg0.endsWith(`/${name}`) && (isLegacyRepoMcpScriptPath(arg0) || isContainerMcpScriptPath(arg0)),
        )
        if (!scriptName) continue
        const next = containerMcpScriptPath(scriptName)
        if (arg0 === next) continue
        server.args = [next, ...(server.args?.slice(1) ?? [])]
        changed = true
    }
    if (changed) await writeMcpConfig(dir, config)
}

/** Seed the built-in MCP servers on first startup (only fills in what's missing, never overwrites the user's existing config/credentials). */
export async function initBuiltinMcpServers(dir: string) {
    const config = getMcpConfig(dir)
    let changed = false
    for (const [name, server] of Object.entries(builtinMcpServers())) {
        if (name in config.mcpServers) continue // already exists (including user-supplied credentials) → never overwrite
        config.mcpServers[name] = server
        changed = true
    }
    if (changed) await writeMcpConfig(dir, config)
    await migrateMcpPathsToContainerMount(dir)
}

async function writeMcpConfig(dir: string, config: McpConfig) {
    await Bun.write(mcpJsonPath(dir), JSON.stringify(config, null, 2))
}

export function listMcpServers(dir: string): McpServerItem[] {
    const config = getMcpConfig(dir)
    return Object.entries(config.mcpServers).map(([name, server]) => ({ name, server }))
}

export async function addMcpServer(dir: string, name: string, server: ServerEntry) {
    const config = getMcpConfig(dir)
    config.mcpServers[name] = server
    await writeMcpConfig(dir, config)
}

export async function removeMcpServer(dir: string, name: string) {
    const config = getMcpConfig(dir)
    delete config.mcpServers[name]
    await writeMcpConfig(dir, config)
}

export async function updateMcpServer(dir: string, name: string, patch: Partial<ServerEntry>) {
    const config = getMcpConfig(dir)
    const existing = config.mcpServers[name]
    if (!existing) return
    config.mcpServers[name] = { ...existing, ...patch }
    await writeMcpConfig(dir, config)
}

export async function renameMcpServer(dir: string, oldName: string, newName: string) {
    const config = getMcpConfig(dir)
    const entry = config.mcpServers[oldName]
    if (!entry) return
    delete config.mcpServers[oldName]
    config.mcpServers[newName] = entry
    await writeMcpConfig(dir, config)
}

export function getMcpSettings(dir: string): McpSettings | undefined {
    return getMcpConfig(dir).settings
}

export async function setMcpSettings(dir: string, settings: McpSettings) {
    const config = getMcpConfig(dir)
    config.settings = settings
    await writeMcpConfig(dir, config)
}

// ── Probe (connect to a server and discover its tools) ──

export interface ProbeResult {
    server: string
    tools: McpServerCacheEntry["tools"]
    resources: McpServerCacheEntry["resources"]
}

export async function probeMcpServerDefinition(serverName: string, definition: ServerEntry): Promise<ProbeResult> {
    const manager = new McpServerManager()
    const resolved = withHostResolvedMcpServer(definition)
    try {
        const connection = await manager.connect(serverName, resolved)
        const tools = connection.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }))
        const resources = connection.resources.map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
        }))

        return { server: serverName, tools, resources }
    } finally {
        await manager.closeAll()
    }
}

/** Connect to a single MCP server, discover its tools and resources, and update the cache */
export async function probeMcpServer(dir: string, serverName: string): Promise<ProbeResult> {
    const config = getMcpConfig(dir)
    const definition = config.mcpServers[serverName]
    if (!definition) throw new Error(`MCP server "${serverName}" not found`)

    const result = await probeMcpServerDefinition(serverName, definition)

    // Update the cache
    const cache = loadMcpToolCache(dir) ?? { version: 1, servers: {} }
    cache.servers[serverName] = {
        configHash: computeServerHash(definition),
        tools: result.tools,
        resources: result.resources,
        cachedAt: Date.now(),
    }
    await saveMcpToolCache(dir, cache)

    return result
}

/** Connect to all configured MCP servers, discover their tools and resources, and update the cache */
export async function probeAllMcpServers(dir: string): Promise<ProbeResult[]> {
    const config = getMcpConfig(dir)
    const names = Object.keys(config.mcpServers)
    const results: ProbeResult[] = []

    for (const name of names) {
        try {
            results.push(await probeMcpServer(dir, name))
        } catch {
            // Skip on connection failure, doesn't affect other servers
        }
    }

    return results
}
