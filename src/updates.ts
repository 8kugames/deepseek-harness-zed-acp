/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'

/**
 * Shipped tool names with an unambiguous standard kind. A name absent here
 * reports `other`; MCP and deployment-specific tools keep that default.
 */
const TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ['edit', 'edit'],
  ['write', 'edit'],
  ['str_replace_editor', 'edit'],
  ['read', 'read'],
  ['read_image', 'read'],
  ['glob', 'search'],
  ['grep', 'search'],
  ['bash', 'execute'],
  ['pwsh', 'execute'],
  ['run_code', 'execute'],
  ['terminal_send', 'execute'],
  ['web_search', 'fetch'],
  ['web_fetch', 'fetch'],
  ['exit_plan_mode', 'switch_mode'],
])

/**
 * Resolve the standard tool kind for one committed tool-call name.
 * @param name - committed DSH tool-call name.
 * @returns the mapped standard kind, or `other` for unmapped names.
 */
export function toolKindFor(name: string): ToolKind {
  return TOOL_KINDS.get(name) ?? 'other'
}

/** Title cap so a huge pasted script never rides the ACP wire as a display label. */
const MAX_COMMAND_TITLE = 200

/**
 * Derive one tool call's human-readable ACP title from its committed fact.
 * ponytail: titles follow the tools' declared `presentCall` intent only where it
 * is recoverable from the committed event — an object argument with a string
 * `command` field (the terminal family: bash/pwsh), collapsed to one line and
 * capped. Any other shape falls back to the tool name; full presentation parity
 * would need registry access the pure event projection deliberately lacks.
 * @param name - committed DSH tool-call name.
 * @param rawArguments - raw `arguments` JSON string exactly as the model produced it.
 * @returns the salient command text when recognizable, otherwise the tool name.
 */
function toolCallTitle(name: string, rawArguments: string): string {
  const parsed = parseToolArguments(rawArguments)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return name
  const command = (parsed as Record<string, unknown>).command
  if (typeof command !== 'string') return name
  const oneLine = command.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return name
  return oneLine.length > MAX_COMMAND_TITLE ? `${oneLine.slice(0, MAX_COMMAND_TITLE - 1)}…` : oneLine
}

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: toolCallTitle(event.data.name, event.data.arguments),
    kind: toolKindFor(event.data.name),
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * A successful result whose tool attached the shared file-diff `meta` payload
 * (the `write`/`edit` tools) projects it as standard `diff` content before the
 * committed text blocks, so ACP clients render the applied change natively.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  if (message.isError !== true) {
    for (const diff of fileDiffsFromMeta(event.data.meta) ?? []) {
      content.push({ type: 'diff', path: diff.path, oldText: diff.oldText, newText: diff.newText })
    }
  }
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/**
 * Narrow a durable tool-result `meta` payload to non-empty shared file diffs.
 * The payload is opaque at the durable boundary; malformed or absent data
 * yields `undefined` so the update keeps its text-only projection.
 * @param meta - opaque committed result metadata.
 * @returns validated applied file diffs, or `undefined` for absent or malformed data.
 */
function fileDiffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const narrowed: FileDiff[] = []
  for (const diff of diffs) {
    if (typeof diff !== 'object' || diff === null || Array.isArray(diff)) return undefined
    const { path, oldText, newText } = diff as Record<string, unknown>
    if (typeof path !== 'string' || (oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') {
      return undefined
    }
    narrowed.push({ path, oldText, newText })
  }
  return narrowed
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
