# Use DeepSeek Harness in Zed

English | [中文](zed-acp.zh.md)

This tutorial connects the [Zed](https://zed.dev) editor to DeepSeek Harness over the [Agent Client Protocol](https://agentclientprotocol.com), so Zed's agent panel drives a harness agent in your workspace. After the setup below you can prompt the agent from Zed, switch between the default and plan modes, approve tool work and plan reviews in place, and reopen earlier sessions from Zed's session history.

## Prerequisites

- [Zed](https://zed.dev/download)
- Node.js `^22.19` or `>=24`
- A [DeepSeek API key](https://platform.deepseek.com/) exported as `DEEPSEEK_API_KEY`

## Add the agent server

Install the published CLI once, then register it in your Zed `settings.json`:

```sh
npm install -g @deepseek-ai/dsh
```

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "dsh",
      "args": ["--profile", "acp"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

Zed launches the agent as a subprocess and speaks the Agent Client Protocol over its stdio. Without a global install, point `command` at `npx` with `args`: `["-y", "@deepseek-ai/dsh", "--profile", "acp"]`, accepting the per-launch package resolution. The `acp` profile starts the harness ACP server with session persistence and the standard tool set. `env` entries override the environment Zed passes through, so the key can live here or in your shell environment; a key in either place is resolved the same way. Repository contributors can point `command` at a checkout instead: `command`: `pnpm`, `args`: `["-C", "/absolute/path/to/deepseek-harness", "dsh", "--profile", "acp"]`.

## Authenticate and prompt

Open Zed's agent panel and select **DeepSeek Harness**. The first use authenticates against the configured API key: a missing or unusable key returns an explained error instead of a session. Once authenticated, type a task and the agent streams its answer, tool calls, and results into the panel.

The harness agent reads one workspace: the directory Zed opens becomes the session's working directory. Zed's MCP servers are forwarded to the harness, which mounts the HTTP ones it supports.

## Pick an agent preset

The panel's configuration picker offers the deployment's agent presets — the shipped **标准模式 (Standard)**, **PTC 模式**, **极简模式 (Minimal)**, and **创造模式 (Authoring)**, plus locally authored presets under the harness home. The preset decides the agent's tools, prompt, and skills; pick it before the first message of a session, because a session locks its preset once it has produced output.

## Change the permission mode

The panel's configuration picker also carries a **Permissions** select showing the presets by their product labels — **仅可查看 (Read Only)**, **工作区内修改 (Workspace Write)**, the default, and **完全权限 (Full Access)**. Unlike the agent preset, the permission mode is a live switch — the next tool call runs under the newly selected sandbox and approval settings.

## Switch between default and plan modes

The mode picker in the agent panel offers **Default** and **Plan**. Plan mode is the harness plan-mode service: the agent explores read-only and ends with `exit_plan_mode`, which Zed presents as an approval prompt with **Approve** and **Keep planning** choices. Approving leaves plan mode and the agent carries out the plan from its next step; you can also switch the mode back manually at any time. A mode switch that happens while the agent is working is applied at the next step boundary.

## Reopen earlier sessions

Sessions persist under the harness home, so the session history in Zed lists earlier root sessions from the same working directory and reopens them without replaying old messages into the panel.

## Troubleshoot

- **Authentication errors name `DEEPSEEK_API_KEY`** — the key is missing or unusable in the environment Zed passed to the agent process. Fix the `env` block or your shell export.
- **No agent response and the log shows non-protocol output** — run `dev: open acp logs` from the command palette. Only JSON-RPC frames may appear on the agent's stdout; a leaked log line is a harness bug, not a Zed one.
- **A prompt fails with a model error while Zed shows the agent as connected** — the session was created before a valid key existed; re-authenticate or restart the agent server from the panel.

## The ACP registry

Zed also installs agents from the [ACP registry](https://zed.dev/blog/acp-registry), which lists one manifest per agent and resolves installs for every ACP client. DeepSeek Harness is prepared for registry submission; until that listing ships, use the manual configuration above.
