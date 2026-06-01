export { ConfigManager } from "./config/index"
export { RuntimeManager } from "./runtime/runtime"
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
