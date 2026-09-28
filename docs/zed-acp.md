# Use DeepSeek Harness in Zed

English | [中文](zed-acp.zh.md)

This tutorial connects the [Zed](https://zed.dev) editor to DeepSeek Harness over the [Agent Client Protocol](https://agentclientprotocol.com), so Zed's agent panel drives a harness agent in your workspace. After the setup below you can prompt the agent from Zed, switch between the default and plan modes, approve tool work and plan reviews in place, and reopen earlier sessions from Zed's session history.

## Prerequisites

- [Zed](https://zed.dev/download)
- Node.js `^22.19` or `>=24`
- A [DeepSeek API key](https://platform.deepseek.com/) exported as `DEEPSEEK_API_KEY`

## Add the agent server

Install the CLI pinned to the version the plugin targets, add the Zed ACP plugin to a profile, and register the profile in your Zed `settings.json`:

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.1
dsh plugin --profile zed add "github:8kugames/dsh-zed-acp#zed-acp"
```

The npm `latest` tag of the CLI may trail the version the plugin targets, and the plugin's compatibility gate refuses older dsh at install time, so the command above pins the version. The git ref names the branch that carries the plugin; the plugin installs from the npm registry as `@8kugames/dsh-zed-acp` once its first release ships.

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "zed"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

Zed launches the agent as a subprocess and speaks the Agent Client Protocol over its stdio. The first launch initializes the `zed` profile under the harness home, and the plugin's bundle patch mounts the Zed-oriented ACP server over the harness base composition. The plugin ships no runtime of its own: every harness module loads from the installed dsh, so upgrading dsh upgrades the agent. Adding the plugin to the shipped automation profile instead — `dsh plugin --profile acp add @8kugames/dsh-zed-acp` — also works: the patch disables that profile's automation-only ACP transport so exactly one server owns stdio. `env` entries override the environment Zed passes through, so the key can live here or in your shell environment; a key in either place is resolved the same way.

## Authenticate and prompt

Open Zed's agent panel and select **DeepSeek Harness**. The first use authenticates against the configured API key: a missing or unusable key returns an explained error instead of a session. Once authenticated, type a task and the agent streams its answer, tool calls, and results into the panel.

The harness agent reads one workspace: the directory Zed opens becomes the session's working directory. Zed's MCP servers are forwarded to the harness, which mounts the HTTP ones it supports.

## Pick an agent preset

The panel's configuration picker offers the deployment's agent presets — the shipped **标准模式 (Standard)**, **PTC 模式**, **极简模式**, and **创造模式 (Authoring)**, plus any presets authored as `@deepseek-ai/dsh-agent-preset` declaration rows in the profile's own `cordis.patch.yml` overlay (`$DSH_HOME/profiles/zed/cordis.patch.yml`). The preset decides the agent's tools, prompt, and skills; pick it before the first message of a session, because a session locks its preset once it has produced output.

## Change the permission mode

The panel's configuration picker also carries a **Permissions** select showing the presets by their product labels — **仅可查看 (Read Only)**, **工作区内修改 (Workspace Write)**, the default, and **完全权限 (Full Access)**. Unlike the agent preset, the permission mode is a live switch — the next tool call runs under the newly selected sandbox and approval settings.

## Switch between default and plan modes

The mode picker in the agent panel offers **Default** and **Plan**. Plan mode is the harness plan-mode service: the agent explores read-only and ends with `exit_plan_mode`, which Zed presents as an approval prompt with **Approve** and **Keep planning** choices. Approving leaves plan mode and the agent carries out the plan from its next step; you can also switch the mode back manually at any time. A mode switch that happens while the agent is working is applied at the next step boundary.

## Reopen earlier sessions

Sessions persist under the harness home, so the session history in Zed lists earlier root sessions from the same working directory and reopens them without replaying old messages into the panel.

## Serve self-configured models

The Model select lists the live provider directory of the profile behind this agent (`dsh --profile zed`). dsh mounts `dsh-llm-pi-ai` dormant in the base composition: it registers no routes until a settings section or patch declares provider profiles, and settings sections are per-profile — models configured on another profile's Models page never reach this one.

Declare the routes where the zed profile sees them. `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`) applies above every profile's own patch, so one declaration serves all profiles; `~/.dsh/profiles/zed/cordis.patch.yml` scopes them to Zed only:

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

Restart the agent after editing; the routes register live, and their models appear as new groups in the Model select alongside DeepSeek.

## Troubleshoot

- **The Model select misses self-configured models** — they were configured on another profile, and settings sections are per-profile; see [Serve self-configured models](#serve-self-configured-models).
- **Authentication errors name `DEEPSEEK_API_KEY`** — the key is missing or unusable in the environment Zed passed to the agent process. Fix the `env` block or your shell export.
- **No agent response and the log shows non-protocol output** — run `dev: open acp logs` from the command palette. Only JSON-RPC frames may appear on the agent's stdout; a leaked log line is a harness bug, not a Zed one.
- **A prompt fails with a model error while Zed shows the agent as connected** — the session was created before a valid key existed; re-authenticate or restart the agent server from the panel.

## The ACP registry

Zed also installs agents from the [ACP registry](https://zed.dev/blog/acp-registry), which lists one manifest per agent and resolves installs for every ACP client. The plugin ships its prepared registry manifest (`registry/agent.json` in the plugin package); until that listing ships, use the manual configuration above.
