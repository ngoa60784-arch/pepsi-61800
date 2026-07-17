import { existsSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { resolveMcpVenvDir } from "../packages/core/src/config/mcp/paths"

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

// The built-in MCP servers (mcp/ssh_mcp.py, mcp/vuln_intel_mcp.py) are Python scripts that need these pip packages.
// Best-effort: if python3/pip is missing or installation fails, only warn, never let the whole install fail — these
// two MCPs are optional, needed only when actually running the solver to attack a remote Kali / query vuln intel.
const PYTHON_MCP_DEPS = ["asyncssh", "mcp[cli]", "httpx"]
// mcp[cli] installs the "mcp" module; asyncssh / httpx keep their package names.
const PYTHON_MCP_IMPORT_CHECK = "import asyncssh, httpx, mcp"

function commandExists(cmd: string): boolean {
    return Bun.which(cmd) !== null
}

async function runCommand(cmd: string[], opts: { quiet?: boolean } = {}): Promise<boolean> {
    try {
        const proc = Bun.spawn(cmd, {
            cwd: projectRoot,
            env: process.env,
            stdout: opts.quiet ? "ignore" : "inherit",
            stderr: opts.quiet ? "ignore" : "inherit",
        })
        return (await proc.exited) === 0
    } catch {
        return false
    }
}

async function depsImportable(python: string): Promise<boolean> {
    return runCommand([python, "-c", PYTHON_MCP_IMPORT_CHECK], { quiet: true })
}

async function pipInstall(python: string, extraArgs: string[]): Promise<boolean> {
    return runCommand([python, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...extraArgs, ...PYTHON_MCP_DEPS])
}

const venvDir = resolveMcpVenvDir()
const venvPython = process.platform === "win32" ? resolve(venvDir, "Scripts", "python.exe") : resolve(venvDir, "bin", "python")

/** Create the dedicated venv if missing; returns the interpreter path or undefined if venv is unavailable. */
async function ensureVenvPython(): Promise<string | undefined> {
    if (existsSync(venvPython)) return venvPython
    console.log(`[mcp] creating Python venv at ${venvDir}`)
    const created = await runCommand(["python3", "-m", "venv", venvDir])
    if (created && existsSync(venvPython)) return venvPython
    console.warn("[mcp] could not create a venv (install the python3-venv package to enable it) — falling back to system pip")
    return undefined
}

async function installPythonMcpDeps() {
    if (process.env.TCH_AGENT_SKIP_PYTHON_DEPS === "1") return
    if (!commandExists("python3")) {
        console.warn("[mcp] python3 not found — skipping MCP Python deps (asyncssh / mcp[cli] / httpx). Install python3 + these before using kali-arsenal / vuln-intel MCP.")
        return
    }

    // Preferred path: a dedicated virtualenv under ~/.tch-agent/venv. This is PEP 668-safe (works on
    // externally-managed Kali/Debian without --break-system-packages) and never pollutes system Python.
    // The runtime resolves the built-in MCP `python3` command to this interpreter (see resolveMcpVenvPython).
    const python = await ensureVenvPython()
    if (python) {
        if (await depsImportable(python)) {
            console.log("[mcp] Python deps already present in venv — skipping")
            return
        }
        console.log(`Installing Python deps for built-in MCP servers into venv: ${PYTHON_MCP_DEPS.join(", ")}`)
        if ((await pipInstall(python, [])) && (await depsImportable(python))) return
        console.warn("[mcp] venv install failed — falling back to system pip")
    }

    // Fallback: system interpreter. Skip if already satisfied, else try --user then --break-system-packages.
    if (await depsImportable("python3")) return
    console.log(`Installing Python deps for built-in MCP servers: ${PYTHON_MCP_DEPS.join(", ")}`)
    const ok = (await pipInstall("python3", ["--user"])) || (await pipInstall("python3", ["--break-system-packages"]))
    if (!ok) {
        console.warn(
            "[mcp] failed to install MCP Python deps automatically. Install manually when you need kali-arsenal / vuln-intel:\n" +
                `      python3 -m venv ${venvDir} && ${venvPython} -m pip install ${PYTHON_MCP_DEPS.join(" ")}`,
        )
    }
}

await runInstallIn(projectRoot)

for (const dir of await listNestedInstallDirs()) {
    await runInstallIn(dir)
}

await installPythonMcpDeps()
