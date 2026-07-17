import { test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import { mkdir } from "fs/promises"
import {
    TCH_MCP_DIR_ENV,
    TCH_MCP_VENV_ENV,
    applyMcpDirEnv,
    containerMcpScriptPath,
    isContainerMcpScriptPath,
    resolveMcpDir,
    resolveMcpScriptPathForHost,
    resolveMcpVenvDir,
    resolveMcpVenvPython,
    resolvePythonCommandForHost,
} from "./paths"

let configDir: string

beforeEach(async () => {
    configDir = await mkdtemp(resolve(tmpdir(), "tch-mcp-paths-"))
    delete process.env[TCH_MCP_DIR_ENV]
    delete process.env[TCH_MCP_VENV_ENV]
    delete process.env.TCH_PYTHON_COMMAND
})

afterEach(async () => {
    delete process.env[TCH_MCP_DIR_ENV]
    delete process.env[TCH_MCP_VENV_ENV]
    delete process.env.TCH_PYTHON_COMMAND
    await rm(configDir, { recursive: true, force: true })
})

test("isContainerMcpScriptPath recognizes solver mount paths", () => {
    expect(isContainerMcpScriptPath("/opt/tch-mcp/ssh_mcp.py")).toBe(true)
    expect(isContainerMcpScriptPath("C:\\opt\\tch-mcp\\ssh_mcp.py")).toBe(true)
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

test("resolvePythonCommandForHost honors an existing configured Windows interpreter", async () => {
    const pythonPath = resolve(configDir, "python.exe")
    await Bun.write(pythonPath, "")
    process.env.TCH_PYTHON_COMMAND = pythonPath
    const command = resolvePythonCommandForHost("python3", "win32")
    expect(command).toBe(pythonPath)
    expect(existsSync(command)).toBe(true)
})

test("resolveMcpVenvDir honors the TCH_MCP_VENV override", () => {
    process.env[TCH_MCP_VENV_ENV] = configDir
    expect(resolveMcpVenvDir()).toBe(configDir)
})

test("resolveMcpVenvPython returns the interpreter only once the venv exists", async () => {
    process.env[TCH_MCP_VENV_ENV] = configDir
    expect(resolveMcpVenvPython("linux")).toBeUndefined()
    await mkdir(resolve(configDir, "bin"), { recursive: true })
    await Bun.write(resolve(configDir, "bin", "python"), "")
    expect(resolveMcpVenvPython("linux")).toBe(resolve(configDir, "bin", "python"))
})

test("resolvePythonCommandForHost prefers the tch-agent venv on non-Windows hosts", async () => {
    process.env[TCH_MCP_VENV_ENV] = configDir
    await mkdir(resolve(configDir, "bin"), { recursive: true })
    const venvPython = resolve(configDir, "bin", "python")
    await Bun.write(venvPython, "")
    expect(resolvePythonCommandForHost("python3", "linux")).toBe(venvPython)
})

test("resolvePythonCommandForHost lets an explicit TCH_PYTHON_COMMAND win over the venv", async () => {
    process.env[TCH_MCP_VENV_ENV] = configDir
    await mkdir(resolve(configDir, "bin"), { recursive: true })
    await Bun.write(resolve(configDir, "bin", "python"), "")
    const explicit = resolve(configDir, "explicit-python")
    await Bun.write(explicit, "")
    process.env.TCH_PYTHON_COMMAND = explicit
    expect(resolvePythonCommandForHost("python3", "linux")).toBe(explicit)
})
