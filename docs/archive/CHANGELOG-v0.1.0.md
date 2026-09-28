# 更新日志

本项目的重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.1.0] - 2026-09-08

首个版本。macOS（darwin-arm64）本机构建，基线上游 DSH `dsh-v0.1.2-rc.1`。

### 新增

- 官方 DSH Web UI 的原生桌面壳：窗口、Dock、托盘、菜单、单实例、窗口状态恢复与受控外链；
- DSH Host 独立子进程运行与 [Host-control 1.0](docs/protocols/host-control.md) 私有控制协议；Host 崩溃后壳存活并进入恢复窗口；
- 整 home [lease](docs/protocols/home-lease.md)：Desktop 与 `dsh-native` CLI 顺序共享 `~/.dsh`，双向会话接续，`doctor --unlock` 受控清锁；
- 逐文件修订事务的 profile 恢复、恢复窗口（有界重试预算）与 [Safe Mode](docs/protocols/startup-recovery.md)（`desktop-safe-mode` profile + 第一方 `desktop-recovery-bridge`）；
- [home 兼容性准入](docs/protocols/home-compatibility.md)：marker + 只读格式勘察 + 预检 + 写入预约，未知格式与不安全降级在写入前拒绝；
- 可复现打包与发行证据：schema-2 发行清单、确定性 SBOM、许可证清单、DMG 摘要绑定、安装级冒烟与升级/降级演练（`verify:release` 链）；
- [插件引入](docs/plugin-intake.md)审查工作流：intake 记录 schema 1 + 校验器 + 制品级隔离演练；
- `dsh-native` CLI 包装：lease 获取、子进程 OS 身份登记、退出码契约。

### 人工验证

- Dock 图标与 Dock 右键退出已于 2026-09-09 验证通过。

### 已知限制

- 本地自用构建：未签名/未公证（Gatekeeper 首次启动需右键打开），无自动更新器；
- 第三方 bundle 的引入审查可用，但第三方 bundle 在 profile 内启动不可用（嵌入式 loader 按名解析的布局限制，见[插件引入](docs/plugin-intake.md)）；`verify:plugin-intake` 的启动轮在该设计落地前保持失败；
- 仅 darwin-arm64；插件市场、远程访问、setup wizard、桌面终端、多 profile UI 不在当前范围（见[路线图](docs/roadmap.md)）。
