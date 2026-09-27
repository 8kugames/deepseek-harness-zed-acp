# @8kugames/dsh-zed-acp

English | [中文](README.zh.md)

A Zed-oriented [Agent Client Protocol](https://agentclientprotocol.com/) server for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as a
freely installable dsh plugin. It turns `dsh` into an external agent that
[Zed](https://zed.dev) (or any ACP client) can drive: streamed answers and
reasoning, tool calls with real diffs, plan mode, agent presets, permission
presets, session history, and MCP servers.

Built and tested against dsh `0.1.7-rc.2`. The plugin composes over the
installed harness — it ships no runtime of its own and never pins your key in
editor config.

## Install

Prerequisites: [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) pinned to the version the plugin targets (`npm i -g @deepseek-ai/dsh@0.1.7-rc.2` — the npm `latest` tag may trail it), Node `^22.19 || >=24`, and Zed.

Until the first npm release ships, install from this repository (the ref names the branch carrying the plugin; point it at `master` once merged):

```sh
dsh plugin --profile zed add "github:8kugames/deepseek-harness-zed-acp#zed-acp"
```

Re-run the same `add` command to update an existing install — a profile restart alone does not pick up files the previously installed version did not ship (the preset declarations under `presets/` are one such addition).

Once `@8kugames/dsh-zed-acp` is published, the same package installs from the registry. The per-feature walkthrough (modes, presets, permissions, sessions, troubleshooting) lives in [docs/zed-acp.md](docs/zed-acp.md).

### Install from a local clone

The committed `dist/` means a clone needs no build step. After `git clone https://github.com/8kugames/deepseek-harness-zed-acp.git`, install the clone through a pnpm symlink (a `link:` install reflects local edits on the next agent restart; `file:` copies and caches same-version tarballs instead):

```sh
dsh plugin --profile zed add -w "link:/absolute/path/to/deepseek-harness-zed-acp"
```

For development on the clone itself — tests, typecheck, rebuilds — run `npm install` once, then the usual `npm run typecheck` / `npm test` / `npm run build`.

Then point Zed at the profile (Zed → Settings → AI → External Agents, or
`settings.json`):

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

The first launch initializes `~/.dsh/profiles/zed`. Alternatively add the
plugin to the shipped automation profile — `dsh plugin --profile acp add
@8kugames/dsh-zed-acp` — the bundle patch disables the shipped
automation-only ACP transport so exactly one server owns stdio.

## What it adds over the shipped `dsh --profile acp`

|                | shipped `acp` profile               | this plugin                                                                                                                   |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Sessions       | `new` / `list` / `resume` / `close` | same, plus per-session **titles** in `session/list`                                                                           |
| Auth           | accepted, unchecked                 | `deepseek-api-key` method; `authenticate` validates the credential and explains what is missing                               |
| Modes          | —                                   | `default` / `plan` via `session/set_mode` with `current_mode_update`                                                          |
| Config options | `model`, `reasoning_effort`         | plus **`preset`** (agent presets) and **`permission`** (sandbox/approval presets, localized labels)                           |
| Questions      | —                                   | single-choice `ask_user_question` (plan review) rides `session/request_permission`                                            |
| Tool calls     | generic `other` kind                | standard kinds (`edit`/`read`/`search`/`execute`/`fetch`/`switch_mode`) and native **file diffs** from `write`/`edit` results |
| Presets        | host-plane tools                    | the web-style split: model-facing rows move into each preset's composition (`standard`/`ptc`/`minimal`/`cordis`)              |

## Compatibility

Peer ranges declare `~0.1.7-rc.2`: any dsh in the 0.1.x line from
`0.1.7-rc.2` on is accepted; dsh's profile boot checks them at install and
boot and names an incompatible plugin loudly. All `@deepseek-ai/*` modules
load from the host installation — the plugin ships no runtime.

## Custom, non-DeepSeek models

The Model select lists the live provider directory of the profile Zed launches (`dsh --profile zed`). Provider routes configured on another profile's Models page (for example the `web` profile) live in that profile's settings — dsh settings sections are per-profile and do not carry over.

To serve self-configured providers (any `dsh-llm-pi-ai` route: OpenAI-compatible gateways, self-hosted servers), declare them where every profile sees them — `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`), applied above each profile's own patch:

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

Restart the agent after editing: the routes register live and their models join the Model select. To scope them to Zed only, put the same row in `~/.dsh/profiles/zed/cordis.patch.yml` instead.

## Development

```sh
npm install         # pinned dev deps provide the dsh types and test services
npm run typecheck   # tsc --noEmit
npm test            # vitest: the bridge suite boots real cordis scopes, no model calls
npm run build       # esbuild → dist/
```

Iterate against a live profile through a pnpm symlink (`file:` copies and
caches same-version tarballs; `link:` avoids both):

```sh
dsh plugin --profile zed-dev add -w "link:$PWD"   # from the repository root
```

The dev loop is `npm run build` + restart the Zed agent.

## Release

1. Bump `version` in `package.json` and `registry/agent.json` together.
2. Commit, then push the tag: `git tag zed-acp-v<version> && git push origin zed-acp-v<version>`.
3. The workflow `.github/workflows/zed-acp.yml` runs the three-platform test
   matrix on the tag and publishes to npm when `NPM_TOKEN` is configured; it
   asserts that the tag matches both manifest versions.

## License

MIT. This package derives from `deepseek-harness` (MIT, Copyright (c) 2026
DeepSeek); see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for
attribution details.
