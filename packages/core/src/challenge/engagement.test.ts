import { test, expect } from "bun:test"
import { parseEngagementScope, isEngagementMode } from "./engagement"

test("parseEngagementScope rejects empty allowed_targets", () => {
    expect(() => parseEngagementScope({ engagement: "HVV-A", allowed_targets: [] }, "/tmp/scope.json")).toThrow(
        /allowed_targets/,
    )
})

test("parseEngagementScope rejects missing engagement name", () => {
    expect(() => parseEngagementScope({ allowed_targets: ["10.0.0.1"] }, "/tmp/scope.json")).toThrow(/engagement/)
})

test("parseEngagementScope rejects non-object", () => {
    expect(() => parseEngagementScope("nope", "/tmp/scope.json")).toThrow()
    expect(() => parseEngagementScope(["10.0.0.1"], "/tmp/scope.json")).toThrow()
})

test("parseEngagementScope normalizes a valid scope", () => {
    const scope = parseEngagementScope(
        {
            engagement: "  HVV-2026-BlueA  ",
            allowed_targets: [" 10.0.0.0/24 ", "app.example.com", ""],
            out_of_scope: ["10.0.0.5"],
            no_scan: true,
            forbidden_commands: ["hydra"],
            rules_of_engagement: " no DoS ",
        },
        "/tmp/scope.json",
    )
    expect(scope.engagement).toBe("HVV-2026-BlueA")
    expect(scope.allowed_targets).toEqual(["10.0.0.0/24", "app.example.com"])
    expect(scope.out_of_scope).toEqual(["10.0.0.5"])
    expect(scope.no_scan).toBe(true)
    expect(scope.forbidden_commands).toEqual(["hydra"])
    expect(scope.rules_of_engagement).toBe("no DoS")
})

test("isEngagementMode defaults to true and only the explicit 0 escape hatch disables it", () => {
    expect(isEngagementMode(() => undefined)).toBe(true)
    expect(isEngagementMode(() => "1")).toBe(true)
    expect(isEngagementMode(() => " 1 ")).toBe(true)
    expect(isEngagementMode(() => "0")).toBe(false)
    expect(isEngagementMode(() => " 0 ")).toBe(false)
})
