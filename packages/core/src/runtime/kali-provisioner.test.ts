import { expect, test } from "bun:test"
import {
    buildKaliProvisionerRetryTask,
    buildKaliProvisionerTask,
    buildProvisionerDirective,
    formatProvisionerAgentLog,
    formatSshTargetForAgent,
    kaliEnvForMcpServer,
} from "./kali-provisioner"
import { KALI_PROVISION_CHECK_TOOLS } from "./kali-ssh"

test("kaliEnvForMcpServer keeps SSH_ and TCH_ keys only", () => {
    expect(
        kaliEnvForMcpServer({
            SSH_HOST: "1.2.3.4",
            SSH_PASS: "x",
            TCH_GOPROXY: "https://goproxy.cn,direct",
            FOO: "bar",
        }),
    ).toEqual({
        SSH_HOST: "1.2.3.4",
        SSH_PASS: "x",
        TCH_GOPROXY: "https://goproxy.cn,direct",
    })
})

test("formatSshTargetForAgent includes host but not password text", () => {
    const text = formatSshTargetForAgent({
        SSH_HOST: "203.0.113.10",
        SSH_PORT: "22",
        SSH_USER: "root",
        SSH_PASS: "secret",
    })
    expect(text).toContain("203.0.113.10")
    expect(text).not.toContain("secret")
})

test("buildProvisionerDirective emphasizes engineer troubleshooting", () => {
    const task = buildProvisionerDirective({ SSH_ALIAS: "kali-vps" })
    expect(task).toContain("工程师")
    expect(task).toContain("想办法")
    expect(task).toContain("MISS")
})

test("buildKaliProvisionerRetryTask adds per-tool hints", () => {
    const task = buildKaliProvisionerRetryTask(
        { SSH_HOST: "1.2.3.4" },
        { ready: ["nmap"], missing: ["nxc", "ffuf"], entries: [] },
        2,
    )
    expect(task).toContain("继续排查")
    expect(task).toContain("NetExec")
    expect(task).toContain("ffuf")
    expect(task).toContain("禁止原样重试")
})

test("buildKaliProvisionerTask matches directive", () => {
    expect(buildKaliProvisionerTask({})).toContain("环境配置任务")
})

test("formatProvisionerAgentLog maps ssh_execute", () => {
    const line = formatProvisionerAgentLog({
        type: "tool_execution_start",
        toolName: "mcp_kali_arsenal_ssh_execute",
        args: { command: "apt-get install -y nmap" },
    } as never)
    expect(line).toContain("ssh_execute")
    expect(KALI_PROVISION_CHECK_TOOLS.length).toBe(20)
})
