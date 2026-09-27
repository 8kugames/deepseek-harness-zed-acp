/** Standard ACP MCP-server declarations translated into Agent-scoped DSH MCP clients. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { delimiter, isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const VALID_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Caller-correctable MCP declaration failure. */
export class AcpMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpMcpConfigError'
  }
}

/**
 * Validate and mount one session's complete standard MCP server list before Agent publication.
 * @param agentCtx - unpublished Agent scope that owns the MCP clients and tools.
 * @param servers - stable ACP stdio or HTTP server declarations.
 * @param sessionCwd - canonical primary workspace used by stdio servers.
 */
export async function mountAcpMcpServers(
  agentCtx: Context,
  servers: readonly McpServer[],
  sessionCwd: string,
): Promise<void> {
  const configs = resolveMcpConfigs(servers, sessionCwd)
  for (const config of configs) await agentCtx.plugin(McpClient, config)
}

/** Convert the stable stdio/HTTP ACP transports and reject every other transport. */
function resolveMcpConfigs(servers: readonly McpServer[], sessionCwd: string): McpClient.Config[] {
  const names = new Set<string>()
  return servers.map((server, index) => {
    const serverName = normalizeServerName(server.name)
    if (names.has(serverName)) {
      throw new AcpMcpConfigError(`mcpServers contains duplicate normalized name: ${serverName}`)
    }
    names.add(serverName)
    if (!('type' in server)) {
      const command = resolveStdioCommand(server.command, `mcpServers[${index}].command`)
      const env = entriesToRecord(server.env, `mcpServers[${index}].env`, 'environment')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'stdio',
        serverName,
        command,
        args: server.args,
        env,
        cwd: sessionCwd,
        failOnStartupError: true,
      }))
      return { ...config, env }
    }
    if (server.type === 'http') {
      assertHttpUrl(server.url, `mcpServers[${index}].url`)
      const headers = entriesToRecord(server.headers, `mcpServers[${index}].headers`, 'header')
      const config = validateClientConfig(index, () => McpClient.Config({
        transport: 'streamable-http',
        serverName,
        url: server.url,
        headers,
        failOnStartupError: true,
      }))
      return { ...config, headers }
    }
    throw new AcpMcpConfigError(`mcpServers[${index}] transport ${server.type} is not supported`)
  })
}

/**
 * Resolve one stdio declaration to the absolute executable the client launches.
 * The ACP spec names absolute commands, but editors such as Zed forward bare
 * names (`npx`, `uvx`) for their configured MCP servers, so a bare name
 * resolves against the harness process PATH — the exact environment the MCP
 * child inherits — and an unresolvable name fails loudly with the searched
 * command.
 * @param command - the ACP stdio command string.
 * @param field - the indexed declaration field for error messages.
 * @returns the absolute executable path.
 */
function resolveStdioCommand(command: string, field: string): string {
  if (isAbsolute(command)) return command
  const resolved = lookupPathCommand(command)
  if (resolved === undefined) {
    throw new AcpMcpConfigError(
      `${field} is not an absolute path and names no executable on the harness PATH: ${command}`,
    )
  }
  return resolved
}

/** Find the first executable file matching a bare command name on the process PATH. */
function lookupPathCommand(command: string): string | undefined {
  const searchPath = process.env.PATH
  if (searchPath === undefined || searchPath.length === 0) return undefined
  // A bare `npx` on Windows is npx.cmd, so PATHEXT-style suffixes join the search.
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension)
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK)
          return candidate
        }
      } catch {
        /* absent, non-file, or not executable — keep searching the remaining directories. */
      }
    }
  }
  return undefined
}

/** Convert ordered ACP name/value entries without silently accepting duplicate keys. */
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  field: string,
  kind: 'environment' | 'header',
): Record<string, string> {
  // Valid environment and header names include "__proto__"; a null prototype
  // keeps that entry as data instead of invoking Object.prototype's setter.
  const result = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const entry of entries) {
    if (kind === 'header') {
      try {
        validateHeaderName(entry.name)
        validateHeaderValue(entry.name, entry.value)
      } catch (_invalidHeader) {
        throw new AcpMcpConfigError(`${field} contains an invalid header entry`)
      }
    } else if (
      entry.name.length === 0
      || entry.name.includes('=')
      || entry.name.includes('\0')
      || entry.value.includes('\0')
    ) {
      throw new AcpMcpConfigError(`${field} contains an invalid environment entry`)
    }
    const identity = kind === 'header' ? entry.name.toLowerCase() : entry.name
    if (names.has(identity)) throw new AcpMcpConfigError(`${field} contains duplicate name: ${entry.name}`)
    names.add(identity)
    result[entry.name] = entry.value
  }
  return result
}

/** Produce a stable DSH tool namespace from ACP's human-readable server name. */
function normalizeServerName(name: string): string {
  if (name.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AcpMcpConfigError('mcpServers contains an invalid server name')
  }
  if (VALID_SERVER_NAME.test(name)) return name
  const slug = name.normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/** Require the stable Streamable HTTP transport URL schemes. */
function assertHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch (_invalidUrl) {
    throw new AcpMcpConfigError(`${field} must be an absolute HTTP(S) URL`)
  }
}

/** Map the existing MCP provider's schema error into ACP invalid params. */
function validateClientConfig(index: number, parse: () => McpClient.Config): McpClient.Config {
  try {
    return parse()
  } catch (error: unknown) {
    /* v8 ignore next -- Schemastery validation rejects with Error instances. */
    const detail = error instanceof Error ? error.message : String(error)
    throw new AcpMcpConfigError(`mcpServers[${index}] is invalid: ${detail}`)
  }
}
