import { afterEach, expect, test } from "bun:test"
import { execSurfaceExtension } from "./exec-surface"

const original = process.env.TCH_EXEC_SURFACE

afterEach(() => {
    if (original === undefined) delete process.env.TCH_EXEC_SURFACE
    else process.env.TCH_EXEC_SURFACE = original
})

test("execSurfaceExtension appends local-host rules when configured", () => {
    process.env.TCH_EXEC_SURFACE = "local-host"
    const ext = execSurfaceExtension()
    const text = typeof ext.appendSystemPrompt === "function" ? ext.appendSystemPrompt() : ""
    expect(text).toContain("local-host")
    expect(text).toContain("bash")
})

test("execSurfaceExtension skips append prompt for remote-vps default", () => {
    delete process.env.TCH_EXEC_SURFACE
    const ext = execSurfaceExtension()
    expect(ext.appendSystemPrompt).toBeUndefined()
    expect(typeof ext.factory).toBe("function")
})
