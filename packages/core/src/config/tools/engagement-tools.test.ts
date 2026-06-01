import { beforeEach, expect, mock, test } from "bun:test"

const requestHostBridge = mock(async () => ({
    code: "web-001",
    hint_content: null as string | null,
}))

mock.module("../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

const { getTargetIntelTool } = await import("./engagement-tools")

beforeEach(() => {
    requestHostBridge.mockReset()
})

test("get_target_intel returns intel text in content", async () => {
    requestHostBridge.mockResolvedValue({
        code: "web-001",
        hint_content: "仔细阅读公共构建日志",
    })

    const result = await getTargetIntelTool.execute(
        "tool-call-1",
        {},
        undefined,
        undefined,
        {
            cwd: process.cwd(),
        } as never,
    )

    expect(requestHostBridge).toHaveBeenCalledWith("challenge_get_hint", {})
    expect(result.content).toEqual([{ type: "text", text: "target intel:\n仔细阅读公共构建日志" }])
    expect(result.details).toEqual({
        code: "web-001",
        hint_content: "仔细阅读公共构建日志",
    })
})

test("get_target_intel keeps empty-state output when intel is blank", async () => {
    requestHostBridge.mockResolvedValue({
        code: "web-001",
        hint_content: "   ",
    })

    const result = await getTargetIntelTool.execute(
        "tool-call-2",
        {},
        undefined,
        undefined,
        {
            cwd: process.cwd(),
        } as never,
    )

    expect(result.content).toEqual([{ type: "text", text: "no cached intel for this target; rely on active recon" }])
})
