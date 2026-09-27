# @8kugames/dsh-zed-acp

[English](README.md) | 中文

一个面向 [Agent Client Protocol](https://agentclientprotocol.com/) 的服务器，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打包成可自由安装的 dsh 插件。它把 `dsh` 变成 [Zed](https://zed.dev)（或任何 ACP 客户端）可以驱动的外部 agent：流式回答与思考过程、带真实文件差异的工具调用、计划模式、agent 预设、权限预设、会话历史与 MCP 服务器。

按 dsh `0.1.7-rc.2` 构建并测试。插件组合在已安装的 harness 之上运行——它不自带运行时，也绝不把你的 key 写进编辑器配置。

## 安装

前置条件：[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 钉到插件对应的版本（`npm i -g @deepseek-ai/dsh@0.1.7-rc.2`——npm 的 `latest` 标签可能落后）、Node `^22.19 || >=24`，以及 Zed。

在首个 npm 发布之前，直接从本仓库安装（ref 指向携带插件的分支；合并进 `master` 后改为 `master`）：

```sh
dsh plugin --profile zed add "github:8kugames/deepseek-harness-zed-acp#zed-acp"
```

重新执行同一条 `add` 命令即可更新已安装的插件——仅重启 profile 不会带来旧版本未携带的文件（`presets/` 下的预设声明就是这类新增）。

`@8kugames/dsh-zed-acp` 发布之后，同一个包从 registry 安装。分功能的完整指引（模式、预设、权限、会话、排障）见 [docs/zed-acp.zh.md](docs/zed-acp.zh.md)。

### 从本地 clone 安装

仓库已提交 `dist/`，clone 后无需构建。`git clone https://github.com/8kugames/deepseek-harness-zed-acp.git` 之后，用 pnpm 符号链接安装本克隆（`link:` 安装在下次重启 agent 时即反映本地修改；`file:` 则会复制并按版本缓存 tarball）：

```sh
dsh plugin --profile zed add -w "link:/absolute/path/to/deepseek-harness-zed-acp"
```

若要在克隆内做开发（测试、类型检查、重新构建），先执行一次 `npm install`，之后照常用 `npm run typecheck` / `npm test` / `npm run build`。

然后在 Zed 中把该 profile 注册为 agent server（Zed → 设置 → AI → External Agents，或 `settings.json`）：

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "zed"],
      "env": {
        "DEEPSEEK_API_KEY": "<your key>",
      },
    },
  },
}
```

首次启动会初始化 `~/.dsh/profiles/zed`。也可以把插件加进随附的自动化 profile——`dsh plugin --profile acp add @8kugames/dsh-zed-acp`——bundle 补丁会禁用随附的仅面向自动化的 ACP 传输，保证 stdio 上只有一个服务器。

## 相比随附的 `dsh --profile acp` 多了什么

|          | 随附 `acp` profile                  | 本插件                                                                                                     |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 会话     | `new` / `list` / `resume` / `close` | 相同，且 `session/list` 带每会话**标题**                                                                   |
| 认证     | 接受但不校验                        | `deepseek-api-key` 方法；`authenticate` 校验凭据并解释缺什么                                               |
| 模式     | ——                                  | 经 `session/set_mode` 的 `default` / `plan`，附 `current_mode_update`                                      |
| 配置项   | `model`、`reasoning_effort`         | 另有 **`preset`**（agent 预设）与 **`permission`**（沙箱/审批预设，本地化文案）                            |
| 问题     | ——                                  | 单选 `ask_user_question`（计划评审）经 `session/request_permission` 往返                                   |
| 工具调用 | 通用 `other` 类别                   | 标准类别（`edit`/`read`/`search`/`execute`/`fetch`/`switch_mode`）与 `write`/`edit` 结果的原生**文件差异** |
| 预设     | 宿主面工具                          | web 式拆分：模型面行移入每个预设自己的组成（`standard`/`ptc`/`minimal`/`cordis`）                          |

## 兼容性

peer 范围声明为 `~0.1.7-rc.2`：自 `0.1.7-rc.2` 起的 0.1.x 线 dsh 均被接受；dsh 的 profile 启动会在安装与启动时检查它们，并明确报出不兼容的插件。所有 `@deepseek-ai/*` 模块都从宿主安装加载——插件不自带运行时。

## 自配非 DeepSeek 模型

模型选择器列出的是 Zed 所启动 profile（`dsh --profile zed`）的**活跃** provider 目录。在其他 profile（例如 `web`）的模型页配置的 provider 路由保存在那个 profile 自己的 settings 里——dsh 的 settings 段按 profile 隔离，不会跨 profile 生效。

要让自配 provider（任何 `dsh-llm-pi-ai` 路由：OpenAI 兼容网关、自建服务）对 Zed 可用，把声明放到所有 profile 都能看到的位置——`$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`），它应用在每个 profile 自身 patch 之上：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:
        apiKeyEnv: MY_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.example/v1
        models:
          - id: my-model
            name: My Model
            contextWindow: 200000
```

编辑后重启 agent：路由随即注册，其模型会加入模型选择器。若只想对 Zed 生效，把同一行放进 `~/.dsh/profiles/zed/cordis.patch.yml` 即可。

## 开发

```sh
npm install         # 固定版本的开发依赖提供 dsh 类型与测试服务
npm run typecheck   # tsc --noEmit
npm test            # vitest：桥接套件启动真实 cordis scope，不调用模型
npm run build       # esbuild → dist/
```

通过 pnpm 符号链接对接真实 profile 迭代（`file:` 会复制并缓存同版本 tarball；`link:` 两者皆避）：

```sh
dsh plugin --profile zed-dev add -w "link:$PWD"   # 在仓库根目录执行
```

开发循环是 `npm run build` + 重启 Zed agent。

## 发布

1. 同时提升 `package.json` 与 `registry/agent.json` 中的 `version`。
2. 提交后推送 tag：`git tag zed-acp-v<version> && git push origin zed-acp-v<version>`。
3. workflow `.github/workflows/zed-acp.yml` 会在 tag 上运行三平台测试矩阵，并在配置了 `NPM_TOKEN` 时发布到 npm；它会断言 tag 与两处清单版本一致。

## 许可

MIT。本包衍生自 `deepseek-harness`（MIT，Copyright (c) 2026 DeepSeek）；归属详情见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
