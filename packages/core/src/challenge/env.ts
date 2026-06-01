export const CHALLENGE_ENV_CHALLENGE_ID = "TCH_CHALLENGE_ID"
export const CHALLENGE_ENV_DIR = "TCH_CHALLENGE_DIR"
export const CHALLENGE_ENV_API_BASE_URL = "TCH_CHALLENGE_API_BASE_URL"
export const CHALLENGE_ENV_AGENT_TOKEN = "TCH_CHALLENGE_AGENT_TOKEN"

// 实战（engagement）模式：面向授权目标的渗透演练（如护网 HVV）。
// 与 CTF 模式互斥——开启后不连远程评分 API，改用本地 scope 白名单 + findings 取证 + 操作员确认。
export const ENGAGEMENT_ENV_MODE = "TCH_ENGAGEMENT_MODE"
// 指向 scope 文件（JSON）的绝对路径；定义授权目标白名单与攻防约束。
export const ENGAGEMENT_ENV_SCOPE = "TCH_ENGAGEMENT_SCOPE"
