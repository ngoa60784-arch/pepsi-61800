# BreachWeave Desktop（P5-D）

Tauri 2 桌面壳：单实例、内嵌 WebView 加载本机 sidecar（`tch-agent web`）。

## 开发

```bash
# 1) 安装 GTK/WebKit 构建依赖（仅需一次，需 sudo）
#    若开了 Clash 全局代理，脚本已让 apt 直连；仍失败则先关代理再装。
#    若 libayatana-appindicator3-dev 因 libdbusmenu-glib-dev 拉取失败，脚本会跳过托盘依赖，
#    仅安装 desktop:dev 所需的 WebKit 开发包。
bun run desktop:deps

# 2) 启动 Tauri 壳 + 本机 sidecar（127.0.0.1:38472）
bun run desktop:dev
```

开发态 sidecar 使用 `TCH_DESKTOP=1`：`solverHost=local`、跳过 Docker 镜像/二进制编译；WebView 加载指挥台 HMR 页面。

无 GTK 时可用冒烟脚本验证 sidecar：

```bash
bun run desktop:smoke
```

使用已编译 sidecar 调试 Tauri 壳（需先 `bun run build:linux` + `bun run desktop:prepare`）：

```bash
TCH_DESKTOP_SIDECAR=compiled bun run desktop:dev
```

## 发行构建

### Linux（Debian/Kali）

系统依赖：

```bash
sudo env -u http_proxy -u https_proxy -u all_proxy apt-get install -y --fix-missing \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev librsvg2-dev pkg-config
```

```bash
bun run desktop:build
# deb: apps/desktop/src-tauri/target/release/bundle/deb/BreachWeave_0.0.1_amd64.deb
# rpm: apps/desktop/src-tauri/target/release/bundle/rpm/BreachWeave-0.0.1-1.x86_64.rpm

sudo dpkg -i apps/desktop/src-tauri/target/release/bundle/deb/BreachWeave_0.0.1_amd64.deb
```

### Windows（可在 Linux 交叉编译）

```bash
# 需: rustup target add x86_64-pc-windows-msvc
#      cargo install cargo-xwin
#      clang + llvm-rc + nsis
bun run desktop:build:windows
# 产物: apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/BreachWeave_0.0.1_x64-setup.exe
```

### macOS（必须在 Mac 上构建）

```bash
bun run desktop:build:macos
# 产物: apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg
```

也可在 GitHub Actions 触发 `.github/workflows/desktop-release.yml`（`workflow_dispatch`）生成三平台产物。

### 一次性（本机可用平台）

```bash
bun run desktop:build:all   # Linux 上 = deb/rpm + Windows NSIS；macOS 需另在 Mac 或 CI 构建
bun run desktop:prepare:all # 预编译四平台 sidecar（macOS 交叉编译需 Bun 能下载 darwin baseline）
```

Sidecar 二进制由 `scripts/prepare-desktop-sidecar.ts` 从 `bin/tch-agent-linux-x64` 复制到
`src-tauri/binaries/tch-agent-<target-triple>`。

## 行为

- 监听地址：`127.0.0.1:38472`（固定，避免随机端口与 WebView 不同步）
- 退出时 kill sidecar 子进程
- 重复启动聚焦已有窗口（`tauri-plugin-single-instance`）
