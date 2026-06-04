import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import {
    TCH_BUILTIN_SKILLS_ENV,
    applyBuiltinSkillsEnv,
    getRepoBuiltinSkillsDir,
    initBuiltinSkills,
    listSkills,
    resolveBuiltinSkillsDir,
} from "./index"

let configDir: string

afterEach(async () => {
    if (configDir) await rm(configDir, { recursive: true, force: true })
    delete process.env[TCH_BUILTIN_SKILLS_ENV]
})

describe("builtin skills paths", () => {
    test("resolveBuiltinSkillsDir prefers repo builtin tree when present", () => {
        const repoDir = getRepoBuiltinSkillsDir()
        expect(resolveBuiltinSkillsDir("/tmp/should-not-use-skills-subdir")).toBe(repoDir)
    })

    test("applyBuiltinSkillsEnv sets TCH_BUILTIN_SKILLS_DIR", async () => {
        configDir = await mkdtemp(resolve(tmpdir(), "tch-skills-env-"))
        const dir = applyBuiltinSkillsEnv(configDir)
        expect(process.env[TCH_BUILTIN_SKILLS_ENV]).toBe(dir)
        expect(dir).toBe(getRepoBuiltinSkillsDir())
    })

    test("initBuiltinSkills skips copy when repo tree exists", async () => {
        configDir = await mkdtemp(resolve(tmpdir(), "tch-skills-init-"))
        await initBuiltinSkills(configDir)
        const pentestCopy = resolve(configDir, "skills", "pentest", "SKILL.md")
        expect(await Bun.file(pentestCopy).exists()).toBe(false)
    })

    test("listSkills loads built-ins from repo and user-only skills from config dir", async () => {
        configDir = await mkdtemp(resolve(tmpdir(), "tch-skills-list-"))
        await Bun.write(
            resolve(configDir, "skills", "custom-only", "SKILL.md"),
            "---\ndescription: Custom\n---\n# Custom",
        )
        const names = listSkills(configDir).map((s) => s.name)
        expect(names).toContain("custom-only")
        expect(names).toContain("pentest")
    })
})
