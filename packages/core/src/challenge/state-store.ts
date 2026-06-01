/**
 * 跨 solver 的结构化作战状态库（structured cross-solver state store）。
 *
 * 背景(research gap 3)：原来 board 只有自由文本 memory/ideas，凭据/已控主机这类"作战资产"
 * 散落在文本里，solver 之间靠广播文本降重、靠正则猜，没法高效复用——一个 solver 拿到的凭据，
 * 另一个 solver 经常重新爆破一遍。
 *
 * 这里给每个目标维护一张结构化资产表：hosts / services / credentials / sessions，
 * 带 host/port/账号/权限/来源 finding/时间戳。observer 负责维护（与 board 架构一致：observer curate、
 * solver 读），solver 任务文案 + 一个只读工具能看到，planner snapshot 也能读到。
 *
 * 存储：每个目标一个 index.json（仿 ideas index），原子写 + 目录锁串行化跨 solver 写入。
 */

import { mkdir, rename, rm } from "fs/promises"
import { dirname, join } from "path"

export type StateAssetKind = "host" | "service" | "credential" | "session"

export interface StateAsset {
    id: string
    kind: StateAssetKind
    /** 人类可读标签：host=ip/hostname；service=proto://host:port；credential=account@scope；session=会话描述 */
    label: string
    /** host: ip/hostname；service/session 所在主机 */
    host?: string
    /** service: 端口；可空 */
    port?: number
    /** service: 服务名/产品/版本，如 "nginx 1.25" / "OpenSSH 9.2" */
    service?: string
    /** credential/session: 账号（用户名/角色），密文按引用名走 secretRef，不存明文 */
    account?: string
    /** 权限级别，如 "user" / "root" / "admin" / "www-data" */
    privilege?: string
    /** credential: 凭据的引用名（不是明文！指向 evidence_refs / secret store） */
    secretRef?: string
    /** session: 会话类型，如 "ssh" / "reverse-shell" / "web-cookie" */
    sessionType?: string
    /** 自由补充说明：如何获得、注意事项 */
    note?: string
    /** 来源 finding/idea/memory 的 id，建立"资产←发现"链接（research 强调的 discovery-node 链接） */
    sourceRefs: string[]
    created_at: string
    updated_at: string
}

export interface StateStoreIndex {
    challengeId: string
    updated_at: string
    assets: StateAsset[]
}

export interface AddStateAssetInput {
    kind: StateAssetKind
    label: string
    host?: string
    port?: number
    service?: string
    account?: string
    privilege?: string
    secretRef?: string
    sessionType?: string
    note?: string
    sourceRefs?: string[]
}

export interface UpdateStateAssetInput {
    label?: string
    host?: string
    port?: number
    service?: string
    account?: string
    privilege?: string
    secretRef?: string
    sessionType?: string
    note?: string
    sourceRefs?: string[]
}

export interface UpsertStateAssetResult {
    created: boolean
    asset: StateAsset
}

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function isDirectoryExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"
}

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function stateIndexPath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "state", "index.json")
}

function stateLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "state.lock")
}

function createAssetId(): string {
    return `asset_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return
    try {
        return (await file.json()) as T
    } catch {
        return
    }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

async function withDirectoryLock<T>(lockDir: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = 5000
    const staleMs = 60_000
    await mkdir(dirname(lockDir), { recursive: true })

    while (true) {
        try {
            await mkdir(lockDir)
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error
            const lockMeta = await readJsonFile<{ created_at?: string }>(join(lockDir, "lock-meta.json"))
            const lockCreatedAt = lockMeta?.created_at ? Date.parse(lockMeta.created_at) : Number.NaN
            const lockAge = Number.isFinite(lockCreatedAt) ? Date.now() - lockCreatedAt : Number.NaN
            if (Number.isFinite(lockAge) && lockAge > staleMs) {
                await rm(lockDir, { recursive: true, force: true })
                continue
            }
            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`challenge state lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }

    await Bun.write(join(lockDir, "lock-meta.json"), JSON.stringify({ created_at: nowIso(), pid: process.pid }, null, 2))
    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

async function readStateIndex(rootDir: string, challengeId: string): Promise<StateStoreIndex> {
    const id = requireText(challengeId, "challengeId")
    const existing = await readJsonFile<StateStoreIndex>(stateIndexPath(rootDir, id))
    if (existing && Array.isArray(existing.assets)) return existing
    return { challengeId: id, updated_at: nowIso(), assets: [] }
}

function normalizeRefs(refs?: string[]): string[] {
    return [...new Set((refs ?? []).map((item) => item.trim()).filter((item) => item.length > 0))]
}

function applyPatch(asset: StateAsset, patch: AddStateAssetInput | UpdateStateAssetInput): StateAsset {
    return {
        ...asset,
        label: patch.label !== undefined ? requireText(patch.label, "label") : asset.label,
        host: patch.host !== undefined ? patch.host.trim() || undefined : asset.host,
        port: patch.port !== undefined ? patch.port : asset.port,
        service: patch.service !== undefined ? patch.service.trim() || undefined : asset.service,
        account: patch.account !== undefined ? patch.account.trim() || undefined : asset.account,
        privilege: patch.privilege !== undefined ? patch.privilege.trim() || undefined : asset.privilege,
        secretRef: patch.secretRef !== undefined ? patch.secretRef.trim() || undefined : asset.secretRef,
        sessionType: patch.sessionType !== undefined ? patch.sessionType.trim() || undefined : asset.sessionType,
        note: patch.note !== undefined ? patch.note.trim() || undefined : asset.note,
        sourceRefs: patch.sourceRefs !== undefined ? normalizeRefs(patch.sourceRefs) : asset.sourceRefs,
        updated_at: nowIso(),
    }
}

/** 资产去重键：同 kind + 同 label(归一)视为同一资产，避免 N 个 solver 各记一遍同一台主机/同一凭据。 */
function dedupeKey(kind: StateAssetKind, label: string, account?: string, host?: string, port?: number): string {
    return [kind, label.trim().toLowerCase(), (account ?? "").trim().toLowerCase(), (host ?? "").trim().toLowerCase(), port ?? ""].join("|")
}

export async function listChallengeStateAssets(rootDir: string, challengeId: string): Promise<StateAsset[]> {
    const index = await readStateIndex(rootDir, challengeId)
    return index.assets
}

/**
 * 新增或合并一个作战资产。同 kind+label(+account/host/port) 已存在 → 合并更新(不新增重复)。
 * 返回 created 表示是否为新建。
 */
export async function upsertChallengeStateAsset(rootDir: string, challengeId: string, input: AddStateAssetInput): Promise<UpsertStateAssetResult> {
    const id = requireText(challengeId, "challengeId")
    requireText(input.label, "label")
    return withDirectoryLock(stateLockDir(rootDir, id), async () => {
        const index = await readStateIndex(rootDir, id)
        const key = dedupeKey(input.kind, input.label, input.account, input.host, input.port)
        const existing = index.assets.find((asset) => dedupeKey(asset.kind, asset.label, asset.account, asset.host, asset.port) === key)
        if (existing) {
            const merged = applyPatch(existing, input)
            // 合并 sourceRefs(累积来源)而非覆盖。
            merged.sourceRefs = normalizeRefs([...existing.sourceRefs, ...(input.sourceRefs ?? [])])
            index.assets = index.assets.map((asset) => (asset.id === existing.id ? merged : asset))
            index.updated_at = nowIso()
            await atomicWriteJson(stateIndexPath(rootDir, id), index)
            return { created: false, asset: merged }
        }
        const asset: StateAsset = {
            id: createAssetId(),
            kind: input.kind,
            label: input.label.trim(),
            host: input.host?.trim() || undefined,
            port: input.port,
            service: input.service?.trim() || undefined,
            account: input.account?.trim() || undefined,
            privilege: input.privilege?.trim() || undefined,
            secretRef: input.secretRef?.trim() || undefined,
            sessionType: input.sessionType?.trim() || undefined,
            note: input.note?.trim() || undefined,
            sourceRefs: normalizeRefs(input.sourceRefs),
            created_at: nowIso(),
            updated_at: nowIso(),
        }
        index.assets = [...index.assets, asset]
        index.updated_at = nowIso()
        await atomicWriteJson(stateIndexPath(rootDir, id), index)
        return { created: true, asset }
    })
}

export async function updateChallengeStateAsset(rootDir: string, challengeId: string, assetId: string, patch: UpdateStateAssetInput): Promise<StateAsset | undefined> {
    const id = requireText(challengeId, "challengeId")
    const target = requireText(assetId, "assetId")
    return withDirectoryLock(stateLockDir(rootDir, id), async () => {
        const index = await readStateIndex(rootDir, id)
        const existing = index.assets.find((asset) => asset.id === target || asset.id.startsWith(target))
        if (!existing) return undefined
        const merged = applyPatch(existing, patch)
        index.assets = index.assets.map((asset) => (asset.id === existing.id ? merged : asset))
        index.updated_at = nowIso()
        await atomicWriteJson(stateIndexPath(rootDir, id), index)
        return merged
    })
}

export async function deleteChallengeStateAsset(rootDir: string, challengeId: string, assetId: string): Promise<boolean> {
    const id = requireText(challengeId, "challengeId")
    const target = requireText(assetId, "assetId")
    return withDirectoryLock(stateLockDir(rootDir, id), async () => {
        const index = await readStateIndex(rootDir, id)
        const next = index.assets.filter((asset) => asset.id !== target && !asset.id.startsWith(target))
        if (next.length === index.assets.length) return false
        index.assets = next
        index.updated_at = nowIso()
        await atomicWriteJson(stateIndexPath(rootDir, id), index)
        return true
    })
}
