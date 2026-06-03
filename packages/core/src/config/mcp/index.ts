import { resolve } from "path"
import { readFileSync } from "fs"
import { writeFile } from "fs/promises"
import type { ServerEntry, McpConfig, McpSettings } from "pi-mcp-adapter/types.js"
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
 * 内置 MCP server 默认配置。首次启动时 seed 进 mcp.json，让 clone 下来开箱即有
 * solver 攻击工具（kali-arsenal）和漏洞情报（vuln-intel），不必手填。
 *
 * - command/args 指向仓库内 vendor 的脚本（mcp/ 目录），绝对路径在 seed 时按本模块
 *   位置解析（主部署形态是从仓库源码树跑 bun run web）。
 * - env 留空占位：SSH 凭据、API key 由用户在 Config → MCP 填（绝不内置任何凭据）。
 * - 仅 seed 缺失的条目，已存在的（用户已配/已填凭据）一律不动。
 */
function builtinMcpServers(): Record<string, ServerEntry> {
    // 本模块在 packages/core/src/config/mcp/index.ts，仓库根在上 5 层；vendor 脚本在 <root>/mcp/。
    const repoMcpDir = resolve(import.meta.dir, "../../../../../mcp")
    return {
        "kali-arsenal": {
            command: "python3",
            args: [resolve(repoMcpDir, "ssh_mcp.py")],
            env: { SSH_HOST: "", SSH_PORT: "22", SSH_USER: "root", SSH_PASS: "", SSH_ALIAS: "" },
            lifecycle: "keep-alive",
        },
        "vuln-intel": {
            command: "python3",
            args: [resolve(repoMcpDir, "vuln_intel_mcp.py")],
            env: { NVD_API_KEY: "", GITHUB_TOKEN: "" },
            lifecycle: "keep-alive",
        },
    }
}

/** 首次启动 seed 内置 MCP server（只补缺失，不覆盖用户已有配置/凭据）。 */
export async function initBuiltinMcpServers(dir: string) {
    const config = getMcpConfig(dir)
    let changed = false
    for (const [name, server] of Object.entries(builtinMcpServers())) {
        if (name in config.mcpServers) continue // 已存在（含用户填好凭据的）→ 绝不覆盖
        config.mcpServers[name] = server
        changed = true
    }
    if (changed) await writeMcpConfig(dir, config)
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

// ── Probe（连接服务器发现工具） ──

export interface ProbeResult {
    server: string
    tools: McpServerCacheEntry["tools"]
    resources: McpServerCacheEntry["resources"]
}

export async function probeMcpServerDefinition(serverName: string, definition: ServerEntry): Promise<ProbeResult> {
    const manager = new McpServerManager()
    try {
        const connection = await manager.connect(serverName, definition)
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

/** 连接单个 MCP server，发现工具和资源，更新缓存 */
export async function probeMcpServer(dir: string, serverName: string): Promise<ProbeResult> {
    const config = getMcpConfig(dir)
    const definition = config.mcpServers[serverName]
    if (!definition) throw new Error(`MCP server "${serverName}" not found`)

    const result = await probeMcpServerDefinition(serverName, definition)

    // 更新缓存
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

/** 连接所有已配置的 MCP server，发现工具和资源，更新缓存 */
export async function probeAllMcpServers(dir: string): Promise<ProbeResult[]> {
    const config = getMcpConfig(dir)
    const names = Object.keys(config.mcpServers)
    const results: ProbeResult[] = []

    for (const name of names) {
        try {
            results.push(await probeMcpServer(dir, name))
        } catch {
            // 连接失败跳过，不影响其他服务器
        }
    }

    return results
}
