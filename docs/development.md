# 开发指南

- 入门与贡献流程见[贡献指南](../CONTRIBUTING.md)
- 架构与边界见[架构](architecture.md)

## 1. 开发环境

要求：

- macOS；
- Node.js 24.11.1；
- pnpm 11.7.0；
- Git 2.47 或兼容版本；
- Xcode Command Line Tools（编译原生 lease helper 与打包）。

Node engines 与上游 DSH 基线保持为 `^22.19.0 || >=24.0.0`，本仓库开发和 CI 选择固定的 24.11.1。pnpm 11.7.0 与当前 DSH 基线一致。

初始化：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

## 2. 目录结构

```text
deepseek-harness-desktop/
├── .github/workflows/            # CI 门禁（check / macOS 集成与冒烟 / 候选打包）
├── apps/
│   ├── desktop-launcher/         # Electron 自举入口：应用身份、窗口/托盘/菜单、恢复 UI 与打包配置
│   └── bundled-cli/              # dsh-native 包装进程：lease、子进程身份登记与退出码契约
├── packages/
│   ├── desktop-plugin/           # DSH bundle 插件，Desktop 产品集成主体（正常 surface 发布者）
│   ├── desktop-recovery-bridge/  # Safe Mode 最小第一方 bundle（recovery surface 发布者）
│   ├── desktop-contracts/        # 按能力分入口、独立版本的可序列化窄控制契约
│   ├── host-supervisor/          # 独立 Host 进程创建、握手校验、稳定性窗口与有界关停
│   ├── profile-manager/          # ProfileRef、reconcile、修订事务恢复与 Safe Mode 投影
│   ├── home-lease/               # 整 home 排他 lease、owner 身份与 doctor 清锁
│   ├── release-compatibility/    # home 兼容性准入：marker、格式勘察、预检与写入预约
│   ├── product-config/           # 产品身份常量（产品名、数据目录名、CLI 名、默认 profile 名）
│   └── shell-core/               # Electron 生命周期编排、窗口、托盘、日志与恢复状态
├── scripts/                      # 构建与校验脚本：staging、打包、闭包/补丁对账、发行证据、升级演练、文档校验
│   └── dsh-native.mjs            # dsh-native 开发入口（持 lease）
├── tests/
│   ├── smoke/                    # 源码级与安装级桌面冒烟（dsh-ui/host-crash/package 等）
│   ├── helpers/                  # 隔离 home fixture、共享 home driver、mock LLM、启动性能探针
│   ├── fixtures/                 # home 格式、插件引入与安装控制器测试夹具
│   └── upgrade/                  # 跨版本升级演练驱动与夹具
├── build/                        # 兼容性策略、上游制品记录、electron-builder 配置与图标素材
├── patches/                      # 本地补丁账本（当前为空账本）
└── docs/                         # 架构、协议、数据布局、路线图与开发文档
```

各 package 的职责与依赖方向详见[架构](architecture.md)。

## 3. 命令清单

| 命令                                        | 用途                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| `pnpm build`                                | 构建全部 TypeScript project references                      |
| `pnpm start`                                | 从仓库根启动桌面应用（转发到 launcher 的 `electron .`）     |
| `pnpm build:icons`                          | 从原创 SVG 生成 ICNS 与托盘模板（macOS 自带工具）           |
| `pnpm build:native`                         | 编译原生 lease helper（需要 Xcode CLT）                     |
| `pnpm format:check`                         | 检查格式但不修改文件                                        |
| `pnpm lint`                                 | 静态规则与依赖边界                                          |
| `pnpm typecheck`                            | 全仓库 TypeScript 类型检查                                  |
| `pnpm test:unit`                            | 纯函数、schema、state machine 和组件单元测试                |
| `pnpm test:integration`                     | 构建后用隔离 home 启动真实 DSH Host 和官方 Web surface      |
| `pnpm test:shared-home`                     | 双向共享 home 会话接续（Desktop/CLI 互续）                  |
| `pnpm stage:runtime`                        | 物化自含 staging 闭包（Host/CLI/Node/pnpm/helper）          |
| `pnpm verify:runtime-tree`                  | 校验 staging 完整性、符号链接闭包、singleton 与原生 ABI     |
| `pnpm generate:compatibility`               | 生成机器可读兼容性清单                                      |
| `pnpm verify:compatibility`                 | 校验清单与依赖锁一致                                        |
| `pnpm verify:dsh-closure`                   | lockfile/清单侧 DSH 依赖闭包对账                            |
| `pnpm verify:patches`                       | 本地补丁账本校验                                            |
| `pnpm package:dir`                          | icons → staging → 校验 → 未打包 `.app`（ad-hoc 签名）       |
| `pnpm package:dmg`                          | 在 staging 之上生成 DMG 候选                                |
| `pnpm smoke:dsh-ui`                         | 独立 Electron/Host PID 的最小官方 DSH UI 闭环               |
| `pnpm smoke:host-crash`                     | 只终止 Host，验证 launcher 恢复页与最终无残留进程           |
| `pnpm smoke:profile-recovery`               | 修订恢复不变量                                              |
| `pnpm smoke:safe-mode`                      | Safe Mode 隔离                                              |
| `pnpm smoke:conversation`                   | 创建会话、发送一轮、重启后恢复                              |
| `pnpm smoke:auth` / `smoke:navigation`      | 认证 URL 与导航/外链策略                                    |
| `pnpm smoke:lifecycle`                      | 关窗隐藏、托盘唤出、重复启动聚焦、退出无残留                |
| `pnpm smoke:package`                        | 安装级制品冒烟（对 `.app`/DMG 副本执行）                    |
| `pnpm smoke:startup-performance`            | 启动性能测量                                                |
| `pnpm verify:plugin-intake`                 | 插件引入制品级隔离演练                                       |
| `pnpm check:docs`                           | 检查必需文档、兼容性事实、本地链接与文本格式                |
| `pnpm check`                                | 全部快速阻塞门禁                                            |
| `pnpm dsh-native -- <args>`                 | 配套 CLI 开发入口（持 lease）                               |

打包固定 electron-builder 26.15.3（配置 schema 以安装包内的 app-builder-lib 为准）；Host/CLI 运行时全部来自 `release/staging`（pnpm `--prod` deploy + 官方 Node/pnpm 制品校验），`.app` 内不依赖仓库 `node_modules`、pnpm store、系统 Node/pnpm 或 ASAR 虚拟路径。

`pnpm smoke:package` 与 `verify:plugin-intake` 都在安装制品（`.app`/DMG 副本）上执行，源码 smoke 不构成安装包验收。

命令名是仓库契约；package 内部脚本可以变化，但 CI 和开发文档不引用临时实现路径。

## 4. 工作项分类

每个变更先有一个可追踪的 issue 或本地 spec，至少写清：用户或维护问题、范围和明确不改的内容、影响的进程/数据和信任边界、可观察验收条件、回滚或失败行为。

以下变化必须先写设计说明并经评审：

- 新增或改变进程/信任边界；
- 改变状态唯一权威或持久化 schema；
- 新增 privileged native capability；
- 公共协议 major version 变化；
- 选择 market provider、remote relay、设备凭据格式或 updater channel；
- 数据不可逆迁移或公开发布策略。

局部实现、可逆重构和 bug 修复使用 issue/spec 与测试即可，不为每个提交写设计说明。

## 5. 分支与提交

采用 trunk-based workflow：

- `main` 始终保持可验证；
- 使用短生命周期 `feat/<name>`、`fix/<name>`、`docs/<name>` 或 `chore/<name>`；
- 一个分支只解决一个可独立审查的问题；
- 提交保持小而完整，使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:` 前缀；
- 不把 DSH baseline 升级与壳架构重构或产品功能放在同一分支；
- 不提交真实 DSH home、credentials、authenticated URL、签名私钥或脱敏前日志。

## 6. 实施循环

每个工作项遵循：

```text
issue/spec
→ boundary review
→ design review when required
→ smallest vertical slice
→ contract/unit tests
→ implementation
→ integration and failure injection
→ packaged-artifact smoke when applicable
→ standards/spec/security review
→ merge
```

### 6.1 最小纵向切片

优先交付可观察的端到端路径，而不是先铺满所有抽象：一条切片必须从 launcher 创建 Host runner，一直走到 `desktop-plugin` 发布 surface 并挂载官方 UI；不能只完成一组没有运行路径的 package skeleton。

### 6.2 Contract-first 与 TDD

以下部分先写失败测试，再实现最小行为：

- Host-control schema、版本协商和状态机；
- home lease acquisition/release/doctor；
- `ProfileRef` 与 reconcile；
- 修订校验恢复；
- Host supervisor 的启动、ready、crash 和 dispose；
- privileged Electron IPC 验证。

跨进程协议保留 launcher-new/Host-old 和 launcher-old/Host-new 双向 fixtures。测试不得仅断言 TypeScript 编译通过。

### 6.3 Fixture 与故障注入

profile、lease、会话和迁移测试只使用[数据布局](data-layout.md)规定的 `<testHome>`。

按变更范围主动注入：

- Host 在 hello、surface、ready、dispose 各阶段退出；
- launcher 在 profile transaction 各原子边界退出；
- stale、身份不明和 generation 不匹配 lease；
- profile SHA 被外部修改；
- renderer 导航、origin 和 IPC 参数非法；
- 打包环境缺少仓库 `node_modules`。

测试结束后先验证临时目录身份，再执行清理；不对环境变量展开后的宽路径做递归删除。

## 7. 审查门禁

| 变更范围                | 必须通过                                                        |
| ----------------------- | --------------------------------------------------------------- |
| 所有变更                | `pnpm check`、spec 验收、相关文档同步                           |
| schema/state machine    | unit tests、双向 contract fixtures、错误/重放用例               |
| profile/home/lease      | unit、隔离 home integration、crash recovery、真实 home 不变证明 |
| Host 进程               | lifecycle integration、残留进程检查、crash-loop 上限            |
| Electron/IPC/navigation | security review、错误 sender/origin/schema 测试                 |
| runtime/build/package   | `.app`/DMG 冒烟，不只运行开发入口                               |
| DSH baseline            | 兼容性清单、补丁对账、完整测试与独立升级分支                    |
| market/remote/updater   | 设计评审、threat-model review、供应链/授权/迁移专项测试        |

审查沿两个轴分别给结论：

1. Standards：是否符合架构、安全和开发规范；
2. Spec：是否实现工作项要求，有无遗漏或范围漂移。

## 8. 文档规则

| 文档                          | 内容权威                       | 何时更新                         |
| ----------------------------- | ------------------------------ | -------------------------------- |
| `README.md`                   | 用户入口、范围和最小命令       | 用户可见范围或启动方式变化       |
| `CHANGELOG.md`                | 版本级显著变更                 | 每次发布                         |
| `CONTRIBUTING.md`             | 贡献入口与工作流               | 流程或门禁变化                   |
| `docs/architecture.md`        | 当前组件、进程、信任和依赖边界 | 架构现状变化                     |
| `docs/roadmap.md`             | 范围外能力与进入条件           | 范围或规划变化                   |
| `docs/protocols/**`           | normative 跨边界协议           | schema、状态机或版本支持变化     |
| `docs/data-layout.md`         | 路径、所有权、备份和迁移       | 新持久化状态或迁移出现           |
| `SECURITY.md`                 | 威胁模型和安全进入条件         | 信任边界、发行或报告流程变化     |

版本事实只从依赖锁或 [`compatibility.json`](compatibility.json) 生成。不要在多个 Markdown 文件中手工维护不同的“当前版本”。

`pnpm check:docs` 必须随新增文档继续验证本地链接和格式。

## 9. 发布流程

发布本机候选 DMG 的完整链：

1. 链首干净树门（只允许已提交字节）；
2. `pnpm check`（format/lint/types/unit/docs）；
3. `generate:compatibility` + `verify:dsh-closure` + `verify:patches`（清单再生成、闭包零漂移、补丁账本）；
4. `package:dir` + `package:dmg`（icons → staging → 门禁 → 未打包 `.app` 与 DMG 候选，ad-hoc 签名）；
5. `smoke:package`（安装级制品冒烟：`.app`/DMG 副本装上能启动、官方 UI 可达）；
6. 链尾干净树门 + `git diff --check`。

链外要求：人工使用一个观察周期后才把候选标记为当前版本；保留上一健康 DMG 作为二进制回退候选。手动升级与回退步骤见[升级指南](upgrade-guide.md)。

公开源代码不要求 Developer ID、hardened runtime 或 notarization。公开分发预编译二进制前必须另行设计评审，完成 Developer ID、hardened runtime、notarization、隐私说明、正式安全联系和更新通道。

## 10. 测试与证据基线

当前基线（合并任何变更前必须保持继续通过）：

- `desktop-contracts`、`profile-manager`、`desktop-plugin`、`desktop-recovery-bridge`、`host-supervisor` 与 `shell-core` 均有自动测试；
- Electron Main 的监督器根入口不导出 Host runner，只有独立 `host-entry` 加载 DSH；
- `pnpm test:integration` 从独立 Node PID 验证 authenticated official boot graph；
- `pnpm test:shared-home` 验证 Desktop/CLI 双向会话接续与互斥；
- `pnpm smoke:dsh-ui` 验证官方 modules、侧栏、会话输入区域和设置入口；
- `pnpm smoke:host-crash` 验证 Host 崩溃不带走 launcher，并验证最终无残留 PID；
- 所有测试和开发启动使用显式隔离 home，不触碰默认 DSH home。

引入新的进程、恢复或共享 home 行为时，先保持这些证据继续通过，再扩展对应测试。
