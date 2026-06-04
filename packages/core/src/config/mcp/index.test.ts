import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import { initBuiltinMcpServers, getMcpConfig, addMcpServer, migrateMcpPathsToContainerMount } from "./index"

let dir: string

beforeEach(async () => {
    dir = await mkdtemp(resolve(tmpdir(), "tch-mcp-seed-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

test("seeds kali-arsenal + vuln-intel into a fresh config", async () => {
    await initBuiltinMcpServers(dir)
    const cfg = getMcpConfig(dir)
    expect(cfg.mcpServers["kali-arsenal"]).toBeDefined()
    expect(cfg.mcpServers["vuln-intel"]).toBeDefined()
    expect(cfg.mcpServers["kali-arsenal"].args?.[0]).toBe("/opt/tch-mcp/ssh_mcp.py")
    expect(cfg.mcpServers["vuln-intel"].args?.[0]).toBe("/opt/tch-mcp/vuln_intel_mcp.py")
    // Credential placeholders are empty (no credentials are ever bundled)
    expect(cfg.mcpServers["kali-arsenal"].env?.SSH_PASS).toBe("")
    expect(cfg.mcpServers["vuln-intel"].env?.NVD_API_KEY).toBe("")
})

test("does NOT overwrite an existing kali-arsenal (user creds preserved)", async () => {
    // User has already configured kali-arsenal with real credentials
    await addMcpServer(dir, "kali-arsenal", {
        command: "python3",
        args: ["/custom/path/ssh_mcp.py"],
        env: { SSH_HOST: "10.0.0.9", SSH_PASS: "userpass" },
    })
    await initBuiltinMcpServers(dir)
    const cfg = getMcpConfig(dir)
    // The user's config/credentials are preserved as-is, not overwritten by defaults
    expect(cfg.mcpServers["kali-arsenal"].args?.[0]).toBe("/custom/path/ssh_mcp.py")
    expect(cfg.mcpServers["kali-arsenal"].env?.SSH_PASS).toBe("userpass")
    // The missing vuln-intel is still filled in
    expect(cfg.mcpServers["vuln-intel"]).toBeDefined()
})

test("migrates legacy repo paths to /opt/tch-mcp", async () => {
    await addMcpServer(dir, "kali-arsenal", {
        command: "python3",
        args: ["/home/user/proj/mcp/ssh_mcp.py"],
        env: { SSH_HOST: "10.0.0.1", SSH_PASS: "secret" },
    })
    await migrateMcpPathsToContainerMount(dir)
    const cfg = getMcpConfig(dir)
    expect(cfg.mcpServers["kali-arsenal"].args?.[0]).toBe("/opt/tch-mcp/ssh_mcp.py")
    expect(cfg.mcpServers["kali-arsenal"].env?.SSH_PASS).toBe("secret")
})

test("is idempotent (second run changes nothing)", async () => {
    await initBuiltinMcpServers(dir)
    const first = JSON.stringify(getMcpConfig(dir))
    await initBuiltinMcpServers(dir)
    expect(JSON.stringify(getMcpConfig(dir))).toBe(first)
})
