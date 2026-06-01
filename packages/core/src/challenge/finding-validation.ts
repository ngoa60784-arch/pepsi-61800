/**
 * 实战 finding 的断言式证据门禁（assertion-based validation）。
 *
 * 背景：solver 自报 objective_achieved=true 会触发引擎停掉该目标所有 solver、planner 不再补派。
 * 模型有时会在没有真凭实据时"宣布胜利"（幻觉 RCE / 把一次报错当 shell），一旦误停就浪费了整条战线。
 * 这里要求 objective_achieved 必须附带具体证据信号，否则降级为普通 finding（仍记录，但不自动收尾），
 * 让操作员/其它 solver 继续推进，而不是被一句空话叫停。
 *
 * 这是启发式门禁，不是裁判：宁可放过个别真发现（降级后仍记录、仍可由操作员确认），
 * 也不能让一句无证据的"已达成"把整个目标停掉。
 */

// 强证据信号：命中任意一条即视为有具体凭据/产物，足以支撑 objective_achieved。
const STRONG_EVIDENCE_PATTERNS: RegExp[] = [
    // shell / RCE：id 输出、root 提示符、Windows whoami
    /\buid=\d+\b/i,
    /\bgid=\d+\b/i,
    /\bnt authority\\system\b/i,
    /\b[\w.-]+@[\w.-]+:[~/][^\s]*[$#]/, // user@host:/path$  形式的提示符
    /\bMicrosoft Windows \[Version/i,
    /\b[A-Z]:\\Windows\\system32/i,
    // 敏感文件内容
    /root:.*:0:0:/, // /etc/passwd 行
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    // 凭证 / 哈希 / 令牌
    /\$2[abxy]?\$\d{1,2}\$[./A-Za-z0-9]{20,}/, // bcrypt ($2y$10$...)
    /\$[1356]\$[./A-Za-z0-9$]{8,}/, // md5crypt / sha256crypt / sha512crypt
    /\b[a-f0-9]{32}\b/i, // md5
    /\b[a-f0-9]{40}\b/i, // sha1
    /\b[a-f0-9]{64}\b/i, // sha256
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, // JWT
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
    // SQLi / 数据库 dump
    /\binformation_schema\b/i,
    /\b(?:mysql|mariadb|postgresql|microsoft sql server)\b.*\b\d+\.\d+/i,
    // HTTP 响应证据
    /\bHTTP\/\d(?:\.\d)?\s+\d{3}\b/,
]

// 弱证据信号：单独不够，命中 >= 2 条（且文本足够长）才算具备产物。
const WEAK_EVIDENCE_PATTERNS: RegExp[] = [
    /\b(?:whoami|hostname|ifconfig|ip addr|netstat|systeminfo)\b/i,
    /\/(?:etc|var|home|root|proc|usr)\//,
    /\bcurl\b|\bwget\b|\bnc\b|\bncat\b/i,
    /\bbase64\b/i,
    /\bcookie\b|\bsession\b|\btoken\b|\bpassword\b|\bpasswd\b/i,
    /\bport\s+\d{1,5}\b|\b:\d{2,5}\/\b/,
    /```|\$\s|\#\s/, // 代码块/命令提示符片段
]

// 纯口号红旗：短文本里只有这些"宣布胜利"词、没有任何产物时，几乎一定是空报。
const BARE_CLAIM_PATTERN =
    /\b(?:rce achieved|got (?:a )?shell|objective (?:complete|achieved|met)|success(?:fully)?|done|pwned|confirmed rce|i (?:have|got)|we (?:have|got)|fully compromised)\b/i

export interface ObjectiveEvidenceResult {
    sufficient: boolean
    reason: string
}

const MIN_COMBINED_LENGTH = 40

/**
 * 判断一份 proof(+writeup) 是否足以支撑"主目标达成"的自动收尾。
 * 返回 sufficient=false 时，调用方应把 objective_achieved 降级为普通 finding 并提示补证据。
 */
export function validateObjectiveEvidence(proof: string, writeup?: string): ObjectiveEvidenceResult {
    const proofText = (proof ?? "").trim()
    const extra = (writeup ?? "").trim()
    const combined = `${proofText}\n${extra}`.trim()

    if (combined.length < MIN_COMBINED_LENGTH) {
        return {
            sufficient: false,
            reason: "evidence too short — a primary-objective claim needs concrete proof (command output, shell prompt, file contents, captured credential, HTTP response, or DB dump), not a one-line claim",
        }
    }

    const strongHit = STRONG_EVIDENCE_PATTERNS.some((pattern) => pattern.test(combined))
    if (strongHit) {
        return { sufficient: true, reason: "strong evidence artifact present" }
    }

    const weakHits = WEAK_EVIDENCE_PATTERNS.reduce((count, pattern) => (pattern.test(combined) ? count + 1 : count), 0)
    if (weakHits >= 2) {
        return { sufficient: true, reason: "multiple corroborating evidence signals present" }
    }

    // 只有口号、没有产物 → 判为不足。
    if (BARE_CLAIM_PATTERN.test(combined)) {
        return {
            sufficient: false,
            reason: "looks like a bare success claim with no concrete artifact — attach the actual command output / shell evidence / captured credential that proves the objective",
        }
    }

    // 既无强信号、又少于 2 个弱信号：保守判不足（仍会记录为普通 finding）。
    return {
        sufficient: false,
        reason: "could not detect a concrete evidence artifact — include the raw proof (command output, file contents, credential, HTTP/DB response) so the objective can be auto-confirmed",
    }
}
