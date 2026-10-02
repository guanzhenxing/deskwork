# Deskwork（案头）

Deskwork（案头）是 DeepSeek Harness（DSH）的桌面壳：官方 DSH Web UI 运行在原生窗口、Dock 与托盘中，使用 Deskwork 自己的 home（默认 `~/.deskwork`）。一个很薄的 Electron launcher 负责启动、Host 进程监督、窗口，以及 Host 无法启动时仍可用的最低恢复控制面；`desktop-plugin` 只做一件事——把 Host 的已认证 loopback 地址交给 launcher。

本仓库不含产品功能层：壳启动 DSH 之后就让路。要加界面或功能，按 [bundle 样例](docs/examples/workbench-bundle.md)作为独立 DSH profile bundle 加入，不进壳的依赖图。

> Electron userData 目录名固定为 `Deskwork`，不随展示名变更。

## 功能特性

- 官方 DSH Web UI 的原生窗口、Dock、托盘、菜单与单实例生命周期；
- DSH Host 运行在独立 Node-capable 子进程中；Host 崩溃或启动失败时桌面壳保持存活，进入带结构化诊断的恢复窗口；
- 默认使用 `deskwork` profile（上游把 `desktop` 保留给官方应用）与 Deskwork 自己的 home `~/.deskwork`（不指向官方 CLI 的 `~/.dsh`）；
- 非破坏性启动恢复：profile 走逐文件修订事务，只在修订校验通过时回滚本次自动修改，绝不自动覆盖 home 级用户数据；
- Safe Mode：不加载正常 `desktop-plugin` 与第三方 bundle 的最小恢复会话；
- home 兼容性准入：数据 epoch 检查（marker 的 schemaVersion 与 dataEpoch），不安全的降级写入在发生前拒绝；
- 可复现打包：schema-2 发行清单、上游闭包对账与制品 SHA-256 绑定。

## 单一写入者

Deskwork 只有一个受支持的入口：桌面应用。启动时它构造一个 home session（本次运行对这份 home 的声明），Electron 的单实例锁阻止第二个桌面实例。

Host 进程自己持有 `<home>/run/host.lock` 的内核 `flock`：锁随进程消亡自动释放，因此"上一轮崩溃是否留下还在写的 Host"永远有确定答案。启动前 launcher 用同一把锁做一次判定——锁空闲就接管并清理陈旧记录，锁被持有则按 `<home>/run/host-owner.json` 记录的 pid 终止那个 Host，终止不掉就拒绝启动，绝不冒两个写入者的风险。

官方裸 `dsh` 默认使用它自己的 `~/.dsh`，与 Deskwork home 互不相干，不受本项目拦截。若手动用 `DSH_HOME` 把裸 `dsh` 指向 Deskwork home，它不经过任何拦截，需自行保证不与桌面端并发。

## 架构摘要

```text
Electron launcher
  → home session (this run's claim on the home)
  → profile-manager (deskwork profile reconcile)
  → host-supervisor
      → independent DSH Host (waits for boot authorization)
          → desktop-plugin
          → official DSH Web UI
```

进程创建、home lock 的取得与孤儿 Host 的处理、Electron 资源和 boot-independent 恢复属于 launcher；`desktop-plugin` 只在 Host 内发布 loopback surface。第三方 DSH 插件与 Host 同权运行，独立 Host 进程是故障边界而不是权限 sandbox。

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

构建产物位于 `release/dist/`，SHA-256 与内嵌清单见 `release/artifacts.json`。手动升级与回退见[升级指南](docs/upgrade-guide.md)。

## 使用

```bash
corepack pnpm@11.7.0 start   # 从源码启动桌面应用
```

## 开发基线

- Node.js：24.11.1；
- pnpm：11.7.0；
- DSH：[`dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.1)，commit [`4878cdabd87d4041bdaff61d04c966883b9fd07a`](https://github.com/deepseek-ai/deepseek-harness/commit/4878cdabd87d4041bdaff61d04c966883b9fd07a)。

机器可读版本权威是 [`docs/compatibility.json`](docs/compatibility.json) 与 lockfile；Markdown 中的版本只用于说明，不独立决定兼容性。上游基线与补丁对账见 [upstream-baseline](docs/upstream-baseline.md)。

常用开发命令：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check            # format/lint/typecheck/单测/文档检查
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 smoke:headless   # 纯 Node 启动 profile 并服务官方 UI（无 Electron）
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
corepack pnpm@11.7.0 smoke:profile-recovery
corepack pnpm@11.7.0 smoke:safe-mode
corepack pnpm@11.7.0 smoke:package    # 安装级制品冒烟
```

完整命令清单与工程规范见[开发指南](docs/development.md)。历史文档（v0.1.0 变更记录、转向前贡献指南、被取代的 v1 执行计划与 v1 蓝图）归档于 `docs/archive/`。

## 范围与限制

引擎基线：**`@deepseek-ai/dsh` 0.2.0-rc.1**；包版本号沿用 0.1.0。0.2.0-rc.1 基线的可安装制品已通过安装级验收（候选装上能启动，`smoke:package` 绿）。

以下能力不在当前版本内（进入条件见架构文档的进入条件表）：自动更新、插件市场、远程访问、setup wizard、桌面终端、多 profile UI、Windows/Linux 支持、预编译制品签名与公证。

## 文档

- [架构](docs/architecture.md)：组件、进程、信任边界和依赖方向；
- [bundle 样例](docs/examples/workbench-bundle.md)：如何把客户端界面注册进官方 UI；
- [Host-control 1.0](docs/protocols/host-control.md)：launcher/Host normative 协议；
- [home-compatibility 协议](docs/protocols/home-compatibility.md)：跨版本数据准入；
- [启动恢复分类协议](docs/protocols/startup-recovery.md)：失败分类、回滚资格与恢复窗口；
- [数据布局](docs/data-layout.md)：路径、所有权、恢复和迁移；
- [升级指南](docs/upgrade-guide.md)：手动升级、回退与升级演练；
- [upstream-baseline](docs/upstream-baseline.md)：上游 DSH 基线、闭包与补丁对账；
- [开发指南](docs/development.md)：环境、命令、测试与发布流程；
- [收敛方案 v3](docs/plan-v3.md)：本仓库的执行方案（阶段、验收与执行记录）；
- [冻结的产品需求](docs/deferred-work.md)：约 69 条已识别但未排期的功能，含各自的进入条件；
- [bundle 样例](docs/examples/workbench-bundle.md)：产品界面如何作为独立 bundle 加入；
- [安全策略](SECURITY.md)：威胁模型与未来能力进入条件；
- [兼容性清单](docs/compatibility.json)：Desktop、DSH、Electron、Node、pnpm 与协议版本的机器可读事实；

## 仓库结构

```text
.github/workflows/   # CI 门禁
docs/                # 架构、协议和开发文档（历史文档在 docs/archive/）
scripts/             # 仓库验证与构建脚本
apps/                # Electron launcher 与独立 Host 入口
packages/            # 契约、profile、插件、监督器与 shell-core
tests/               # 隔离 home 的源码级桌面冒烟与驱动
```

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 Jesen。
