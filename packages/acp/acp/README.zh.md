---
description: "面向程序化客户端与维护者的仅自动化 Agent Client Protocol 服务器，用于通过 JSON-RPC stdio 驱动 DeepSeek Harness agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

[English](README.md) | 中文

## 概述

`dsh-acp` 让受信程序可以通过标准 [Agent Client Protocol（ACP）](https://agentclientprotocol.com) 驱动持久 DeepSeek Harness agent：创建或恢复会话、列出可恢复会话、挂载标准 MCP 服务器、选择部署的 agent 预设、选择模型与推理强度、发送或取消工作、接收语义执行更新，并关闭一个会话而不影响其他会话。它是为自动化而生的——进程外 subagent、测试运行器与脚本化控制器——而不是 DSH 用户界面：它发送标准 ACP 消息、thought、通用工具生命周期、配置与上下文用量，绝不发送 DSH 私有呈现数据或方法。会话持久化支持跨进程重启的列出、恢复与关闭，而删除、fork、转录回放、附加目录与交互式 UI 界面仍不支持。仓库自带的 ACP 客户端是 `dsh-subagent-acp`，`pnpm dsh --profile acp` 会启动一个开箱即用的服务器。设置与用法在前；实现细节放在下方可折叠的开发者章节中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当脚本、测试运行器或另一个 harness 需要通过标准自动化协议端到端运行 agent 工作时，使用本包。常用路径是：启动服务器、创建或恢复会话、按需挂载 MCP 服务器并选择模型选项、发送提示词、消费语义更新，再关闭会话。

### 何时选择

当自动化应拥有交互时选择它：管理持久会话、工具、模型选择与权限的进程外 subagent、测试运行器或脚本化控制器。当人类需要 DSH 专用呈现卡片、计划、标题、todo、终端视图或 elicitation 时请避开；本服务器刻意只提供标准 ACP v1 界面。

### 最小配置

服务器创建的每个会话都使用此处配置的提供方与模型。两个字段都是可选的，以便由另一个 agent/request 监听器提供；可运行的演示组合会同时设置两者。Stdout 只承载协议流量，因此请让日志远离它。

```yaml
- name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | — | 每个会话 agent 的提供方路由 |
| `model` | — | 每个会话 agent 的模型 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | `authenticate` 校验的凭据引用；必须与 LLM 提供方的密钥变量一致 |
| `sessionListPageSize` | `100` | 单页 `session/list` 返回的最大摘要数量 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-acp)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 启动服务器

`pnpm dsh --profile acp` 会启动随附的 stdio 服务器。`acp` profile 会挂载会话持久化，因此客户端可以列出、恢复和关闭持久会话。[`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.zh.md) 会启动同一 profile 来执行进程外委派。

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### 协议约定

一个连接可以同时运行多个会话，彼此独立。客户端发出的调用如下：

| 调用 | 你会得到什么 |
|---|---|
| `initialize` | 稳定 ACP v1，以及 `session/list`、`session/resume`、`session/close`、Streamable HTTP MCP 支持、公布的 `deepseek-api-key` 认证方法，以及 default／plan 会话模式；图片提示词只在持久附件存储和配置的确切路由支持时公布。 |
| `authenticate` | 校验配置的凭据引用（默认 `DEEPSEEK_API_KEY`，经凭据缝或启动环境解析）；未知方法 id 或缺失密钥会返回带解释的错误。 |
| `session/new` | 由花名册默认预设组合的全新持久 agent；其绝对工作区与 stdio 或 HTTP MCP 服务器会在发布前通过校验，并返回初始模式状态与完整配置选项状态。 |
| `session/list` | 按确定的新到旧顺序分页返回已持久、可恢复的根会话；可选绝对 `cwd` 筛选会尽可能使用物理目录标识。 |
| `session/resume` | 恢复一个已持久且非活跃的会话；组合前校验其规范工作区，并恢复日志但不回放旧更新。 |
| `session/close` | 停稳式取消、更新 drain、后代释放、持久化 flush，并且只释放指定 Agent 作用域。 |
| `session/set_mode` | 在 plan-mode 服务支持的 `default` 与 `plan` 模式间切换；被打开轮次阻塞的变更会在下一个被接受的 pre-step 提交，并通过 `current_mode_update` 通告。 |
| `session/set_config_option` | 串行更新公布的 `preset`、`permission`、`model` 或 `reasoning_effort` 选项，并返回完整结果状态。会话已产生输出后预设切换会被拒绝；提交的切换由花名册记入会话日志。权限切换是即时的：下一个工具调用即在新沙箱与审批旋钮下运行。 |
| `session/prompt` | 有序文本、资源链接与受支持图片，每个会话一次一个提示词；Agent 空闲且有序更新交付后才结算。 |
| `session/cancel` / `$/cancel_request` | 提示词所拥有的取消路径；没有进行中的 ACP 提示词时取消自主工作，未知会话 id 则为空操作。 |
| `session/update` | 已提交 assistant 消息与 thought、通用工具生命周期、配置与模式变化，以及上下文用量，按会话串行交付。 |
| `session/request_permission` | 带一次性允许／拒绝选项的权限提示；仅选项类用户问题（包括计划评审）复用同一通道，你的客户端可以自动回答。 |

会话配置提供部署预设表的权限选择器（随附的 `read-only`、`workspace-write` 与 `danger-full-access`——新会话从 `workspace-write` + 审批提示开始，可在任意时刻即时切换）、部署花名册的 agent 预设选择器（随附的 `standard`、`ptc`、`minimal`、`cordis` 预设及本地创作预设）、来自实时 LLM 服务目录的不透明提供方／模型选项，并在确切模型声明推理选项时提供 `reasoning_effort`。会话仅在其尚未产生任何输出时可切换预设——中途更换工具会让会话日志留下新组合无法执行的已记录工具调用；提交的切换是持久的，恢复的会话会重建其运行所用的组合。提示词会在异步图片准入前快照该选择，并在该轮的每个模型步骤中固定它；并发选项变更从下一轮开始生效。会话模式暴露 plan-mode 服务：`session/set_mode` 选择模式，持久的 `plan/mode` 事件驱动 `current_mode_update`，计划评审问题则经 `session/request_permission` 送达客户端。ACP 客户端是受信控制器：stdio MCP 条目授权其环境与一个绝对可执行文件——裸命令名会在挂载时对 harness PATH 解析，无可执行文件匹配时响亮失败——HTTP 条目授权其绝对 HTTP(S) URL 与 header；初始连接或发现失败会回滚尚未发布的 Agent。不支持的界面会被省略或拒绝：`session/load`、删除、fork、附加目录、SSE 或 ACP 传输 MCP、命令、终端、客户端文件系统操作、自由文本回答与 elicitation。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务器如何实现上述行为，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

服务器是刻意采用标准公开协议的自动化传输。三项承诺塑造了它：

- **只发送标准语义更新。** 协议承载已提交消息与 thought、通用工具生命周期、配置与上下文用量；原始提供方增量、重试尝试、DSH 呈现数据与不受支持内容不会进入协议。
- **诚实的能力与配置状态。** `initialize` 只公布已挂载支持，拓扑变化会发布完整配置选项，提示词则固定其准入时的确切路由。
- **停稳后才结算。** 提示词与关闭操作只在其拥有的准入、Agent 活动、有序更新、后代、持久化与释放达到所需终态后才结算。

决策历史记录在 [ACP 作为仅面向自动化的协议笔记](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md) 与[多会话笔记](../../../.agents/notes/implemented/feature/2026-06-14-acp-multi-session.zh.md) 中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、`AgentSideConnection` 接线、按会话记录、准入与结算、清理 |
| [`src/auth.ts`](src/auth.ts) | 公布的认证方法与 `authenticate` 背后的凭据解析 |
| [`src/questions.ts`](src/questions.ts) | 用户问题到 `session/request_permission` 的桥接，仅承载选项类问题 |
| [`src/content.ts`](src/content.ts) | 协议内容准入与投影：图片校验、路由重查、提示词重建、assistant 块转换 |
| [`src/codec.ts`](src/codec.ts) | 轮次结束到 ACP `stopReason` 的纯映射 |
| — | 不发布运行时不变式伴生入口；本传输不拥有持久包内事件流。 |

### 准入与提示词结算

每个会话只允许一个正在处理的提示词。准入先校验整个提示词批次、快照所选路由、重新检查 Agent 是否为同一对象与图片能力、持久化图片附件，然后才把用户消息入队——赢得准入的取消绝不会入队迟到的轮次。入队后，会话模块把该快照与 inbox 消息关联到认领时刻，并在提示词变量与该轮的每个模型步骤中固定相同的提供方、模型与推理强度。按会话更新会串行交付；已提交图片会重新读取并验证完整性，因此图片缺失或损坏会让关联提示词失败，而不是发出占位符。结算优先级依次为显式取消、已提交输出失败、区间内 Agent 失败、关联轮次结束。

### 清理与连接归属

每个会话模块拥有其 Agent 句柄、MCP 挂载、未来与轮次固定的模型选择、提示词槽位、更新链和记忆化关闭操作。显式关闭、客户端断开与 Cordis 释放使用同一停稳式清理流程：停止新工作、取消提示词准入与 Agent 活动、drain 已提交更新、按子优先顺序释放可继续后代、flush 持久化并释放所拥有的 Agent 作用域。会话关闭后，持久状态仍可供列出与恢复；共享上下文的其他会话或前端不受影响。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从匹配的客户端逐步进入自动化约定背后的设计记录。

- [dsh-subagent-acp](../../subagent/subagent-acp/README.zh.md)——spawn 并驱动本服务器的进程外 ACP 客户端。
- [在 Zed 中使用 DeepSeek Harness](../../../docs/user/guide/zed-acp.zh.md)——基于本服务器的编辑器接入，包括模式切换与注册表草稿。
- [ACP 作为仅面向自动化的协议](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.zh.md)——自动化约定及其协议边界的决策记录。
- [在单个连接上多路复用并发 ACP 会话](../../../.agents/notes/implemented/feature/2026-06-14-acp-multi-session.zh.md)——按会话隔离、归属与清理决策。
- [扩展实操手册](../../../docs/cookbook/extension-cookbook.zh.md)——本包作为扩展作者的仅自动化完整示例。

-----

<a id="model-experience"></a>
## 模型体验

### 提示词内容

#### 模型看到什么

`session/prompt` 会在一条用户消息中保留文本与图片顺序：相邻文本会拼接，资源链接则表示为带方括号的 `[resource_link name=… uri=…]` 引用，模型可以使用自身工具打开它。内联图片 base64 在批量准入后即被丢弃，因此持久消息只包含经过校验的附件引用。协议元数据、客户端能力、权限选择与会话 id 绝不进入模型请求。

#### Token 影响

提示词内容、工具调用／结果和持久图片引用会保留在该会话中直到 compaction。并发会话保留独立上下文。

#### KV Cache 影响

仅追加；新用户消息位于可复用请求前缀之后，不会使先前缓存条目失效。

### 权限决策

#### 模型看到什么

不会直接看到任何内容。所属工具通过常规工具结果路径记录其结果：允许、拒绝、取消或不可用。

#### Token 影响

只有所属工具的结果会贡献 token。

#### KV Cache 影响

仅通过所属工具的结果追加。

### 模式切换

#### 模型看到什么

`session/set_mode` 会追加持久的 `plan/mode` 事件，并且当上一个请求 header 描述的是另一模式时，追加一条说明切换的插件来源用户通知。plan mode 自身的行为（guidance section 与 `exit_plan_mode`）遵循 plan-mode 服务约定。

#### Token 影响

通知消息，以及模式激活期间的 plan-mode guidance section。

#### KV Cache 影响

仅追加；通知与 guidance section 从其所在步骤起进入前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是协议对比或任务积压。

- **仅一个主 workspace**——附加目录仍不支持。
- **仅光栅提示词图片**——PNG、JPEG、WebP 与 GIF 要求持久附件存储及确切的图片能力路由。
- **仅 MCP 工具**——MCP resource 与 prompt 没有 DSH 消费方。
- **没有转录回放或交互式扩展**——会话删除、fork、`session/load`、命令、终端、客户端文件系统操作与 elicitation 仍不属于此自动化界面。
- **问题仅限选项类**——权限通道无法承载自由文本或多选回答；此类问题会委托回 waterfall 并以带解释的错误失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
