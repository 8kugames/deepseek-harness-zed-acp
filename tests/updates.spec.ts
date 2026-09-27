import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from '../src/updates.ts'

/** Minimal committed assistant event for pure update projection tests. */
function assistantEvent(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
  usage?: SessionEvent<'assistant/message'>['data']['usage'],
): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    seq: SessionSeq(0),
    time: 0,
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-1'),
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content,
      },
      ...usage === undefined ? {} : { usage },
    },
  }
}

describe('standard ACP update projection', () => {
  /** Minimal committed tool-call event for pure update projection tests. */
  function callEvent(name: string, callArguments: string): SessionEvent<'tool/call'> {
    return {
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name, arguments: callArguments },
    }
  }

  it('omits empty reasoning, unsupported assistant blocks, and absent usage', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([
      { type: 'reasoning', text: '' },
      { type: 'tool-call', id: ToolCallId('call-hidden'), name: 'hidden', arguments: '{}' },
    ])

    await expect(assistantUpdates(ctx, session, event)).resolves.toEqual([])
  })

  it('requires both measured usage and context capacity', async () => {
    const meter = { measure: vi.fn(() => ({ totalTokens: 7 })) }
    const withMeter = { get: (name: string) => name === 'tokenMeter' ? meter : undefined } as unknown as Context
    const withoutMeter = { get: () => undefined } as unknown as Context
    const withCapacity = { requestContext: () => ({ contextWindow: 100 }) } as unknown as Session
    const withoutCapacity = { requestContext: () => undefined } as unknown as Session
    const event = assistantEvent([{ type: 'text', text: 'done' }], { inputTokens: 1, outputTokens: 1 })

    expect((await assistantUpdates(withMeter, withoutCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect((await assistantUpdates(withoutMeter, withCapacity, event)).map(update => update.sessionUpdate))
      .toEqual(['agent_message_chunk'])
    expect(meter.measure).not.toHaveBeenCalled()
  })

  it('preserves malformed tool input and projects a failed result without hidden content', async () => {
    const call = toolCallUpdate({
      type: 'tool/call',
      seq: SessionSeq(0),
      time: 0,
      data: { turn: 1, step: 1, callId: ToolCallId('call-bad'), name: 'broken', arguments: '{' },
    })
    const result = await toolResultUpdate({ get: () => undefined } as unknown as Context, {
      type: 'tool/result',
      surfaceOp: 'append',
      seq: SessionSeq(0),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('tool-message'),
          role: 'tool',
          toolCallId: ToolCallId('call-bad'),
          isError: true,
          source: { kind: 'tool', callId: ToolCallId('call-bad') },
          content: [{ type: 'reasoning', text: 'hidden' }],
        },
      },
    })

    expect(call).toMatchObject({ rawInput: '{' })
    expect(result).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-bad',
      status: 'failed',
      content: [],
    })
  })

  it('titles a terminal call with its one-line command and falls back to the tool name otherwise', () => {
    expect(toolCallUpdate(callEvent('bash', JSON.stringify({ command: 'git status --short' })))).toMatchObject({
      title: 'git status --short',
      kind: 'execute',
      rawInput: { command: 'git status --short' },
    })

    const multiline = 'echo one\n  echo two'
    expect(toolCallUpdate(callEvent('pwsh', JSON.stringify({ command: multiline }))))
      .toMatchObject({ title: 'echo one echo two' })

    const long = `printf ${'x'.repeat(300)}`
    const titled = toolCallUpdate(callEvent('bash', JSON.stringify({ command: long })))
    const longTitle = titled.sessionUpdate === 'tool_call' && typeof titled.title === 'string' ? titled.title : ''
    expect(longTitle.length).toBeLessThanOrEqual(200)
    expect(longTitle.endsWith('…')).toBe(true)

    expect(toolCallUpdate(callEvent('read', JSON.stringify({ path: 'a.ts' })))).toMatchObject({ title: 'read' })
    expect(toolCallUpdate(callEvent('broken', '{'))).toMatchObject({ title: 'broken' })
  })

  it('titles known calls from their salient argument vocabulary and kinds background jobs', () => {
    expect(toolCallUpdate(callEvent('grep', JSON.stringify({ pattern: 'seed', path: 'src' }))))
      .toMatchObject({ title: 'seed', kind: 'search' })
    expect(toolCallUpdate(callEvent('web_fetch', JSON.stringify({ url: 'https://zed.dev' }))))
      .toMatchObject({ title: 'https://zed.dev', kind: 'fetch' })
    expect(toolCallUpdate(callEvent('web_search', JSON.stringify({ queries: ['acp tool calls', 'zed'] }))))
      .toMatchObject({ title: 'acp tool calls, zed', kind: 'fetch' })
    expect(toolCallUpdate(callEvent('read', JSON.stringify({ file_path: 'src/session.ts', offset: 5 }))))
      .toMatchObject({ title: 'src/session.ts', kind: 'read' })
    expect(toolCallUpdate(callEvent('edit', JSON.stringify({ file_path: 'src/session.ts', old_string: 'a', new_string: 'b' }))))
      .toMatchObject({ title: 'src/session.ts', kind: 'edit' })
    expect(toolCallUpdate(callEvent('subagent', JSON.stringify({ description: 'Audit the projection', prompt: '...' }))))
      .toMatchObject({ title: 'Audit the projection', kind: 'other' })
    expect(toolCallUpdate(callEvent('job_kill', JSON.stringify({ job_id: 'job-7' }))))
      .toMatchObject({ title: 'job_kill', kind: 'execute' })
    expect(toolCallUpdate(callEvent('job_output', JSON.stringify({ job_id: 'job-7' }))))
      .toMatchObject({ title: 'job_output', kind: 'read' })
  })
})
