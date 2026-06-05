import { mkdir, copyFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const desktopBinDir = resolve(projectRoot, "apps/desktop/src-tauri/binaries")
const devMode = process.argv.includes("--dev")

type DesktopPlatform = "linux" | "windows" | "macos-x64" | "macos-arm64"

const PLATFORM_SPECS: Record<
    DesktopPlatform,
    { buildScript: string; sourceBin: string; destTriple: string; destExt: string }
> = {
    linux: {
        buildScript: "build:linux",
        sourceBin: "bin/tch-agent-linux-x64",
        destTriple: "x86_64-unknown-linux-gnu",
        destExt: "",
    },
    windows: {
        buildScript: "build:windows",
        sourceBin: "bin/tch-agent-windows-x64.exe",
        destTriple: "x86_64-pc-windows-msvc",
        destExt: ".exe",
    },
    "macos-x64": {
        buildScript: "build:macos-x64",
        sourceBin: "bin/tch-agent-darwin-x64",
        destTriple: "x86_64-apple-darwin",
        destExt: "",
    },
    "macos-arm64": {
        buildScript: "build:macos-arm64",
        sourceBin: "bin/tch-agent-darwin-arm64",
        destTriple: "aarch64-apple-darwin",
        destExt: "",
    },
}

function parsePlatforms(argv: string[]): DesktopPlatform[] {
    const flags = argv.filter((arg) => arg.startsWith("--platform="))
    if (flags.length > 0) {
        const platforms: DesktopPlatform[] = []
        for (const flag of flags) {
            const value = flag.slice("--platform=".length) as DesktopPlatform | "all"
            if (value === "all") return Object.keys(PLATFORM_SPECS) as DesktopPlatform[]
            if (!(value in PLATFORM_SPECS)) throw new Error(`unknown --platform=${value}`)
            platforms.push(value)
        }
        return platforms
    }

    if (argv.includes("--all-platforms")) {
        return Object.keys(PLATFORM_SPECS) as DesktopPlatform[]
    }

    return ["linux"]
}

async function hostTargetTriple(): Promise<string> {
    const proc = Bun.spawn(["rustc", "--print", "host-tuple"], { stdout: "pipe", stderr: "pipe" })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error("rustc --print host-tuple failed")
    }
    const triple = (await new Response(proc.stdout).text()).trim()
    if (!triple) throw new Error("empty host target triple")
    return triple
}

async function ensureSidecarBinary(platform: DesktopPlatform): Promise<string> {
    const spec = PLATFORM_SPECS[platform]
    const binPath = resolve(projectRoot, spec.sourceBin)
    if (existsSync(binPath)) return binPath

    console.log(`Compiling sidecar (${platform}) → ${spec.sourceBin} ...`)
    const proc = Bun.spawn(["bun", "run", spec.buildScript], {
        cwd: projectRoot,
        stdout: "inherit",
        stderr: "inherit",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`bun run ${spec.buildScript} failed (exit ${exitCode})`)
    }
    if (!existsSync(binPath)) {
        throw new Error(`sidecar binary missing after build: ${spec.sourceBin}`)
    }
    return binPath
}

async function resolveDevSidecarSource(): Promise<string> {
    const compiled = resolve(projectRoot, "bin/tch-agent-linux-x64")
    if (existsSync(compiled)) return compiled

    const bunCandidates = [
        process.env.BUN_EXECUTABLE,
        `${process.env.HOME}/.bun/bin/bun`,
        "bun",
    ].filter((value): value is string => Boolean(value))

    for (const candidate of bunCandidates) {
        if (existsSync(candidate)) return candidate
    }

    throw new Error("desktop dev 需要 bin/tch-agent-linux-x64 或可用的 bun 可执行文件")
}

async function preparePlatform(platform: DesktopPlatform): Promise<string> {
    const spec = PLATFORM_SPECS[platform]
    const destName = `tch-agent-${spec.destTriple}${spec.destExt}`
    const destPath = resolve(desktopBinDir, destName)
    const sourcePath = await ensureSidecarBinary(platform)
    await copyFile(sourcePath, destPath)
    return destName
}

async function main() {
    await mkdir(desktopBinDir, { recursive: true })

    if (devMode) {
        const triple = await hostTargetTriple()
        const ext = triple.includes("windows") ? ".exe" : ""
        const destName = `tch-agent-${triple}${ext}`
        const destPath = resolve(desktopBinDir, destName)
        if (!existsSync(destPath)) {
            const sourcePath = await resolveDevSidecarSource()
            await copyFile(sourcePath, destPath)
        }
        console.log(
            `Desktop dev mode: tauri-build stub ${basename(destPath)} (runtime spawns bun unless TCH_DESKTOP_SIDECAR=compiled)`,
        )
        return
    }

    const platforms = parsePlatforms(process.argv.slice(2))
    const prepared: string[] = []
    for (const platform of platforms) {
        prepared.push(await preparePlatform(platform))
    }

    await Bun.write(resolve(desktopBinDir, ".gitignore"), "*\n!.gitignore\n")
    console.log(`Sidecar ready: ${prepared.join(", ")}`)
}

await main()
