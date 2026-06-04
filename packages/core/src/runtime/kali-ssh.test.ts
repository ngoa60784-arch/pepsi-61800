import { test, expect } from "bun:test"
import {
    KALI_OPTIONAL_TOOLS,
    kaliEnvToProvisionTarget,
    parseKaliEnvFields,
    formatKaliEnvFields,
    parseProvisionLogSummary,
} from "./kali-ssh"

test("kaliEnvToProvisionTarget prefers alias", () => {
    expect(kaliEnvToProvisionTarget({ SSH_ALIAS: "kali-vps", SSH_HOST: "1.2.3.4" })).toEqual({ alias: "kali-vps" })
})

test("kaliEnvToProvisionTarget host mode", () => {
    expect(
        kaliEnvToProvisionTarget({
            SSH_HOST: "10.0.0.1",
            SSH_PORT: "2222",
            SSH_USER: "root",
            SSH_PASS: "secret",
        }),
    ).toEqual({ host: "10.0.0.1", port: 2222, username: "root", password: "secret" })
})

test("kaliEnvToProvisionTarget requires host or alias", () => {
    expect(() => kaliEnvToProvisionTarget({ SSH_PASS: "x" })).toThrow(/SSH_HOST|SSH_ALIAS/)
})

test("parse and format kali env round-trip", () => {
    const text = "SSH_HOST=1.2.3.4\nSSH_PORT=22\nSSH_USER=root\nSSH_PASS=abc"
    const fields = parseKaliEnvFields(text)
    expect(fields.SSH_HOST).toBe("1.2.3.4")
    expect(formatKaliEnvFields(fields)).toContain("SSH_HOST=1.2.3.4")
})

test("parseProvisionLogSummary extracts Ready and Not installed", () => {
    const logs = [
        "[+] Ready (3): nmap nuclei httpx",
        "[!] Not installed (2): fscan nxc",
    ]
    const summary = parseProvisionLogSummary(logs)
    expect(summary?.ready).toEqual(["nmap", "nuclei", "httpx"])
    expect(summary?.missing).toEqual(["fscan", "nxc"])
})

test("KALI_OPTIONAL_TOOLS marks niche binaries", () => {
    expect(KALI_OPTIONAL_TOOLS.has("fscan")).toBe(true)
    expect(KALI_OPTIONAL_TOOLS.has("nxc")).toBe(true)
    expect(KALI_OPTIONAL_TOOLS.has("nuclei")).toBe(false)
})
