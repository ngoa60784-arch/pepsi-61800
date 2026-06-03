import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import { initBuiltinMcpServers, getMcpConfig, addMcpServer } from "./index"

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
    // 脚本路径解析为绝对路径，指向仓库的 mcp/ 目录
    expect(cfg.mcpServers["kali-arsenal"].args?.[0]).toMatch(/\/mcp\/ssh_mcp\.py$/)
    expect(cfg.mcpServers["vuln-intel"].args?.[0]).toMatch(/\/mcp\/vuln_intel_mcp\.py$/)
    // 凭据占位为空（绝不内置任何凭据）
    expect(cfg.mcpServers["kali-arsenal"].env?.SSH_PASS).toBe("")
    expect(cfg.mcpServers["vuln-intel"].env?.NVD_API_KEY).toBe("")
})

test("does NOT overwrite an existing kali-arsenal (user creds preserved)", async () => {
    // 用户已配 kali-arsenal 带真实凭据
    await addMcpServer(dir, "kali-arsenal", {
        command: "python3",
        args: ["/custom/path/ssh_mcp.py"],
        env: { SSH_HOST: "10.0.0.9", SSH_PASS: "userpass" },
    })
    await initBuiltinMcpServers(dir)
    const cfg = getMcpConfig(dir)
    // 用户的配置/凭据原样保留，未被默认值覆盖
    expect(cfg.mcpServers["kali-arsenal"].args?.[0]).toBe("/custom/path/ssh_mcp.py")
    expect(cfg.mcpServers["kali-arsenal"].env?.SSH_PASS).toBe("userpass")
    // 缺失的 vuln-intel 仍被补上
    expect(cfg.mcpServers["vuln-intel"]).toBeDefined()
})

test("is idempotent (second run changes nothing)", async () => {
    await initBuiltinMcpServers(dir)
    const first = JSON.stringify(getMcpConfig(dir))
    await initBuiltinMcpServers(dir)
    expect(JSON.stringify(getMcpConfig(dir))).toBe(first)
})
