/**
 * Browser-safe @tch/core surface for the Web UI.
 * Import from `@tch/core/ui` in client code — never the root barrel (pulls heavy server-only deps).
 */
export type { ActivateModelResult, AddResult, HostSettings } from "./config/index"
export type { ToolEntry } from "./config/tools/index"
export type { PromptFile } from "./config/prompts/index"
export type { BuiltInProvider, ConfiguredModel, ModelConfigEntry, ModelDefinition, ProviderPrefEntry } from "./config/providers/types"
export type { McpServerItem, ProbeResult } from "./config/mcp/index"

export type { AddIdeaResult, IdeaRecord, MemoryEntry, PlannerHealth } from "./challenge/manager"
export type { IdeaStatus } from "./challenge/memory"
export type { ChallengeProgressDigest } from "./challenge/progress-digest"
export type {
    ChallengeInfoRecord,
    ChallengeAttemptLogRecord,
    ChallengeSubmissionLogRecord,
} from "./challenge/store"
export type {
    ChallengeStatsOverview,
    ChallengeStatsOverviewBucket,
    ChallengeStatsRecord,
    SolverStatsRecord,
} from "./challenge/stats"

export type { RuntimeMessageThread, RuntimeSolverDetails, SolverInstance } from "./runtime/types"
export type { KaliSshTestResult, PentestKeysSyncResult } from "./runtime/kali-ssh"
export type { KaliSystemStats } from "./runtime/kali-stats"
export type { RuntimeMetricsSnapshot } from "./observability/metrics"

export { formatKaliUptime, formatKaliSshLabel } from "./runtime/kali-stats"
export {
    formatKaliEnvFields,
    hasFofaCredentials,
    KALI_OPTIONAL_TOOLS,
    parseProvisionLogSummary,
} from "./runtime/kali-ssh"
