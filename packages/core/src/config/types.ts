export interface AddResult {
    id: string
    rejected?: string
}

export interface HostRuntimeSettings {
    image?: string
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    binds?: string[]
    maxSolvers?: number
    networkMode?: "bridge" | "host"
    /** 执行后端：docker（默认本地容器）| ssh（远程主机直跑，去 docker） */
    backend?: "docker" | "ssh"
    /** backend="ssh" 时的远程执行配置（host/port/alias/remoteBinary/remoteSolversDir 等） */
    ssh?: {
        host?: string
        port?: number
        username?: string
        password?: string
        alias?: string
        remoteBinary?: string
        remoteSolversDir?: string
    }
}

export interface HostChallengeSettings {
    mockEnabled?: boolean
    apiBaseUrl?: string
    agentToken?: string
    answerModeEnabled?: boolean
    baseUrlMappings?: Array<{
        sourceBaseUrl: string
        gatewayBaseUrl: string
    }>
}

export interface HostPlannerSettings {
    enabled?: boolean
    strategy?: string
    tickIntervalMs?: number
    staleTimeoutMs?: number
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    challenge: HostChallengeSettings
    planner: HostPlannerSettings
    /**
     * 全局默认 Agent 模型(model-pref id)。所有 agent(planner/solver/verifier/commander/observer)
     * 在自身提示词未显式声明 model 时，统一回退到这个模型。UI 选一次，全员一致。
     */
    defaultModelPrefId?: string
}
