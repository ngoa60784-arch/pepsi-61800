import { test, expect } from "bun:test"
import { resolve } from "node:path"
import { buildProvisionArgv } from "./provision"
import { SSH_PASSWORD_BRIDGE_SOURCE } from "./ssh-password-bridge-source"

test("inlined bridge source matches the standalone .py asset", async () => {
    const py = await Bun.file(resolve(import.meta.dir, "assets/ssh-password-bridge.py")).text()
    expect(SSH_PASSWORD_BRIDGE_SOURCE).toBe(py)
})

test("password bridge argv inlines source via -c (no bunfs file path)", () => {
    const argv = buildProvisionArgv({ host: "10.0.0.9", port: 2222, username: "root", password: "secret" })
    expect(argv[0]).toBe("python3")
    expect(argv[1]).toBe("-c")
    expect(argv[2]).toBe(SSH_PASSWORD_BRIDGE_SOURCE)
    expect(argv.some((part) => part.includes("$bunfs"))).toBe(false)
    expect(argv).not.toContain("secret")
    expect(argv.at(-1)).toBe("bash -s")
})
