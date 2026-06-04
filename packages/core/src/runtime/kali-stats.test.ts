import { expect, test } from "bun:test"
import { formatKaliSshLabel, formatKaliUptime } from "./kali-stats"

test("formatKaliSshLabel prefers alias", () => {
    expect(formatKaliSshLabel({ alias: "kali-vps" })).toBe("kali-vps")
})

test("formatKaliSshLabel host with port", () => {
    expect(formatKaliSshLabel({ host: "1.2.3.4", port: 2222, username: "root" })).toBe("root@1.2.3.4:2222")
})

test("formatKaliUptime", () => {
    expect(formatKaliUptime(90_000)).toBe("1天 1小时")
    expect(formatKaliUptime(7200)).toBe("2小时 0分")
})
