import { test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import { TCH_MCP_DIR_ENV } from "./paths"
import { initBuiltinMcpScripts } from "./index"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "tch-mcp-init-"))
    delete process.env[TCH_MCP_DIR_ENV]
})

afterEach(async () => {
    delete process.env[TCH_MCP_DIR_ENV]
    await rm(dir, { recursive: true, force: true })
})

test("initBuiltinMcpScripts extracts bundled MCP when repo tree is absent", async () => {
    const repoDir = resolve(import.meta.dir, "../../../../../mcp")
    if (existsSync(resolve(repoDir, "ssh_mcp.py"))) {
        await initBuiltinMcpScripts(dir)
        expect(process.env[TCH_MCP_DIR_ENV]).toBe(repoDir)
        return
    }

    await initBuiltinMcpScripts(dir)
    expect(existsSync(resolve(dir, "mcp/ssh_mcp.py"))).toBe(true)
    expect(existsSync(resolve(dir, "mcp/vuln_intel_mcp.py"))).toBe(true)
    expect(process.env[TCH_MCP_DIR_ENV]).toBe(resolve(dir, "mcp"))
})
