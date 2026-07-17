import { describe, expect, test } from "bun:test"
import { updateProgressStallState } from "./ralph-loop"

describe("updateProgressStallState", () => {
    test("starts and resets on shared-state progress", () => {
        expect(updateProgressStallState(undefined, "a", 2)).toEqual({ fingerprint: "a", stalledRounds: 0 })
        expect(updateProgressStallState("a", "b", 2)).toEqual({ fingerprint: "b", stalledRounds: 0 })
    })

    test("increments only when the stable fingerprint is unchanged", () => {
        expect(updateProgressStallState("a", "a", 1)).toEqual({ fingerprint: "a", stalledRounds: 2 })
    })

    test("does not stop on bridge failure or an empty fingerprint", () => {
        expect(updateProgressStallState("a", "", 2)).toEqual({ fingerprint: "a", stalledRounds: 0 })
    })
})
