import { describe, expect, test } from "bun:test"
import { requiresServerAccessObjective, validateObjectiveEvidence } from "./finding-validation"

describe("validateObjectiveEvidence", () => {
    test("accepts uid=0(root) command output", () => {
        const result = validateObjectiveEvidence("$ id\nuid=0(root) gid=0(root) groups=0(root)", "RCE via deserialization")
        expect(result.sufficient).toBe(true)
    })

    test("accepts /etc/passwd contents", () => {
        const result = validateObjectiveEvidence("read /etc/passwd:\nroot:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:", undefined)
        expect(result.sufficient).toBe(true)
    })

    test("accepts a shell prompt artifact", () => {
        const result = validateObjectiveEvidence("popped a shell:\nwww-data@web01:/var/www/html$ whoami", "command injection on upload endpoint")
        expect(result.sufficient).toBe(true)
    })

    test("accepts a JWT credential", () => {
        const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef"
        const result = validateObjectiveEvidence(`captured admin session token: ${token}`, undefined)
        expect(result.sufficient).toBe(true)
    })

    test("accepts a bcrypt hash", () => {
        const result = validateObjectiveEvidence("dumped users table, admin hash: $2y$10$abcdefghijklmnopqrstuv", undefined)
        expect(result.sufficient).toBe(true)
    })

    test("accepts two corroborating weak signals", () => {
        const result = validateObjectiveEvidence("ran whoami and curl against http://10.0.0.5:8080/admin and read /etc/shadow contents", undefined)
        expect(result.sufficient).toBe(true)
    })

    test("rejects a bare success claim with no artifact", () => {
        const result = validateObjectiveEvidence("got root shell via deserialization RCE, objective achieved", undefined)
        expect(result.sufficient).toBe(false)
    })

    test("rejects a too-short claim", () => {
        const result = validateObjectiveEvidence("rce achieved", undefined)
        expect(result.sufficient).toBe(false)
    })

    test("rejects prose mentioning root without any artifact", () => {
        const result = validateObjectiveEvidence("I believe I can get root access if I keep trying the exploit chain on the admin panel", undefined)
        expect(result.sufficient).toBe(false)
    })

    test("combines proof and writeup when judging", () => {
        // proof itself is a slogan, but the writeup carries real evidence → passes once combined.
        const result = validateObjectiveEvidence("objective achieved", "shell as root: root@target:/# id\nuid=0(root)")
        expect(result.sufficient).toBe(true)
    })

    test("requiresServerAccessObjective matches server-access wording", () => {
        expect(requiresServerAccessObjective("dbgaming.com — 获取服务器权限")).toBe(true)
        expect(requiresServerAccessObjective("enumerate subdomains")).toBe(false)
    })

    test("rejects JWT-only proof when objective requires server access", () => {
        const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef"
        const result = validateObjectiveEvidence(`NoSQL login bypass; admin JWT: ${token}`, "api.obgm.com CMS admin access confirmed", {
            objectiveText: "dbgaming.com\n获取服务器权限",
        })
        expect(result.sufficient).toBe(false)
        expect(result.reason).toContain("server access")
    })

    test("accepts shell proof when objective requires server access", () => {
        const result = validateObjectiveEvidence("$ id\nuid=0(root) gid=0(root) groups=0(root)", "deserialization RCE on upload", {
            objectiveText: "target\n获取服务器权限",
        })
        expect(result.sufficient).toBe(true)
    })
})
