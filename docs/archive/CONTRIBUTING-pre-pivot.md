# 贡献指南

感谢关注 DeepSeek Harness。本指南说明开发环境、工作流和门禁要求；更详细的工程规范、命令清单与发布流程见[开发指南](docs/development.md)。

## 开发环境

- macOS（打包、原生 lease helper 编译和桌面冒烟都依赖 macOS；需要 Xcode Command Line Tools）；
- Node.js 24.11.1；
- pnpm 11.7.0（通过 Corepack 调用：`corepack pnpm@11.7.0 …`）；
- Git 2.47 或兼容版本。

初始化：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

## 工作流

采用 trunk-based workflow：

- `main` 始终保持可验证；
- 使用短生命周期 `feat/<name>`、`fix/<name>`、`docs/<name>` 或 `chore/<name>` 分支，一个分支只解决一个可独立审查的问题；
- 提交保持小而完整，使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:` 前缀；
- 不把 DSH 基线升级与壳架构重构或产品功能放在同一分支。

每个变更先有一个可追踪的 issue 或 spec，至少写清：

- 用户或维护者要解决的问题；
- 范围和明确不改的内容；
- 影响的进程、数据和信任边界；
- 可观察的验收条件；
- 回滚或失败行为。

## 重大变更的先行设计评审

以下变化必须先写设计说明（记录问题、方案与被否决的备选），经评审后实施：

- 新增或改变进程/信任边界；
- 改变状态唯一权威或持久化 schema；
- 新增 privileged native capability；
- 公共协议 major version 变化；
- 选择 market provider、remote relay、设备凭据格式或 updater channel；
- 数据不可逆迁移或公开发布策略。

局部实现、可逆重构和 bug 修复使用 issue/spec 与测试即可，不为每次重构写设计说明。

## 测试要求

- Vitest 是主测试 runner（Node 内置 runner 用于边界脚本测试）；测试放在它们覆盖的包旁边，命名 `*.test.ts` / `*.integration.test.ts`；
- 改动协议、lease、profile、Host 生命周期或 privileged IPC 时，先写契约/状态机测试再实现；
- 集成与冒烟测试必须使用显式隔离的 `<testHome>`（见[数据布局](docs/data-layout.md)）；**绝不使用或删除真实 `~/.dsh`**；
- 每个变更运行 `corepack pnpm@11.7.0 check`；涉及进程、恢复或共享 home 的改动额外运行对应集成/冒烟命令。

## 提交 PR

PR 应说明：范围、验收证据、影响的进程/数据/信任边界、关联 issue 或 spec；UI 变更附截图。

不要提交 DSH home、credentials、authenticated URL、签名私钥或未脱敏日志。

## 安全问题

安全问题不要开公开 issue；报告方式与安全模型见 [SECURITY.md](SECURITY.md)。
