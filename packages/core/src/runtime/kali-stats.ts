import type { Subprocess } from "bun"
import { buildSshArgv, type ProvisionSshTarget } from "./provision"

export interface KaliSystemStats {
    ok: boolean
    message?: string
    label?: string
    hostname?: string
    uptimeSec?: number
    load1?: number
    load5?: number
    load15?: number
    cpuCount?: number
    cpuUsagePct?: number
    memTotalMb?: number
    memUsedMb?: number
    memUsedPct?: number
    diskTotalGb?: number
    diskUsedGb?: number
    diskUsedPct?: number
}

const KALI_STATS_TIMEOUT_MS = 12_000
const STATS_MARKER = "TCH_KALI_STATS:"

/** Human-readable SSH target (no password). */
export function formatKaliSshLabel(target: ProvisionSshTarget): string {
    if (target.alias?.trim()) return target.alias.trim()
    const host = target.host?.trim() || "?"
    const port = target.port ?? 22
    const user = target.username?.trim() || "root"
    return port === 22 ? `${user}@${host}` : `${user}@${host}:${port}`
}

/** Remote script: print TCH_KALI_STATS:{json} (base64 piped to python3 — safe over ssh -c). */
export function buildKaliStatsRemoteShell(): string {
    const py = `
import json, os, socket, shutil, time
MARKER = ${JSON.stringify(STATS_MARKER)}

def cpu_pct():
    def snap():
        with open("/proc/stat") as f:
            parts = f.readline().split()[1:]
        vals = [int(x) for x in parts]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle
    total_a, idle_a = snap()
    time.sleep(0.5)
    total_b, idle_b = snap()
    delta = total_b - total_a
    if delta <= 0:
        return 0.0
    return round(100 * (1 - (idle_b - idle_a) / delta), 1)

mem = {}
with open("/proc/meminfo") as f:
    for line in f:
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        mem[key.strip()] = int(rest.strip().split()[0])
mt = mem.get("MemTotal", 0)
ma = mem.get("MemAvailable", 0)
mu = max(0, mt - ma)
load = open("/proc/loadavg").read().split()
up = int(float(open("/proc/uptime").read().split()[0]))
du = shutil.disk_usage("/")
payload = {
    "hostname": socket.gethostname(),
    "cpuCount": os.cpu_count() or 1,
    "cpuUsagePct": cpu_pct(),
    "load1": float(load[0]),
    "load5": float(load[1]),
    "load15": float(load[2]),
    "memTotalMb": round(mt / 1024),
    "memUsedMb": round(mu / 1024),
    "memUsedPct": round(100 * mu / mt, 1) if mt else 0,
    "diskTotalGb": round(du.total / (1024 ** 3), 1),
    "diskUsedGb": round(du.used / (1024 ** 3), 1),
    "diskUsedPct": round(100 * du.used / du.total, 1) if du.total else 0,
    "uptimeSec": up,
}
print(MARKER + json.dumps(payload, separators=(",", ":")))
`.trim()
    const b64 = Buffer.from(py, "utf8").toString("base64")
    const remote = `echo ${b64} | base64 -d | python3`
    return `bash -lc ${JSON.stringify(remote)}`
}

export async function fetchKaliSystemStats(
    target: ProvisionSshTarget,
    signal?: AbortSignal,
): Promise<KaliSystemStats> {
    const label = formatKaliSshLabel(target)
    const argv = buildSshArgv(target, buildKaliStatsRemoteShell())
    const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })

    const abort = () => proc.kill()
    if (signal) {
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
    }

    const timeout = setTimeout(abort, KALI_STATS_TIMEOUT_MS)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        if (exitCode !== 0) {
            const hint = `${stdout}\n${stderr}`.trim().slice(0, 400)
            return { ok: false, label, message: hint || `SSH 退出码 ${exitCode}` }
        }
        const line = stdout.split("\n").find((row) => row.includes(STATS_MARKER))
        if (!line) {
            return { ok: false, label, message: "未收到系统状态数据（远程需 python3）" }
        }
        const jsonText = line.slice(line.indexOf(STATS_MARKER) + STATS_MARKER.length).trim()
        const raw = JSON.parse(jsonText) as Record<string, unknown>
        return {
            ok: true,
            label,
            hostname: typeof raw.hostname === "string" ? raw.hostname : undefined,
            uptimeSec: typeof raw.uptimeSec === "number" ? raw.uptimeSec : undefined,
            load1: typeof raw.load1 === "number" ? raw.load1 : undefined,
            load5: typeof raw.load5 === "number" ? raw.load5 : undefined,
            load15: typeof raw.load15 === "number" ? raw.load15 : undefined,
            cpuCount: typeof raw.cpuCount === "number" ? raw.cpuCount : undefined,
            cpuUsagePct: typeof raw.cpuUsagePct === "number" ? raw.cpuUsagePct : undefined,
            memTotalMb: typeof raw.memTotalMb === "number" ? raw.memTotalMb : undefined,
            memUsedMb: typeof raw.memUsedMb === "number" ? raw.memUsedMb : undefined,
            memUsedPct: typeof raw.memUsedPct === "number" ? raw.memUsedPct : undefined,
            diskTotalGb: typeof raw.diskTotalGb === "number" ? raw.diskTotalGb : undefined,
            diskUsedGb: typeof raw.diskUsedGb === "number" ? raw.diskUsedGb : undefined,
            diskUsedPct: typeof raw.diskUsedPct === "number" ? raw.diskUsedPct : undefined,
        }
    } catch (error) {
        return { ok: false, label, message: error instanceof Error ? error.message : String(error) }
    } finally {
        clearTimeout(timeout)
    }
}

export function formatKaliUptime(seconds?: number): string {
    if (seconds == null || seconds < 0) return "—"
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    if (days > 0) return `${days}天 ${hours}小时`
    if (hours > 0) return `${hours}小时 ${mins}分`
    return `${mins}分钟`
}
