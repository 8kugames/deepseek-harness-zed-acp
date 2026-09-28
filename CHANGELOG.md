# 更新日志

本项目的所有显著变更都会记录在此文件。本格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-29

### 变更

- peer 依赖与开发依赖从 `0.1.7-rc.2` 全面对齐到 `0.2.0-rc.1`，使插件可安装在 dsh `0.2.0-rc.1` 运行时上（旧声明会被插件管理器以 peerDependencies 不兼容为由拒绝安装）。

### 新增

- 协作模式选择器：桥在 `session/new` / `session/resume` 的 `configOptions` 中发布 `category: "mode"` 的 `session_mode` 选项（Default / Plan），与旧的 `modes` 字段并存。两条路径都收敛到同一份 `planMode` 状态，切换后以既有的 `current_mode_update` 通知客户端；未组合 plan-mode 的部署不发布该选项。
- `imageInputs` 配置项：`'auto'`（默认）保持"路由必须声明图像输入"的严格探测；`true` 在挂载了附件存储时无条件声明图像输入，供目录未披露 `inputModalities` 的适配器使用；`false` 永不声明。无论取哪个值，逐条提示的路由校验仍然拒绝真正不接受图像的模型。
- `minimal` 预设补齐 `plan-mode` 组合（与 standard / ptc / cordis 一致的 `planning` 分组与 guidance section）。

### 修复

- 初始化时的图像能力探测不再使用插件配置里静态钉死的 provider/model，而是探测新会话实际起始的路由（显式 pin 优先，其次组合的 agent-default-model 默认选择）。此前部署中 pin 指向已退役或不存在的模型 id 时，`promptCapabilities.image` 恒为 false，Zed 端完全无法输入图片。
- 初始模型选择（model/reasoning 芯片的 current 值与新会话回退路由）同样回填自 agent-default-model；bundle 层不再默认钉死 `deepseek-official/deepseek-v4-flash`（已退役 id），新会话直接继承组合默认模型，与 bundle 注释宣称的设计一致。
- Zed 代理面板此前没有模式选择器：桥只发布旧的 `SessionModeState`，而当前 Zed 走 `category: "mode"` 的配置项路径，`modes` 字段仅作兼容。
- 选中 `minimal` 预设（或默认落到它）时该预设未组合 `plan-mode`，模式切换静默不可用。

## [0.1.1] - 2026-09-28

### 新增

- 工具调用 `locations`: `tool_call` 与完成的 `tool_call_update` 从文件型参数（`path`/`file_path`/`filePath`/`file`）携带标准跟随式位置，供客户端的 follow-along 特性使用。
- 展示终端：客户端在 `initialize` 声明 Zed `terminal_output` 扩展（`clientCapabilities._meta`）时，`execute` 类工具调用嵌入标准 `terminal` 内容块（以 callId 为展示终端 id），结果把捕获输出经 `_meta.terminal_output` 流上终端并以 `_meta.terminal_exit` 收束（失败退出码 1）；未声明的客户端保持纯文本投影。
- 计划投射：`todo/write` 快照投射为 ACP `plan` 更新（条目一一对应，优先级恒 `medium`，非法条目丢弃、未知状态回退 `pending`）。
- 会话标题：`session/title` 事件投射为 `session_info_update`。
- 斜杠命令：会话创建/恢复时与宿主 `commands/change` 事件后发布 `available_commands_update`（宿主命令注册表的有效目录，同名去重）；新增可选 peer 依赖 `@deepseek-ai/dsh-commands` 与 `@deepseek-ai/dsh-tool-todo`。

### 变更

- 删除回合末尾的 Turn stats markdown 卡片：正常收尾的回合只发携带累计费用与 `dsh._meta` 机器可读统计的最终 `usage_update`。
- 终态 `usage_update` 的 `dsh._meta` 统计口径对齐 dsh 自身分桶：输入拆为互斥三桶（`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens`，取代原 `inputTokens` 净额），并新增 `llmMs`/`toolMs`/`decodeMs`/`decodeTokens`/`ttftAvgMs`/`outputTps` 时序字段。
- `current_mode_update` 的构造从 `src/session.ts` 移入 `src/updates.ts`（事件路由与 update 构造分职）。

### 修复

- tool_call 标题提取: 把 code 加入 SALIENT_TITLE_FIELDS(位于 command 之后), 让 dsh 保留的 PTC run_code 工具在 Zed(kind=execute → 'Run Command')下显示其执行的 TypeScript 代码体, 而不是描述性 description 短语。其他工具的标题因字段不冲突保持不变。

## [0.1.0] - 2026-09-28

首次发布：作为 DeepSeek Harness (`@deepseek-ai/dsh@0.1.7-rc.2`) 的 Zed ACP 适配器插件，对应 ACP SDK `@agentclientprotocol/sdk@1.4.0`。

### 新增

- ACP 协议服务：`initialize` / `authenticate` / `session.{new,list,resume,close,setConfigOption,setMode,cancel}` / `prompt` 全部端点。
- `deepseek-api-key` 认证方法，启动时校验凭据是否解析可用，缺失时给出可操作的错误说明。
- 会话模式：通过 `session/set_mode` 在 `default` 与 `plan` 之间切换，并以 `current_mode_update` 实时通知客户端。
- 配置选项：`preset`（agent 预设）、`permission`（沙箱/审批预设，本地化文案）、`model` 与 `reasoning_effort`。
- 工具调用更新：标准 `kind` 映射（`edit` / `read` / `search` / `execute` / `fetch` / `switch_mode`），`write`/`edit` 结果以原生 ACP `diff` 内容块呈现。
- 助手消息：推理块走 `agent_thought_chunk`，正文走 `agent_message_chunk`，每轮结束附带上下文占用 `usage_update`。
- 图像提示：当连接声明 `promptCapabilities.image` 时，按四类受控栅格格式（png / jpeg / webp / gif）做严格 base64 解码与路由二次校验，缓存可寻址写入。
- MCP 装载：把会话级 `mcpServers` 列表翻译到 dsh-mcp-client；stdio 命令解析 PATH 上的可执行名，HTTP URL 白名单 http/https，header 通过 Node `validateHeaderName/Value` 校验，环境条目防 `__proto__` 注入。
- 单选用户问题（plan review）：经由 `session/request_permission` 通道表达。
- 回合统计：每轮以 markdown 卡片呈现输入拆分（缓存读 / 缓存写 / 未缓存）、输出（含 reasoning）、模型用时、工具用时、平均首 token 延迟、解码速度、本轮费用与累计会话费用；终态 `usage_update` 携带机器可读 `dsh._meta` 扩展。
- 价表：内置 DeepSeek 公布价（`deepseek-flash` 与 `deepseek-v4-pro`，峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，谷时减半；已退役 id `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 解析到 `deepseek-flash`），可用 `DSH_ACP_PRICES` 环境变量按模型 id 覆盖或扩展。
- 启动 latch：commander 入口先发布 `zedAcpStartup` 服务再让 ACP bridge 占用 stdio，`--help` / `--dump-config` 不再误抢协议通道。
- 工具调用标题：从持久事件里恢复工具的显著参数（`command` / `pattern` / `url` / `file_path` / `description` / `queries`），单行截断，避免把整段粘贴脚本作为显示标签。
- 任务类工具（`job_*`）归类为 `execute` / `read`，子代理桥的 `exit_plan_mode` 归类为 `switch_mode`。

### 安全

- 环境变量名集合使用 `Object.create(null)`，避免 `__proto__` 注入。
- `authenticate` 错误消息不携带 key 值，只指明环境变量名与替代渠道。
- 所有协议层通知都经 `outputTail` 串行化，避免客户端解析乱序。

### 文档

- 双语 README 与 docs/zed-acp（英 / 中）。
- `THIRD_PARTY_NOTICES.md` 列明运行时依赖与宿主 peer 依赖的版本与许可。

[未发布]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.2.0...HEAD
[0.2.0]: https://github.com/8kugames/dsh-zed-acp/compare/zed-acp-v0.1.1...zed-acp-v0.2.0
[0.1.1]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.1
[0.1.0]: https://github.com/8kugames/dsh-zed-acp/releases/tag/zed-acp-v0.1.0
