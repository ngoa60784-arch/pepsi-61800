import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { CampaignStore } from "./campaign-store"

let dir = ""

afterEach(async () => {
    if (!dir) return
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await rm(dir, { recursive: true, force: true })
            return
        } catch (error) {
            if (attempt === 9) throw error
            await Bun.sleep(25)
        }
    }
})

async function openStore(): Promise<CampaignStore> {
    dir = await mkdtemp(resolve(tmpdir(), "tch-campaign-store-"))
    return CampaignStore.open(dir)
}

describe("CampaignStore", () => {
    test("task DAG exposes nodes only after dependencies complete", async () => {
        const store = await openStore()
        try {
            const recon = store.createTask({ challengeId: "t1", title: "Recon", role: "recon" })
            const exploit = store.createTask({ challengeId: "t1", title: "Exploit", role: "exploit", dependsOn: [recon.id] })
            expect(store.listReadyTasks("t1").map((task) => task.id)).toEqual([recon.id])
            store.updateTask(recon.id, { status: "completed", evidenceRefs: ["artifact:scan"] })
            expect(store.listReadyTasks("t1").map((task) => task.id)).toContain(exploit.id)
            expect(() => store.updateTask(recon.id, { dependsOn: [exploit.id] })).toThrow("cycle")
        } finally {
            store.close()
        }
    })

    test("stores artifacts, traces, and searchable memory", async () => {
        const store = await openStore()
        try {
            const task = store.createTask({ challengeId: "t2", title: "Validate RCE" })
            const artifact = store.createArtifact({ challengeId: "t2", taskId: task.id, kind: "command-output", name: "id.txt", uri: "loot/id.txt" })
            expect(store.listArtifacts("t2", task.id)[0]?.id).toBe(artifact.id)
            const span = store.startTrace({ traceId: "trace-1", challengeId: "t2", taskId: task.id, category: "tool", name: "ssh_execute", attributes: { command: "id" } })
            store.endTrace(span.id, "ok", { exitCode: 0 })
            expect(store.listTraces("trace-1")[0]?.status).toBe("ok")
            store.indexMemory({ id: "mem-1", challengeId: "t2", kind: "evidence", content: "Apache 2.4.49 path traversal confirmed", sourceRef: artifact.id, confidence: 0.9 })
            expect(store.searchMemory("t2", "Apache traversal")[0]?.id).toBe("mem-1")
        } finally {
            store.close()
        }
    })
})
