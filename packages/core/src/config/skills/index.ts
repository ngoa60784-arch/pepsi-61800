import { resolve, dirname } from "path"
import { mkdir } from "fs/promises"
import { existsSync } from "fs"
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent"
import type { Skill } from "@mariozechner/pi-coding-agent"
import { BUILTIN_SKILL_FILES } from "../builtin-assets.generated"

/** Env var injected into solver processes; SKILL docs reference `$TCH_BUILTIN_SKILLS_DIR/...`. */
export const TCH_BUILTIN_SKILLS_ENV = "TCH_BUILTIN_SKILLS_DIR"

/** Built-in skill tree in the repo (`packages/core/src/config/skills/builtin`). */
export function getRepoBuiltinSkillsDir(): string {
    return resolve(import.meta.dir, "builtin")
}

/** Directory agents should grep/read for bundled skills (repo tree when present, else `config/skills`). */
export function resolveBuiltinSkillsDir(configDir: string): string {
    const repoDir = getRepoBuiltinSkillsDir()
    if (existsSync(repoDir)) return repoDir
    return resolve(configDir, "skills")
}

/** Canonical built-in skill `name` values (frontmatter), sorted for stable YAML. */
export function allBuiltinSkillNames(configDir: string): string[] {
    return listSkills(configDir)
        .map((s) => s.name)
        .sort((a, b) => a.localeCompare(b))
}

export function applyBuiltinSkillsEnv(configDir: string): string {
    const dir = resolveBuiltinSkillsDir(configDir)
    process.env[TCH_BUILTIN_SKILLS_ENV] = dir
    return dir
}

/**
 * Release built-in skills into the user's config directory when the repo tree is
 * unavailable (compiled binary). When developing from source, builtins are read
 * directly from `getRepoBuiltinSkillsDir()` — no copy.
 */
export async function initBuiltinSkills(dir: string) {
    applyBuiltinSkillsEnv(dir)
    const repoDir = getRepoBuiltinSkillsDir()
    if (existsSync(repoDir)) {
        try {
            await mkdir(resolve(dir, "skills"), { recursive: true })
        } catch {
            // read-only config mount (e.g. solver container)
        }
        return
    }

    const destBase = resolve(dir, "skills")
    try {
        await mkdir(destBase, { recursive: true })
    } catch {
        return
    }
    const builtinSkillFiles = BUILTIN_SKILL_FILES as unknown as Record<string, string>

    for (const [relativePath, sourcePath] of Object.entries(builtinSkillFiles)) {
        const destPath = resolve(destBase, relativePath)
        try {
            await mkdir(dirname(destPath), { recursive: true })
            await Bun.write(destPath, Bun.file(sourcePath))
        } catch {
            // skip individual file on read-only filesystem
        }
    }
}

// ── Directory discovery ──

export function listSkills(dir: string): Skill[] {
    const builtinDir = resolveBuiltinSkillsDir(dir)
    const userDir = resolve(dir, "skills")

    const byName = new Map<string, Skill>()
    if (existsSync(builtinDir)) {
        for (const skill of loadSkillsFromDir({ dir: builtinDir, source: "builtin" }).skills) {
            byName.set(skill.name, skill)
        }
    }
    if (existsSync(userDir)) {
        for (const skill of loadSkillsFromDir({ dir: userDir, source: "user" }).skills) {
            // Same name under config/skills overrides a built-in (zip/git install or local edit).
            byName.set(skill.name, skill)
        }
    }
    return [...byName.values()]
}

export function getSkill(dir: string, name: string): Skill | undefined {
    return listSkills(dir).find((s) => s.name === name)
}

// ── CRUD ──

export async function removeSkill(dir: string, name: string) {
    const dest = resolve(dir, "skills", name)
    const { rm } = await import("fs/promises")
    await rm(dest, { recursive: true, force: true })
}

// ── Install helpers ──

/** Recursively copy a directory, excluding the specified entries */
async function copyDir(src: string, dest: string, exclude: string[]) {
    const { readdirSync, statSync } = await import("fs")
    for (const entry of readdirSync(src)) {
        if (exclude.includes(entry)) continue
        const srcPath = resolve(src, entry)
        const destPath = resolve(dest, entry)
        if (statSync(srcPath).isDirectory()) {
            await mkdir(destPath, { recursive: true })
            await copyDir(srcPath, destPath, exclude)
        } else {
            await Bun.write(destPath, Bun.file(srcPath))
        }
    }
}

/** Find the root directory containing SKILL.md within the directory tree (checks the root + one level of subdirectories) */
function findSkillRoot(baseDir: string): string | null {
    const { readdirSync, statSync, existsSync } = require("fs")
    if (existsSync(resolve(baseDir, "SKILL.md"))) return baseDir
    for (const entry of readdirSync(baseDir)) {
        const sub = resolve(baseDir, entry)
        if (statSync(sub).isDirectory() && existsSync(resolve(sub, "SKILL.md"))) {
            return sub
        }
    }
    return null
}

/** Install a skill from a zip */
export async function addSkillFromZip(dir: string, zipData: ArrayBuffer): Promise<{ name: string }> {
    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-"))
    try {
        const zipPath = resolve(tmpDir, "skill.zip")
        await Bun.write(zipPath, zipData)

        const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", tmpDir], { stdout: "ignore", stderr: "pipe" })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`unzip failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(tmpDir)
        if (!skillRoot) throw new Error("SKILL.md not found in zip")

        const skillName = skillRoot === tmpDir ? "unnamed-skill" : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, ["skill.zip", "__MACOSX"])

        return { name: skillName }
    } finally {
        const { rm: rmTmp } = await import("fs/promises")
        await rmTmp(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}

/** Install a skill from a Git repository */
export async function addSkillFromGit(dir: string, url: string): Promise<{ name: string }> {
    const repoName = url
        .replace(/\.git$/, "")
        .split("/")
        .pop()
    if (!repoName) throw new Error("could not extract repo name from URL")

    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-git-"))

    try {
        const cloneDir = resolve(tmpDir, repoName)
        const proc = Bun.spawn(["git", "clone", "--depth", "1", url, cloneDir], {
            stdout: "ignore",
            stderr: "pipe",
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`git clone failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(cloneDir)
        if (!skillRoot) throw new Error("SKILL.md not found in repository")

        const skillName = skillRoot === cloneDir ? repoName : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, [".git"])

        return { name: skillName }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}
