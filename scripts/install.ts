import { dirname, relative, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const skipInstallScript = process.env.TCH_AGENT_SKIP_INSTALL_SCRIPT === "1"

if (skipInstallScript) process.exit(0)

async function runInstallIn(cwd: string) {
    const label = relative(projectRoot, cwd) || "."
    console.log(`Installing dependencies in ${label}`)
    const proc = Bun.spawn(["bun", "install"], {
        cwd,
        env: { ...process.env, TCH_AGENT_SKIP_INSTALL_SCRIPT: "1" },
        stdout: "inherit",
        stderr: "inherit",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`bun install failed in ${label} (exit ${exitCode})`)
    }
}

async function listNestedInstallDirs() {
    const dirs = new Set<string>()
    const glob = new Bun.Glob("packages/libs/**/package.json")
    for await (const file of glob.scan({ cwd: projectRoot, absolute: true })) {
        if (file.includes("/node_modules/") || file.includes("/dist/")) continue
        const rel = relative(projectRoot, file)
        if (rel.split("/").length <= 4) continue
        dirs.add(dirname(file))
    }
    return [...dirs].sort()
}

// 内置 MCP server（mcp/ssh_mcp.py、mcp/vuln_intel_mcp.py）是 Python 脚本，需要这几个 pip 包。
// best-effort：python3/pip 缺失或装失败只警告，绝不让整个安装失败——这俩 MCP 是可选的，
// 仅在真正跑 solver 打远程 Kali / 查漏洞情报时才需要。
const PYTHON_MCP_DEPS = ["asyncssh", "mcp[cli]", "httpx"]

async function commandExists(cmd: string): Promise<boolean> {
    try {
        const proc = Bun.spawn(["sh", "-c", `command -v ${cmd}`], { stdout: "ignore", stderr: "ignore" })
        return (await proc.exited) === 0
    } catch {
        return false
    }
}

async function pipInstall(extraArgs: string[]): Promise<boolean> {
    const proc = Bun.spawn(["python3", "-m", "pip", "install", "--quiet", ...extraArgs, ...PYTHON_MCP_DEPS], {
        cwd: projectRoot,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
    })
    return (await proc.exited) === 0
}

async function installPythonMcpDeps() {
    if (process.env.TCH_AGENT_SKIP_PYTHON_DEPS === "1") return
    if (!(await commandExists("python3"))) {
        console.warn("[mcp] python3 not found — skipping MCP Python deps (asyncssh / mcp[cli] / httpx). Install python3 + these before using kali-arsenal / vuln-intel MCP.")
        return
    }
    console.log(`Installing Python deps for built-in MCP servers: ${PYTHON_MCP_DEPS.join(", ")}`)
    // 先试 --user；遇 PEP 668（externally-managed）再退回 --break-system-packages。
    const ok = (await pipInstall(["--user"])) || (await pipInstall(["--break-system-packages"]))
    if (!ok) {
        console.warn(
            "[mcp] failed to install MCP Python deps automatically. Install manually when you need kali-arsenal / vuln-intel:\n" +
                `      python3 -m pip install --user ${PYTHON_MCP_DEPS.join(" ")}`,
        )
    }
}

await runInstallIn(projectRoot)

for (const dir of await listNestedInstallDirs()) {
    await runInstallIn(dir)
}

await installPythonMcpDeps()
