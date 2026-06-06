import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { isConfigDirWritable } from "./writable"

let configDir: string

afterEach(async () => {
    if (configDir) {
        await chmod(configDir, 0o755).catch(() => {})
        await rm(configDir, { recursive: true, force: true })
    }
})

describe("isConfigDirWritable", () => {
    test("returns true for a writable directory", async () => {
        configDir = await mkdtemp(resolve(tmpdir(), "tch-writable-"))
        expect(await isConfigDirWritable(configDir)).toBe(true)
    })

    test("returns false for a read-only directory", async () => {
        configDir = await mkdtemp(resolve(tmpdir(), "tch-readonly-"))
        await chmod(configDir, 0o555)
        expect(await isConfigDirWritable(configDir)).toBe(false)
    })
})
