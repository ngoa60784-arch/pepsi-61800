import { describe, expect, test } from "bun:test"
import { extractDefenseSignal } from "./operational-signals"

describe("extractDefenseSignal", () => {
    test("turns anti-ban tool output into a machine-captured defense signal", () => {
        expect(extractDefenseSignal("ssh_execute", "[ANTI-BAN WARN] target returned 429 rate limited"))
            .toContain("Automated defense signal")
    })

    test("ignores ordinary output and unrelated tools", () => {
        expect(extractDefenseSignal("ssh_execute", "200 OK")).toBeUndefined()
        expect(extractDefenseSignal("read", "429 rate limited")).toBeUndefined()
    })
})
