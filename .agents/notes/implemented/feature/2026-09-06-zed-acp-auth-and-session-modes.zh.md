# Agent Note：面向 Zed 的 ACP 认证、会话模式与计划评审桥接

Status: implemented

[English](2026-09-06-zed-acp-auth-and-session-modes.md) | 中文

## 问题

仅自动化的 ACP 桥接只部分覆盖了 Zed 的客户端模型。[ACP 注册表](https://github.com/agentclientprotocol/registry)硬性要求 `authMethods` 非空且含 `agent` 或 `terminal` 类型方法，而桥接公布的是 `authMethods: []` 与空操作 `authenticate`——Zed 没有登录流，注册表也会拒绝该 agent。Zed 的模式选择器无可切换，因为桥接未公布会话模式，尽管 harness 自带 plan mode，且随附的 `dsh-base` bundle 已在其上的每个 profile 中挂载 `plan-mode` 与 `user-questions`。计划模式本身走不通：`exit_plan_mode` 通过 user-questions waterfall 询问用户，而没有任何 ACP 客户端应答它，于是 Zed 驱动的 agent 能进入计划模式，却永远完不成自己的评审流。

## 决策

**认证是公布的、无状态的凭据校验。** `initialize` 返回唯一的 agent 型方法 `deepseek-api-key`；`authenticate` 经凭据缝解析配置的凭据引用（`apiKeyEnv`，默认 `DEEPSEEK_API_KEY`）——未挂载凭据缝时回退到启动环境——并用 DeepSeek 提供方每请求所用的同一条 `normalizeApiKey` 规则校验。认证不持有状态、不授予任何东西；跳过它的客户端仍能创建会话，其首个模型请求会以提供方自身的 `MISSING_CREDENTIAL` 失败。`session/new` 刻意不复查凭据：桥接是提供方无关的（测试与自动化客户端会挂载非 DeepSeek 路由），在那里设 DeepSeek key 门槛会拒绝本不需要 key 的会话。失败点保持在真正能知道失败的最早位置。

**会话模式即 plan-mode 服务，实时读取。** 桥接把固定的一对 `default`/`plan` 映射到 `planMode.get`/`planMode.set`。仅当部署组合了 plan-mode 时，`session/new` 与 `session/resume` 才返回当前模式状态；缺失时该字段缺席，`session/set_mode` 以无效参数拒绝。打开轮次期间的选择在 plan-mode 服务内排队，于下一个被接受的 pre-step 提交——桥接返回仍属当前的状态，让已提交的变更通过协议说话：持久的 `plan/mode` 事件从投影其他更新的同一个 `session/event` 监听器驱动 `current_mode_update` 通知，因此被恢复、fork 或外部切换的会话报告的是事实，而非桥接本地的镜像。

**用户问题复用权限通道。** 桥接为自有 agent 应答 `user-questions/request`：把每个仅选项类问题映射为一次 `session/request_permission` 往返，使用合成的 `acp-question:` tool-call id。plan-review intent 把它的批准标签映射为 `allow_once`，其余选项映射为 `reject_once`；无 intent 时所有选项都是 `allow_once`，因为承载选择的是标签而不是 kind。自由文本与多选问题在 ACP v1 没有载体（所固定的 SDK 中不存在 `session/request_input`），桥接把它们委托回 waterfall，由其无应答者失败指明缺口。`cancelled` 结果抛出 `ASK_CANCELLED`——plan-mode 退出工具已把它解释为"用户驳回了评审、想先说话"。

**取消最先分发。** SDK 的 `ConnectionBuilder` 把每条入站消息按注册顺序穿过一条顺序 handler 链——每注册一个方法就多一跳——因此任何消息的处理成本与时序都随排在其自身之前的 handler 数量增长。`session/cancel` 通知因此注册在所有 request handler 之前。这将取消延迟与未来的方法新增隔离，否则每次新增方法都会静默重排所有准入到入队之间的取消竞争；"honors cancellation in the admission-to-followup handoff gap" 测试钉住的正是这样一种调度，并在 `session/set_mode` 加入链路时翻转。

**注册表条目已备妥、未提交。** `packages/acp/acp/registry/` 保存清单草稿（[agent.json](../../../../packages/acp/acp/registry/agent.json)）与单色 [icon.svg](../../../../packages/acp/acp/registry/icon.svg)；本笔记负责提交清单。提交等待一个纯数字的稳定 npm 版本，因为注册表拒绝预发布版本——条目的 `version` 与 `distribution.npx.package` 固定值必须同为 `@deepseek-ai/dsh` 的同一个稳定 `x.y.z` 发布，图标必须保持 16×16 单色 `currentColor`，注册表自身的工具会校验清单与认证要求。npx 分发条目固定 `@deepseek-ai/dsh`，且注册表自动从 npm 重新同步版本，所以常规 harness 发布不需要任何注册表操作。

**MCP stdio 命令对 harness PATH 解析。** ACP 规范把 `McpServerStdio.command` 定义为绝对路径，桥接过去拒绝裸名——但 Zed 这类编辑器转发其配置的 context server 时携带裸命令（`npx`、`uvx`），继承了这类服务器的每个会话都被破坏。桥接现在在挂载时显式解析命令：绝对路径原样通过，裸名对 harness 进程 PATH 解析——这正是 `dsh-mcp-client` 净化后的父环境交给 MCP 子进程的同一环境——无法解析的名字响亮失败并指明被查找的命令。授权契约保持其实质：客户端启动的仍是挂载时记录的那个绝对可执行文件。

**Agent 预设经花名册服务加入。** acp bundle 现在挂载 `dsh-agent-presets`（默认 `standard`），并禁用与 web bundle 相同的这批 host 层模型面行，让会话加入的预设真正拥有其工具、提示词 section 与 skills，而不是从 host 层泄漏。创建时解析花名册默认项、记入会话 header，并在工厂 setup 中挂载（预设损坏会让会话创建回滚）；恢复时读取持久的 `agentPreset` 投影并重新加入该组合。选择的 ACP 界面是 `preset` 配置选项：切换走花名册的串行空白会话契约（`select`），产生输出后的切换是调用方可纠正的拒绝，提交的切换写入会话日志。桥接逐 agent 读取的服务——尤其是上面的 plan mode——经花名册的逐 agent 读取（`serviceFor`）解析，因为加入预设的 Agent 的作用域上下文看不到其预设的 entry-local realm 实例；无花名册的部署回退到 host 层。

**权限预设是即时配置选项。** 桥接同时把权限服务的预设表（`read-only`、`workspace-write`、`danger-full-access`）暴露为 `permission` 配置选项，并经 `PermissionPresetService.set` 切换——该切换按设计是即时的：会话任意时刻可切、记入会话日志，与仅限空白的 agent 预设切换不同。新会话本就经 base 组合默认从 `workspace-write` + 审批提示开始；桥接既不更改也不重新推导该默认，只是把它暴露出来。展示文案归属 acp 部署自身：acp-app bundle 以产品 `name`/`description` 标签复述 base 预设表，因为 ACP 客户端按 wire 名称原样渲染（web 则相反，对未命名的预设经客户端词典本地化）。

## 后果

Zed 与所有其他 ACP v1 客户端通过自动化桥接获得登录流、可用的模式选择器与完整的计划评审回路，同时自动化约定保留其一次性权限语义与"绝不从客户端响应推断持久授权"的规则。取消延迟不再随 handler 数量增长，未来新增 agent 侧方法不会重排取消竞争——若所固定的 SDK 更改其分发模型，这一性质值得复查。无法承载的问题以 waterfall 的无应答者失败浮出，而不是静默降级的对话框，因此经 ACP 需要自由文本的提问方必须等待协议提供 request-input 载体。注册表条目的版本自动跟随 npm 发布；唯一的注册表维护是稳定版本的一次性 PR 与后来的分发形态变更。

## 被否决的替代方案

**独立的 `dsh-zed-acp-adapter` 桥接进程** —— 拒绝。对 Zed 说 ACP、对 dsh 说另一协议的 adapter 要重写桥接已经具备的协议服务端，增加一跳进程与第二层会话，还会成为每个服务缝变更都必须更新的又一个消费者。插件组合（`dsh --profile acp`）加上注册表自动同步 npm 版本，已经交付了这类 adapter 承诺的解耦。

**公布 `allow_always` 权限类型** —— 拒绝。桥接是机器策略通道，绝不从客户端响应推断持久授权；持久权限属于部署的权限策略，不属于自动化传输。

**用凭据门槛约束 `session/new`（`auth_required`）** —— 因提供方无关性被拒绝；见上文决策。

## 验证

- `packages/acp/acp/tests/auth.spec.ts`、`modes.spec.ts`、`questions.spec.ts` 覆盖公布的方法、凭据路径、带 `current_mode_update` 的模式切换，以及计划评审桥接（含取消与委托）。
- `apps/cli/tests/profiles/acp/tests/goal-expected/` 下的 CLI e2e 金照固定了新的 `initialize` 与 `session/new` 协议事实；`acp.e2e.ts` 无 key 启动真实 profile 子进程并完成 `session/new`。
- 用户指南 [docs/user/guide/zed-acp.zh.md](../../../../docs/user/guide/zed-acp.zh.md) 负责编辑器接入，`packages/acp/acp/registry/` 保存备妥的注册表产物。
