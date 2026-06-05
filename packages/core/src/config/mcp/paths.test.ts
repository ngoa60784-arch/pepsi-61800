import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import {
    TCH_MCP_DIR_ENV,
    applyMcpDirEnv,
    containerMcpScriptPath,
    isContainerMcpScriptPath,
    resolveMcpDir,
    resolveMcpScriptPathForHost,
} from "./paths"

let configDir: string

beforeEach(async () => {
    configDir = await mkdtemp(resolve(tmpdir(), "tch-mcp-paths-"))
    delete process.env[TCH_MCP_DIR_ENV]
})

afterEach(async () => {
    delete process.env[TCH_MCP_DIR_ENV]
    await rm(configDir, { recursive: true, force: true })
})

test("isContainerMcpScriptPath recognizes solver mount paths", () => {
    expect(isContainerMcpScriptPath("/opt/tch-mcp/ssh_mcp.py")).toBe(true)
    expect(isContainerMcpScriptPath("/home/user/mcp/ssh_mcp.py")).toBe(false)
})

test("resolveMcpScriptPathForHost maps container paths to repo mcp dir", () => {
    const hostPath = resolveMcpScriptPathForHost(containerMcpScriptPath("ssh_mcp.py"), configDir)
    expect(hostPath.endsWith("/mcp/ssh_mcp.py")).toBe(true)
})

test("applyMcpDirEnv sets TCH_MCP_DIR", () => {
    const dir = applyMcpDirEnv(configDir)
    expect(process.env[TCH_MCP_DIR_ENV]).toBe(dir)
    expect(resolveMcpDir(configDir)).toBe(dir)
})
