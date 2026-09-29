import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, ToolCallId, type StreamChunk  } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

function toolCallResponse(name = 'echo'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: ToolCallId('call-1'), name, argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-1'), name, arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ACP automation output boundary', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits committed reasoning, generic tool lifecycle, usage, and final text in order', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse(), textResponse('done')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })
    expect(harness.updates.map(update => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'usage_update',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'usage_update',
      'tool_call',
      'tool_call_update',
      'usage_update',
    ])
    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'inspect first' },
    })
    expect('messageId' in harness.updates[0]!).toBe(true)
    expect(harness.updates[2]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: {},
    })
    expect(harness.updates[3]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }],
    })
    expect(harness.updates[4]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    })
    expect('messageId' in harness.updates[4]!).toBe(true)
    expect(harness.updates[8]).toMatchObject({
      sessionUpdate: 'usage_update',
      size: 1_024,
    })
    if (harness.updates[8]?.sessionUpdate !== 'usage_update') throw new Error('expected usage update')
    expect(typeof harness.updates[8].used).toBe('number')
    if (harness.updates[8]?._meta?.dsh === undefined) throw new Error('expected stats _meta')
  })

  it('negotiates the display terminal end to end for execute-kind calls', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse('bash'), textResponse('done')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'Run a fixture command.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'stdout line' }]),
    }))
    // The capability declared at initialize must reach the session's tool
    // projection: the execute-kind call embeds a display terminal keyed by
    // its own call id, and the result settles on the terminal.
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { _meta: { terminal_output: true } },
    })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })
    const toolCall = harness.updates.find(update => update.sessionUpdate === 'tool_call')
    expect(toolCall).toMatchObject({
      toolCallId: 'call-1',
      kind: 'execute',
      content: [{ type: 'terminal', terminalId: 'call-1' }],
      _meta: { terminal_info: { terminal_id: 'call-1', cwd: process.cwd() } },
    })
    const completions = harness.updates.filter(update => update.sessionUpdate === 'tool_call_update')
    // Two settle the bash display terminal; the third completes the turn-stats card.
    expect(completions).toHaveLength(3)
    expect(completions[0]).toMatchObject({
      toolCallId: 'call-1',
      _meta: { terminal_output: { terminal_id: 'call-1', data: 'stdout line' } },
    })
    expect(completions[1]).toMatchObject({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { output: 'stdout line', isError: false },
      _meta: { terminal_exit: { terminal_id: 'call-1', exit_code: 0, signal: null } },
    })
  })

  it('publishes the slash-command roster after the session response and again on registry change', async () => {
    const roster = [
      { name: 'init', description: 'Scaffold a workspace' },
      { name: 'plan', description: 'Switch to plan mode', input: { hint: 'goal for the plan' } },
    ]
    harness = await makeBridgeHarness({ script: [textResponse('hi')] })
    harness.ctx.provide('commands', { list: () => roster } as unknown as CommandRuntime)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // Deferral contract: the roster must not race ahead of the session/new
    // response — it lands on the macrotask after the response resolves.
    expect(harness.updates.filter(update => update.sessionUpdate === 'available_commands_update'))
      .toEqual([])
    await vi.waitFor(() => {
      expect(harness!.updates.filter(update => update.sessionUpdate === 'available_commands_update'))
        .toHaveLength(1)
    })
    expect(harness.updates.find(update => update.sessionUpdate === 'available_commands_update'))
      .toMatchObject({
        availableCommands: [
          { name: 'init', description: 'Scaffold a workspace' },
          { name: 'plan', description: 'Switch to plan mode', input: { hint: 'goal for the plan' } },
        ],
      })

    // A registry change republishes the effective roster to the live session.
    roster.push({ name: 'audit', description: 'Audit the seam ledger' })
    harness.ctx.emit('commands/change')
    await vi.waitFor(() => {
      expect(harness!.updates.filter(update => update.sessionUpdate === 'available_commands_update'))
        .toHaveLength(2)
    })
    expect(harness.updates.filter(update => update.sessionUpdate === 'available_commands_update').at(-1))
      .toMatchObject({
        availableCommands: expect.arrayContaining([{ name: 'audit', description: 'Audit the seam ledger' }]),
      })
  })

  it('projects a committed todo snapshot as the plan update', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hi')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('expected the bridge-owned agent')

    harness.ctx.emit('session/event', agent.session, {
      type: 'todo/write',
      seq: SessionSeq(0),
      time: 0,
      data: { todos: [{ content: 'Wire the plan panel', status: 'in_progress' }] },
    } satisfies SessionEvent<'todo/write'>)

    await vi.waitFor(() => {
      expect(harness!.updates.find(update => update.sessionUpdate === 'plan')).toMatchObject({
        sessionUpdate: 'plan',
        entries: [{ content: 'Wire the plan panel', priority: 'medium', status: 'in_progress' }],
      })
    })
  })

  it('projects a committed session title as the session-info update', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hi')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('expected the bridge-owned agent')

    harness.ctx.emit('session/event', agent.session, {
      type: 'session/title',
      seq: SessionSeq(0),
      time: 0,
      data: { title: 'Wire the native panels', messageSeqs: [], source: { kind: 'fallback' } },
    } satisfies SessionEvent<'session/title'>)

    await vi.waitFor(() => {
      expect(harness!.updates.find(update => update.sessionUpdate === 'session_info_update')).toMatchObject({
        sessionUpdate: 'session_info_update',
        title: 'Wire the native panels',
      })
    })
  })

  it('ignores events from agents the bridge does not own', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('foreign')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const { agent } = await harness.ctx.agents.create({
      sessionId: SessionId('foreign'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(harness.updates).toHaveLength(0)
  })

  it('delivers output from a bridge-owned session driven by another in-process producer', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('external')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    expect(harness.updates[0]).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'external' },
    })
    expect('messageId' in harness.updates[0]!).toBe(true)
  })

  it('contains output conversion failure outside an ACP prompt', async () => {
    harness = await makeBridgeHarness({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${'a'.repeat(64)}` as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('output conversion failed')) })
    expect(harness.updates).toEqual([])
  })

  // `session/update` is a JSON-RPC notification, so a client-side handler
  // failure never reaches the bridge; this pins that the prompt still settles
  // normally with such a client. The bridge's own write-failure guard is
  // transport-level and documented untestable at `notify`.
  it('settles the prompt normally when the client rejects update notifications', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.onSessionUpdateError = () => {}
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })
})
