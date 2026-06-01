import tailwind from "bun-plugin-tailwind"
import { mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { generateBuiltinAssets } from "./generate-builtin-assets"

type BuildTarget =
    | "bun-linux-x64"
    | "bun-linux-x64-baseline"
    | "bun-linux-arm64"
    | "bun-darwin-x64"
    | "bun-darwin-arm64"
    | "bun-windows-x64"
    | "bun-windows-x64-baseline"

const projectRoot = resolve(import.meta.dir, "..")
const entrypoint = resolve(projectRoot, "apps/cli/src/main.ts")
const runtimeAssetsDir = resolve(projectRoot, "packages/core/src/runtime/assets")
const embeddedLinuxSolverPath = resolve(runtimeAssetsDir, "tch-agent-linux-x64")
const target = process.argv[2] as BuildTarget | undefined
const outfile = process.argv[3]

if (!target || !outfile) {
    console.error("usage: bun run scripts/build.ts <target> <outfile>")
    process.exit(1)
}

const buildTarget: BuildTarget = target

await generateBuiltinAssets()

function shouldEmbedLinuxSolverBinary(buildTarget: BuildTarget): boolean {
    return buildTarget !== "bun-linux-x64" && buildTarget !== "bun-linux-x64-baseline"
}

async function ensureEmbeddedLinuxSolverBinary(): Promise<boolean> {
    if (!shouldEmbedLinuxSolverBinary(buildTarget)) return false
    if (process.env.TCH_SKIP_EMBEDDED_LINUX_SOLVER === "1") return false

    const proc = Bun.spawn(["bun", resolve(projectRoot, "scripts/build.ts"), "bun-linux-x64-baseline", embeddedLinuxSolverPath], {
        cwd: projectRoot,
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, TCH_SKIP_EMBEDDED_LINUX_SOLVER: "1" },
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`failed to build embedded linux solver binary (exit ${exitCode})`)
    }
    return true
}

async function ensureEmbeddedLinuxSolverPlaceholder(): Promise<boolean> {
    if (shouldEmbedLinuxSolverBinary(buildTarget) && process.env.TCH_SKIP_EMBEDDED_LINUX_SOLVER !== "1") return false
    await mkdir(runtimeAssetsDir, { recursive: true })
    await Bun.write(embeddedLinuxSolverPath, "")
    return true
}

const generatedEmbeddedLinuxSolver = await ensureEmbeddedLinuxSolverBinary()
const generatedEmbeddedLinuxSolverPlaceholder = generatedEmbeddedLinuxSolver ? false : await ensureEmbeddedLinuxSolverPlaceholder()
await mkdir(dirname(outfile), { recursive: true })

const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: dirname(outfile),
    naming: {
        entry: dirname(outfile) === "." ? "[dir]/[name]" : "[name]",
    },
    // cpu-features 是 ssh2（经 dockerode→docker-modem 引入）的可选原生模块，
    // 需编译且无法塞进 `bun build --compile` 单文件包，否则编译报错。
    // 它仅在"通过 SSH 连远程 docker daemon"时才会被 ssh2 用到，本项目用不到，
    // 故 external 掉跳过打包；运行时若真需要再由系统解析。
    external: ["cpu-features"],
    compile: {
        outfile,
        target: buildTarget,
    },
    plugins: [tailwind],
})

if (!result.success) {
    for (const log of result.logs) {
        console.error(log.message)
    }
    process.exit(1)
}

if (generatedEmbeddedLinuxSolver || (generatedEmbeddedLinuxSolverPlaceholder && outfile !== embeddedLinuxSolverPath)) {
    await rm(embeddedLinuxSolverPath, { force: true })
}
