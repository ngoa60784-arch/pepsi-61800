import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import {
    deleteChallengeStateAsset,
    listChallengeStateAssets,
    updateChallengeStateAsset,
    upsertChallengeStateAsset,
} from "./state-store"

let rootDir: string

beforeEach(async () => {
    rootDir = await mkdtemp(resolve(tmpdir(), "tch-state-store-test-"))
})

afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
})

describe("challenge state-store", () => {
    test("upsert creates a credential asset and lists it", async () => {
        const result = await upsertChallengeStateAsset(rootDir, "t1", {
            kind: "credential",
            label: "admin@webapp",
            host: "10.0.0.5",
            account: "admin",
            privilege: "admin",
            secretRef: "finding:rec-1",
            sourceRefs: ["rec-1"],
        })
        expect(result.created).toBe(true)
        expect(result.asset.kind).toBe("credential")
        expect(result.asset.secretRef).toBe("finding:rec-1")

        const assets = await listChallengeStateAssets(rootDir, "t1")
        expect(assets).toHaveLength(1)
        expect(assets[0].account).toBe("admin")
    })

    test("upsert merges a duplicate (same kind+label+account+host) instead of adding", async () => {
        const first = await upsertChallengeStateAsset(rootDir, "t2", {
            kind: "credential",
            label: "admin@webapp",
            host: "10.0.0.5",
            account: "admin",
            sourceRefs: ["rec-1"],
        })
        const second = await upsertChallengeStateAsset(rootDir, "t2", {
            kind: "credential",
            label: "admin@webapp",
            host: "10.0.0.5",
            account: "admin",
            privilege: "admin",
            sourceRefs: ["rec-2"],
        })
        expect(second.created).toBe(false)
        expect(second.asset.id).toBe(first.asset.id)
        // Merge: fill in privilege, accumulate sourceRefs.
        expect(second.asset.privilege).toBe("admin")
        expect(second.asset.sourceRefs.sort()).toEqual(["rec-1", "rec-2"])

        const assets = await listChallengeStateAssets(rootDir, "t2")
        expect(assets).toHaveLength(1)
    })

    test("distinct kinds/hosts are separate assets", async () => {
        await upsertChallengeStateAsset(rootDir, "t3", { kind: "host", label: "10.0.0.5" })
        await upsertChallengeStateAsset(rootDir, "t3", { kind: "service", label: "http://10.0.0.5:8080", host: "10.0.0.5", port: 8080, service: "nginx 1.25" })
        await upsertChallengeStateAsset(rootDir, "t3", { kind: "credential", label: "root@db", host: "10.0.0.9", account: "root" })
        const assets = await listChallengeStateAssets(rootDir, "t3")
        expect(assets).toHaveLength(3)
    })

    test("update patches fields by id prefix", async () => {
        const created = await upsertChallengeStateAsset(rootDir, "t4", { kind: "session", label: "shell on web01", sessionType: "reverse-shell" })
        const updated = await updateChallengeStateAsset(rootDir, "t4", created.asset.id, { privilege: "root", note: "stabilized" })
        expect(updated?.privilege).toBe("root")
        expect(updated?.note).toBe("stabilized")
        expect(updated?.sessionType).toBe("reverse-shell")
    })

    test("delete removes the asset", async () => {
        const created = await upsertChallengeStateAsset(rootDir, "t5", { kind: "host", label: "10.0.0.5" })
        expect(await deleteChallengeStateAsset(rootDir, "t5", created.asset.id)).toBe(true)
        expect(await listChallengeStateAssets(rootDir, "t5")).toHaveLength(0)
        // Deleting again returns false.
        expect(await deleteChallengeStateAsset(rootDir, "t5", created.asset.id)).toBe(false)
    })

    test("listing an unknown target returns empty", async () => {
        expect(await listChallengeStateAssets(rootDir, "never-touched")).toEqual([])
    })
})
