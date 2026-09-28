# Security Policy

## 当前范围

本项目是面向个人本机使用的 macOS Desktop，源代码可公开并由使用者自行构建；项目当前不公开分发预编译二进制、不监听非 loopback 地址，也不实现插件市场安装、远程控制或自动更新。

安全模型由[架构](docs/architecture.md)、[Host-control 协议](docs/protocols/host-control.md)和[数据布局](docs/data-layout.md)共同约束。

## 信任模型

以下组件属于发行版信任基：

- Electron launcher、preload 与打包配置；
- Host runner、`home-lease`、`profile-manager` 和 `host-supervisor`；
- `desktop-plugin` 与最小 `desktop-recovery-bridge`；
- 精确固定并经本项目验证的 DSH runtime；
- 更新能力引入后的更新签名信任根。

Electron renderer 视为需要隔离的 Web 内容。它不拥有 Node.js、任意 Electron IPC 或 Host-control capability。

第三方 DSH 插件不是 sandboxed code。它们与 Host 同进程运行，并继承当前用户权限。进程隔离只能保护 Electron 生命周期和恢复控制面，不能阻止恶意插件读取用户可访问的数据或调用 Host 内可见服务。

## 必须保护的资产

- DSH credentials、settings、sessions 和 storages；
- Host-control capability、lease generation 和 authenticated loopback URL；
- profile generation、更新元数据和兼容性清单；
- 未来远程设备的私钥、principal、scope 与审计记录；
- 更新签名信任根和已校验发行制品。

## Electron 与本地 IPC

- BrowserWindow 启用 `contextIsolation`、`sandbox`、`webSecurity`，禁用 `nodeIntegration`；
- Electron Main 与 renderer 不加载 DSH Host 或第三方插件代码；
- privileged IPC 校验发送 BrowserWindow、main frame、当前可信 origin 和参数 schema；
- 主 frame 只允许 authenticated URL 最终 origin 的同源导航；
- 新窗口拒绝，允许的外部协议交给系统浏览器；
- loopback URL 不是 privileged IPC 的授权证明；
- Host-control 拒绝错误 capability、lease generation、Host identity、sequence、版本和状态转移；
- capability 不通过命令行、环境变量、stdout、普通日志或磁盘传递。

## 原生能力与用户确认

Host-process capability 只能证明消息来自 launcher 创建的 Host，不能证明是哪一个插件调用了 Host 服务。

以下动作必须经过能力级策略和 launcher-owned 本地确认：

| 动作                       | 最低确认规则                                                 |
| -------------------------- | ------------------------------------------------------------ |
| 安装、禁用、回退或导入插件 | 展示准确 profile、package、版本、publisher、摘要和影响后确认 |
| 安装 Desktop 更新          | 下载前提示；安装前再次确认版本、channel、签名和迁移结果      |
| 创建或删除远程设备凭据     | 展示设备和 scope，并由本机确认                               |
| 导出秘密                   | 默认不提供；需要单独的安全设计评审才能增加                   |
| 终端或系统级操作           | 展示准确操作目标，不接受 UI 传入任意 shell 字符串            |

未来引入 secure-store / 设备能力后，常规已授权设备握手可调用其用途受限签名操作而不逐次弹窗，但 Host 永远不能取得原始私钥。该能力当前不存在，本句为设计约束。

## DSH home 与 profile

- 同一 home 同时只允许一个受支持 Host writer；
- Desktop 与 `dsh-native` 在任何 boot、profile mutation 或 cache 隔离前获取整 home lease（`<home>/run/host.lock` + guard 短临界区，见 [home-lease 协议](docs/protocols/home-lease.md)）；owner 未知或进程活跃时拒绝清锁，`doctor --unlock` 不提供 force 绕过；
- 受支持的隔离冒烟入口使用 `<userData>` 下的专属隔离 home，不触碰共享 home；
- lease 不按年龄自动抢占；
- profile 恢复只处理白名单并要求候选 SHA 仍匹配；
- Desktop 不自动回滚 credentials、settings、home patch、sessions 或 storages；
- 所有路径验证绝对父目录并拒绝危险 symlink；
- 自动化测试绝不能使用真实 `~/.dsh`（官方应用的家）或 `~/.deskwork`（Deskwork 自己的家）。

## 插件市场进入条件

开放安装前必须具备：

- 只读 catalog 和兼容性检查；
- 受信来源、准确 publisher、精确版本和制品摘要；
- Safe Mode recovery bridge；
- 不可变 generation、事务 journal、last known good 与 crash recovery；
- Host singleton/peer compatibility 校验；
- drift 导入/修复和定点禁用；
- 明确提示第三方插件拥有当前用户权限。

权限清单在没有代码 sandbox 前只能用于告知和策略拒绝，不能声称已隔离恶意插件。

## 远程访问进入条件

Deskwork 始终绑定 loopback。独立 bridge 只能转发受限 surface，不得成为授权权威。

远程访问开始前必须在固定 DSH 基线上证明：

- principal 从 carrier 传播到 Host；
- 每个目标方法执行前检查 scope；
- 设备可逐个撤销；
- 审计事件可归属到设备和操作；
- 传输使用 TLS 或等价可信 relay。

如果上游缺少逐方法授权扩展点，远程控制保持未实现，不以 IP allowlist、隐藏按钮或本地 browser cookie 代替。

## 更新进入条件

更新能力必须提供 Developer ID 签名、hardened runtime、notarization、可信元数据签名和迁移预检。

launcher 保存校验后的 last-effective policy，并内置 Host 插件不能替换的信任根和 emergency stable source。Host 无法 boot 时，只允许使用这两类来源。旧版 DMG 不被允许假定能读取新版数据：home 准入按 marker 的 dataEpoch 拒绝（`HOME_DATA_UNSUPPORTED`），数据保持原状。

## 日志和诊断

普通日志可以记录阶段、错误 code、应用/DSH 版本、profile 名和匿名 generation。

不得记录：

- credentials 或 session 内容；
- Host-control capability；
- authenticated URL 或 token；
- 原始设备私钥或长期秘密；
- 完整 home 路径；
- 未经清理的命令行和环境变量。

本地诊断包在导出前必须再次执行脱敏，并由用户明确选择。

## 报告安全问题

发现安全问题时，通过 GitHub 私密漏洞报告提交（仓库 Security 页的 "Report a vulnerability"）；仓库仍为私有时，使用与仓库所有者既有的私有沟通渠道。任何渠道都不得附带 credentials、authenticated URL、home 内容或设备秘密，也不要用公开 issue 或日志粘贴报告安全问题。

公开分发预编译二进制前会补充支持版本窗口、响应时限和安全公告流程。
