export { ConfigManager } from "./config/index"
export type {
    ActivateModelResult,
    AddResult,
    HostSettings,
    HostRuntimeSettings,
    HostChallengeSettings,
    HostPlannerSettings,
} from "./config/index"
export type { ToolEntry } from "./config/tools/index"
export type { PromptFile } from "./config/prompts/index"
export type { BuiltInProvider, ConfiguredModel, ModelConfigEntry, ModelDefinition, ProviderPrefEntry } from "./config/providers/types"
export type { McpServerItem, ProbeResult } from "./config/mcp/index"

export { ChallengeManager, MaxActiveChallengesError, MAX_ACTIVE_CHALLENGES } from "./challenge/manager"
export type {
    ActiveChallengeSlots,
    AddIdeaResult,
    IdeaRecord,
    MemoryEntry,
    PlannerHealth,
    PlannerTickOutcome,
    TargetOverview,
    PlannerProgressPhase,
} from "./challenge/manager"
export type { IdeaStatus, MemoryKind } from "./challenge/memory"
export type { ChallengeProgressDigest } from "./challenge/progress-digest"
export { PROGRESS_PHASE_LABELS } from "./challenge/progress-digest"
export type {
    ChallengeInfoRecord,
    ChallengeAttemptLogRecord,
    ChallengeSubmissionLogRecord,
} from "./challenge/store"
export { buildChallengeStatsOverview } from "./challenge/stats"
export type {
    ChallengeStatsOverview,
    ChallengeStatsOverviewBucket,
    ChallengeStatsRecord,
    SolverStatsRecord,
} from "./challenge/stats"
export { CHALLENGE_ENV_CHALLENGE_ID, CHALLENGE_ENV_DIR, ENGAGEMENT_ENV_MODE, ENGAGEMENT_ENV_SCOPE } from "./challenge/env"
export { isEngagementMode } from "./challenge/engagement"

export { RuntimeManager } from "./runtime/runtime"
export type { RuntimeMessageThread, RuntimeSolverDetails, SolverInstance } from "./runtime/types"
export { ARCHIVE_SOLVERS_DIR, solverSessionDir } from "./runtime/types"
export { readSolverBoardSnapshot } from "./solver/board-store"
export {
    testKaliSshConnection,
    kaliEnvToProvisionTarget,
    syncPentestKeysToRemote,
    checkKaliToolsOnRemote,
    formatKaliEnvFields,
    parseKaliEnvFields,
    hasFofaCredentials,
    parseProvisionLogSummary,
    KALI_OPTIONAL_TOOLS,
} from "./runtime/kali-ssh"
export type { KaliSshTestResult, PentestKeysSyncResult, KaliToolCheckResult } from "./runtime/kali-ssh"
export { fetchKaliSystemStats, formatKaliUptime, formatKaliSshLabel } from "./runtime/kali-stats"
export type { KaliSystemStats } from "./runtime/kali-stats"
export { provisionKaliWithAgent } from "./runtime/kali-provisioner"

export { buildRuntimeMetricsSnapshot, formatPrometheusMetrics } from "./observability/metrics"
export type { RuntimeMetricsSnapshot } from "./observability/metrics"

export { runSolverCli, runSubagentCli, runSolverRpc } from "./solver/cli"
export type { SolverEventListener } from "./solver/cli"

import { ConfigManager } from "./config/index"
import { ChallengeManager } from "./challenge/manager"
import { CommanderManager } from "./challenge/commander"
import { createChallengeHostBridgeHandler } from "./challenge/host-bridge-handler"
import { RuntimeManager } from "./runtime/runtime"

export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly challenge: ChallengeManager
    readonly runtime: RuntimeManager
    readonly commander: CommanderManager

    private constructor(config: ConfigManager, challenge: ChallengeManager, runtime: RuntimeManager, commander: CommanderManager) {
        this.config = config
        this.challenge = challenge
        this.runtime = runtime
        this.commander = commander
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance
        const created = (async () => {
            const config = await ConfigManager.getInstance()
            const challenge = new ChallengeManager(config)
            const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            const commander = new CommanderManager(config, challenge)
            return new DaemonManager(config, challenge, runtime, commander)
        })()
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }

    async reloadFromConfig(): Promise<void> {
        this.challenge.reloadFromConfig()
        await this.runtime.reloadFromConfig()
    }
}
