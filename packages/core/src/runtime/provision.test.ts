import { test, expect } from "bun:test"
import { buildProvisionArgv, getProvisionScript } from "./provision"

test("provision script is inlined and looks like the provisioner", async () => {
    const script = await getProvisionScript()
    expect(typeof script).toBe("string")
    expect(script.length).toBeGreaterThan(1000)
    expect(script).toContain("provision-pentest-vps")
    expect(script).toContain("Stage 1/7")
    expect(script).toContain("install_netexec_editable")
    expect(script).toContain("install_jwt_tool")
    expect(script).toContain("install_pd_pinned")
    expect(script).toContain("ensure_bin_link")
    expect(script).toContain("go_toolchain_ok")
})

test("buildProvisionArgv (alias) runs bash -s over ssh, no password", () => {
    const argv = buildProvisionArgv({ alias: "kali-vps" })
    expect(argv[0]).toBe("ssh")
    expect(argv).toContain("kali-vps")
    expect(argv.at(-1)).toBe("bash -s")
    expect(argv).not.toContain("sshpass")
})

test("buildProvisionArgv (host+password) uses sshpass + port + user@host", () => {
    const argv = buildProvisionArgv({ host: "10.0.0.9", port: 2222, username: "root", password: "secret" })
    expect(argv[0]).toBe("sshpass")
    expect(argv).toContain("secret")
    expect(argv).toContain("-p")
    expect(argv).toContain("2222")
    expect(argv).toContain("root@10.0.0.9")
    expect(argv.at(-1)).toBe("bash -s")
})

test("buildProvisionArgv (host only, key auth) omits sshpass and defaults user root", () => {
    const argv = buildProvisionArgv({ host: "1.2.3.4" })
    expect(argv[0]).toBe("ssh")
    expect(argv).not.toContain("sshpass")
    expect(argv).toContain("root@1.2.3.4")
})

test("buildProvisionArgv throws without host or alias", () => {
    expect(() => buildProvisionArgv({})).toThrow(/SSH_HOST|SSH_ALIAS/)
})
