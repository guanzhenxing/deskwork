# Deskwork（案头）

Deskwork（案头）是基于 DeepSeek Harness（DSH）的本地 AI 工作台。官方 DSH Web UI 运行在原生窗口、Dock 与托盘中；产品逻辑由一个独立 DSH bundle 插件（`desktop-plugin`）承载，一个很薄的 Electron launcher 负责启动、Host 进程监督、窗口以及 Host 无法启动时仍可用的最低恢复控制面。配套 CLI `dsh-native` 与桌面端顺序共享同一个 Deskwork home（默认 `~/.deskwork`）。

> Electron userData 目录名固定为 `Deskwork`，不随展示名变更。

## 功能特性

- 官方 DSH Web UI 的原生窗口、Dock、托盘、菜单与单实例生命周期；
- DSH Host 运行在独立 Node-capable 子进程中；Host 崩溃或启动失败时桌面壳保持存活，进入带结构化诊断的恢复窗口；
- 默认使用 `deskwork` profile（上游把 `desktop` 保留给官方应用） 与 Deskwork 自己的 home `~/.deskwork`（不指向官方 CLI 的 `~/.dsh`）；桌面端与 `dsh-native` CLI 在整 home lease 下顺序共享凭据、设置、会话与 storages（双向会话接续）；
- 非破坏性启动恢复：profile 走逐文件修订事务，只在修订校验通过时回滚本次自动修改，绝不自动覆盖 home 级用户数据；
- Safe Mode：不加载正常 `desktop-plugin` 与第三方 bundle 的最小恢复会话；
- home 兼容性准入：跨版本数据 epoch 与格式预检，未知格式与不安全降级在写入前拒绝；
- 可复现的打包与发行证据：schema-2 发行清单、确定性 SBOM、许可证清单、DMG 摘要绑定与升级/降级演练；
- 插件引入（plugin intake）审查工作流：声明式 intake 记录 + 逐字节校验 + 制品级隔离演练。

## 重要并发限制

“共享 home”表示 Desktop 与 CLI 在不同时间读取同一份 Deskwork home（默认 `~/.deskwork`）的磁盘数据，不表示两个 DSH Host 可以同时写入该 home。

受支持的入口遵循整份 home 单 Host 规则：

- Desktop 运行时，`dsh-native` 的 boot 与 `plugin` 变更会被 home lease 拒绝（退出码 3）；反之亦然；不同 profile 不构成例外；
- `dsh-native` 是唯一受本项目支持并遵守 lease 的 CLI；官方裸 `dsh` 默认使用它自己的 `~/.dsh`，与 Deskwork home 互不相干，也不经过本项目拦截；
- 残留锁用 `dsh-native doctor --unlock` 在确认无活跃 owner 后清理；
- 长期路线是一个 Host 被 Electron、本地 CLI 和授权远程客户端复用，见[路线图](docs/roadmap.md)。

## 架构摘要

```text
Electron launcher / dsh-native wrapper
  → home-lease (whole-home writer lease)
  → profile-manager (desktop profile reconcile)
  → host-supervisor
      → independent DSH Host (waits for boot authorization)
          → desktop-plugin
          → official DSH Web UI
```

正常 Desktop 产品逻辑属于 `desktop-plugin`；进程创建、boot 前 lease、Electron 资源和 boot-independent 恢复属于 launcher。第三方 DSH 插件与 Host 同权运行，独立 Host 进程是故障边界而不是权限 sandbox。

组件、进程与信任边界详见[架构](docs/architecture.md)。

## 安装

当前发布为本地自用构建（未签名/未公证）：Gatekeeper 首次启动需要右键打开。从源码构建 DMG：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 generate:compatibility
corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 package:dmg
```

`generate:compatibility` 生成 `release/compatibility.json`（`release/` 不入库，全新 clone 后必须先生成一次，`package:dir` 的清单校验才可通过）。

构建产物位于 `release/dist/`，SHA-256 与内嵌清单见 `release/artifacts.json`。手动升级、回退与升级演练见[升级指南](docs/upgrade-guide.md)。

## 使用

```bash
# CLI（与桌面端顺序共享 ~/.deskwork）
corepack pnpm@11.7.0 dsh-native -- --profile web "..."
corepack pnpm@11.7.0 dsh-native -- doctor --unlock   # 确认无活跃 owner 后清理残留锁
```

`dsh-native` 转发完整 CLI 参数给固定版官方 `@deepseek-ai/dsh`，并在子进程运行期间持有整 home lease。退出码语义见 [home-lease 协议](docs/protocols/home-lease.md)。

## 开发基线

- Node.js：24.11.1；
- pnpm：11.7.0；
- DSH：[`dsh-v0.1.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1)，commit [`a66e4702047846cdaa10c66c9d3df3951f5ea70d`](https://github.com/deepseek-ai/deepseek-harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d)。

机器可读版本权威是 [`docs/compatibility.json`](docs/compatibility.json) 与 lockfile；Markdown 中的版本只用于说明，不独立决定兼容性。上游基线与补丁对账见 [upstream-baseline](docs/upstream-baseline.md)。

常用开发命令：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check            # format/lint/typecheck/单测/文档检查
corepack pnpm@11.7.0 build:native     # 编译 lease helper（需要 Xcode CLT，macOS）
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home # 双向共享 home 会话接续
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
corepack pnpm@11.7.0 smoke:shared-home
corepack pnpm@11.7.0 smoke:profile-recovery
corepack pnpm@11.7.0 smoke:safe-mode
corepack pnpm@11.7.0 smoke:package    # 安装级制品冒烟
```

完整命令清单与工程规范见[开发指南](docs/development.md)与[贡献指南](CONTRIBUTING.md)。

## 范围与限制

当前版本：**v0.1.0**（darwin-arm64）。候选已通过完整发布链（含安装级冒烟与跨版本升级演练）；按[开发指南](docs/development.md)的发布流程，完成一个日用观察周期后才正式标记为当前发布。

以下能力不在当前版本内（进入条件见[路线图](docs/roadmap.md)）：自动更新、插件市场、远程访问、setup wizard、桌面终端、多 profile UI、Windows/Linux 支持、预编译制品签名与公证。

已知限制：

- 第三方 bundle 的引入审查（校验、隔离装入、字节复验）可用，但第三方 bundle 在 profile 内启动不在本版能力内（上游 loader 按名解析的布局限制，见[插件引入](docs/plugin-intake.md)）；`verify:plugin-intake` 的启动轮在该设计落地前保持失败。

Dock 图标与 Dock 右键退出已于 2026-09-09 完成人工验证。

## 文档

- [架构](docs/architecture.md)：组件、进程、信任边界和依赖方向；
- [路线图](docs/roadmap.md)：范围外能力与各自的进入条件；
- [Host-control 1.0](docs/protocols/host-control.md)：launcher/Host normative 协议；
- [home-lease 协议](docs/protocols/home-lease.md)：整 home 写入互斥、owner 身份与 doctor 清锁（含 `dsh-native` 退出码）；
- [home-compatibility 协议](docs/protocols/home-compatibility.md)：跨版本数据准入；
- [启动恢复分类协议](docs/protocols/startup-recovery.md)：失败分类、回滚资格与恢复窗口；
- [数据布局](docs/data-layout.md)：路径、所有权、恢复和迁移；
- [插件引入](docs/plugin-intake.md)：第三方 bundle 的审查式引入工作流；
- [升级指南](docs/upgrade-guide.md)：手动升级、回退与升级演练；
- [upstream-baseline](docs/upstream-baseline.md)：上游 DSH 基线、闭包与补丁对账；
- [开发指南](docs/development.md)：环境、命令、测试与发布流程；
- [安全策略](SECURITY.md)：威胁模型与未来能力进入条件；
- [兼容性清单](docs/compatibility.json)：Desktop、DSH、Electron、Node、pnpm 与协议版本的机器可读事实；

## 仓库结构

```text
.github/workflows/   # CI 门禁
docs/                # 架构、协议、路线图和开发文档
scripts/             # 仓库验证与构建脚本
apps/                # Electron launcher、bundled CLI（dsh-native）与独立 Host 入口
packages/            # 契约、home-lease、profile、插件、监督器与 shell-core
tests/               # 隔离 home 的源码级桌面冒烟与共享 home driver
```

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 Jesen。
