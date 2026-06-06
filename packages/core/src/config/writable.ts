import { resolve } from "node:path"
import { rm } from "node:fs/promises"

/** Probe whether configDir accepts writes (e.g. Docker :ro bind mount). */
export async function isConfigDirWritable(configDir: string): Promise<boolean> {
    const probe = resolve(configDir, `.write-probe-${process.pid}-${Date.now()}`)
    try {
        await Bun.write(probe, "")
        await rm(probe, { force: true })
        return true
    } catch {
        return false
    }
}
