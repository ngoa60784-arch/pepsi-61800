import { ENGAGEMENT_ENV_MODE, ENGAGEMENT_ENV_SCOPE } from "./env"

/**
 * Engagement（实战）模式 scope 定义。
 *
 * 与 CTF 模式不同，实战没有远程裁判：目标范围、约束、结束判定全部本地化。
 * 这个 scope 文件是实战模式的唯一授权来源——没有它，或白名单为空，引擎拒绝启动。
 */
export interface EngagementScope {
    /** 本次演练名称，仅用于报告与审计标识（如 "HVV-2026-蓝队A"）。 */
    engagement: string
    /** 授权目标白名单：IP / 域名 / CIDR / URL 前缀。空数组视为非法。 */
    allowed_targets: string[]
    /** 明确排除的目标（优先级高于 allowed_targets），用于排除范围内的敏感资产。 */
    out_of_scope?: string[]
    /** 是否禁止主动扫描类命令（nmap/ffuf 等）。默认 false（实战通常允许扫描）。 */
    no_scan?: boolean
    /** 额外禁用的命令 token，叠加在默认禁用集之上。 */
    forbidden_commands?: string[]
    /** 自由文本约束/备注，注入到 solver 上下文（如「禁止 DoS」「仅工作时间」）。 */
    rules_of_engagement?: string
}

export interface LoadedEngagement {
    scope: EngagementScope
    scopePath: string
}

/**
 * 当前进程是否处于实战(engagement)模式。
 *
 * CTF 链路已移除，实战是**唯一**运行形态——默认开启。
 * 仅当显式设置 `TCH_ENGAGEMENT_MODE=0` 时关闭（保留逃生口，主要给历史 mock 测试用）。
 */
export function isEngagementMode(getEnv: (key: string) => string | undefined = (k) => process.env[k]): boolean {
    return getEnv(ENGAGEMENT_ENV_MODE)?.trim() !== "0"
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

/**
 * 校验并归一化一个原始 scope 对象。
 * 任何不合法（缺 engagement 名、白名单为空）都抛错——实战模式不允许"无范围运行"。
 */
export function parseEngagementScope(raw: unknown, scopePath: string): EngagementScope {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`engagement scope file is not a JSON object: ${scopePath}`)
    }
    const data = raw as Record<string, unknown>

    const engagement = typeof data.engagement === "string" ? data.engagement.trim() : ""
    if (!engagement) {
        throw new Error(`engagement scope must define a non-empty "engagement" name: ${scopePath}`)
    }

    const allowedTargets = asStringArray(data.allowed_targets)
    if (allowedTargets.length === 0) {
        throw new Error(
            `engagement scope "allowed_targets" must list at least one authorized target (IP/host/CIDR/URL): ${scopePath}`,
        )
    }

    return {
        engagement,
        allowed_targets: allowedTargets,
        out_of_scope: asStringArray(data.out_of_scope),
        no_scan: typeof data.no_scan === "boolean" ? data.no_scan : false,
        forbidden_commands: asStringArray(data.forbidden_commands),
        rules_of_engagement:
            typeof data.rules_of_engagement === "string" && data.rules_of_engagement.trim()
                ? data.rules_of_engagement.trim()
                : undefined,
    }
}

/**
 * 从 TCH_ENGAGEMENT_SCOPE 指向的文件加载 scope。
 * 实战模式下必须成功，否则上层应拒绝启动 solver。
 */
export async function loadEngagementScope(
    getEnv: (key: string) => string | undefined = (k) => process.env[k],
): Promise<LoadedEngagement> {
    const scopePath = getEnv(ENGAGEMENT_ENV_SCOPE)?.trim()
    if (!scopePath) {
        throw new Error(
            `${ENGAGEMENT_ENV_MODE}=1 requires ${ENGAGEMENT_ENV_SCOPE} to point at a scope file defining authorized targets`,
        )
    }

    const file = Bun.file(scopePath)
    if (!(await file.exists())) {
        throw new Error(`engagement scope file not found: ${scopePath}`)
    }

    let raw: unknown
    try {
        raw = await file.json()
    } catch {
        throw new Error(`engagement scope file is not valid JSON: ${scopePath}`)
    }

    return { scope: parseEngagementScope(raw, scopePath), scopePath }
}
