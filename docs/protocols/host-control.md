# Host-control 协议 1.0

- 协议名：`dsh-desktop/host-control`
- major：`1`
- minor：`0`
- 状态：normative（当前实现）

## 1. 适用范围

Host-control 是 Electron launcher 与其创建的单个 DSH Host runner 之间的私有、结构化、transport-neutral 控制协议。

它只解决：

- Host 身份与启动 mode 握手；
- 启动阶段和失败报告；
- authenticated loopback surface handoff；
- Host 就绪；
- 有界 dispose。

它不是 DSH 业务 RPC、远程访问协议、插件身份协议或任意 Electron 调用入口。会话、设置和工具调用继续使用正式 DSH 服务、typed Remote、SDK 或其他业务 carrier。

## 2. Transport 与 bootstrap

当前实现使用 Electron `utilityProcess` 的消息端口；若改用打包 Node 子进程，必须提供相同的消息语义和契约测试。

launcher 在启动 Host 前创建：

- 至少 256 bit 的随机 `capability`；
- 当前 home session 的随机 `leaseGeneration`（协议字段名沿用）：真实 home 绑定本次运行的 session generation，隔离冒烟入口使用每次启动生成的 channel generation；
- 预期 profile、mode 和 Host 进程身份；
- 专用消息通道。

`capability` 只能通过专用 IPC bootstrap 交给 Host runner，不能放入命令行、环境变量、stdout、普通日志或持久化文件。每次 Host runner 创建都使用新 capability 和 sequence 空间；Host 重启不得复用旧通道。

## 3. Envelope

每条消息使用以下 envelope：

```ts
type ProtocolVersion = {
  name: 'dsh-desktop/host-control'
  major: 1
  minor: 0
}

type Envelope<Message> = {
  protocol: ProtocolVersion
  direction: 'launcher-to-host' | 'host-to-launcher'
  capability: string
  leaseGeneration: string
  sequence: number
  message: Message
}
```

约束：

- `sequence` 是每个方向独立、从 `1` 开始、每次加一的安全整数；
- capability 和 session generation 必须常量时间比较；
- direction 必须与实际接收端一致；
- schema 必须拒绝额外的可执行值、原型污染键、非有限数字和超出限制的字符串；
- 任何校验失败都关闭通道并使本次 Host 候选失败，不向对端返回秘密或详细解析信息。

## 4. 消息

### 4.1 Host → launcher

```ts
type HostToLauncherMessage =
  | {
      kind: 'hello'
      host: { pid: number; startIdentity: string }
      profile: { name: string }
      mode: 'normal' | 'safe'
      supportedMinor: { min: 0; max: 0 }
    }
  | {
      kind: 'phase'
      phase: 'booting' | 'services-ready' | 'surface-waiting' | 'draining'
    }
  | {
      kind: 'surface'
      surfaceId: string
      purpose: 'normal' | 'recovery'
      surface: { kind: 'loopback'; url: string }
    }
  | {
      kind: 'ready'
      surfaceId: string
    }
  | {
      kind: 'dispose-ack'
      outcome: 'disposed' | 'already-disposed'
    }
  | {
      kind: 'fatal'
      stage: string
      code: string
      summary: string
      retryable: boolean
    }
```

`hello` 必须是 Host 的第一条消息。Host 的 PID 与 start identity 必须匹配 launcher 实际创建的子进程，profile 和 mode 必须匹配本次启动请求。

normal mode 只能发布 `purpose: 'normal'`，publisher 是 `desktop-plugin`；safe mode 只能发布 `purpose: 'recovery'`，publisher 是 `desktop-recovery-bridge`。launcher 校验 mode 和 purpose，不把 JavaScript 包名当作身份凭据。

`fatal.summary` 是经过清理、适合展示的短文本。完整 stack 和路径只进入受限本地诊断日志，不能进入协议普通摘要。

### 4.2 Launcher → Host

```ts
type LauncherToHostMessage =
  | {
      kind: 'accept'
      selectedMinor: 0
    }
  | {
      kind: 'dispose'
      reason: 'quit' | 'restart' | 'profile-switch' | 'update'
      deadlineMs: number
    }
```

`accept` 必须是 launcher 对合法 `hello` 的第一条响应。`deadlineMs` 是 `1000..30000` 的整数；它只是 graceful dispose 截止时间，不授权 Host 延长 launcher 的 terminate/kill 上限。

## 5. 协议状态机

```text
channel-created
→ hello-received
→ accepted
→ booting
→ surface-received
→ host-ready
→ draining
→ disposed
```

任意非终态都可以进入 `failed`。具体规则：

1. `hello` 之前收到其他消息：失败；
2. launcher 在 `accept` 前不接受 phase、surface 或 ready；
3. `phase` 只能沿 `booting → services-ready → surface-waiting → draining` 前进，可以跳过中间阶段但不能回退；
4. v1 每个 Host generation 只接受一个 `surfaceId` 和一次 surface；
5. `ready.surfaceId` 必须匹配已经接受的 surface；
6. 重复 hello、surface、ready、fatal 或 dispose-ack：失败；
7. `fatal`、`dispose-ack` 与通道关闭是终态；终态之后的消息被拒绝；
8. launcher 只有在 Host ready、BrowserWindow 成功加载且稳定性窗口通过后，才把应用和 profile 标记为 healthy。

launcher 可以在 `accepted` 之后的任意非终态发送 dispose 并进入 `draining`，不需要等待 surface 或 ready。

如果 Host 在 surface 之前失败，launcher 显示 launcher-owned 恢复页。如果 Host 在应用 ready 后退出，launcher 销毁旧 renderer surface 并保留恢复窗口。

## 6. Surface 校验

v1 surface 必须满足：

- `surface.kind` 精确为 `loopback`；
- URL scheme 为 `http:` 或 `https:`；
- hostname 精确为 `127.0.0.1`；
- port 是显式、有效的非零端口；
- URL 不含 username、password 或 fragment；
- main frame 只允许该 URL 最终 origin 的同源导航和重定向；
- URL 和其中的 token/capability 不写入普通日志、崩溃摘要或分析事件。

launcher 不能仅因 URL 是 loopback 就授权 privileged Electron IPC。renderer IPC 仍须校验 BrowserWindow、main frame、当前 origin 和参数 schema。

## 7. 版本协商

`hello.supportedMinor` 声明 Host 在 major 1 下支持的闭区间。launcher 选择双方交集中最高 minor，并通过 `accept` 返回。

规则：

- 协议名或 major 不匹配：拒绝启动；
- minor 无交集：拒绝启动；
- 同一 major 内只能新增可选字段，或新增协商 minor 才允许发送的消息；
- 接收方可以忽略当前 minor 中未知的可选字段，但不能忽略未知消息 kind；
- 发送方不能在协商为 0 时发送未来 minor 的消息；
- 每个受支持的 minor 都必须保留 Host-old/launcher-new 与 Host-new/launcher-old 双向 fixture。

Host-control 的版本不跟随 Desktop 应用版本、DSH 版本或其他 capability 版本同步递增。

## 8. 关停与超时

launcher 发送一次 `dispose` 后进入 draining：

1. Host 停止接受新任务；
2. Host dispose DSH services；
3. Host 发送 `dispose-ack` 并退出；
4. launcher 等待进程退出；
5. 超时后先 terminate，最后才 force kill；
6. Host 确认退出即释放它自己持有的 home lock。

重复的 launcher 关停请求在本地合并，不向 Host 发送多个 dispose。Host 若已经完成 dispose，可以返回 `already-disposed`。

## 9. 本地诊断分类

launcher 至少使用以下稳定错误 code；它们是诊断分类，不是可本地化 UI 文案：

| Code                     | 含义                               |
| ------------------------ | ---------------------------------- |
| `PROTOCOL_MISMATCH`      | name、major 或 minor 无法协商      |
| `INVALID_ENVELOPE`       | schema、direction 或 sequence 非法 |
| `INVALID_CAPABILITY`     | capability 不匹配                  |
| `LEASE_MISMATCH`         | session generation 不匹配          |
| `HOST_IDENTITY_MISMATCH` | PID/start identity 不匹配          |
| `INVALID_TRANSITION`     | 消息不符合状态机                   |
| `SURFACE_REJECTED`       | purpose 或 loopback URL 校验失败   |
| `BOOT_FAILED`            | Host 在 ready 前报告 fatal 或退出  |
| `HOST_CRASHED`           | ready 后 Host 异常退出             |
| `DISPOSE_TIMEOUT`        | graceful dispose 未在时限内完成    |

普通日志记录 code、阶段、应用版本和匿名 Host generation。不得记录 capability、authenticated URL、完整 home 路径、凭据、会话内容或远程设备秘密。

## 10. 契约测试

至少覆盖：

- 合法 normal hello → accept → phases → surface → ready；
- future launcher 与 1.0 Host 的 minor 交集；
- 协议名、major 和 minor 无交集；
- capability、session generation、direction、PID 和 start identity 错误；
- sequence 重复、跳号、倒退和非安全整数；
- ready-before-surface、purpose/mode 不匹配和重复终态；
- 非 `127.0.0.1`、隐式/非法端口、userinfo 和 fragment URL；
- dispose ack、dispose 超时和 Host 退出；
- error/log serializer 对 capability、URL token 和 home 路径的脱敏；
- 契约包不依赖 Electron，也没有任意方法名或通用 runtime 入口。
