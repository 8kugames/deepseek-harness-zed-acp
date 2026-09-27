/** Unit and bridge coverage for turn statistics, pricing, and cost reporting. */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AssistantStreamRecord, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'
import {
  DEEPSEEK_PRICE_TABLE,
  TurnStatsCollector,
  buildPriceTable,
  formatStatsCard,
  foldTurnStats,
  isPeakUtcTime,
  mergePriceOverrides,
  parsePriceOverrides,
  priceUsage,
  resolvePrice,
  statsMeta,
  type SessionStats,
  type TurnStats,
} from '../src/stats.ts'

/** 2026-09-28 is a Monday: 07:00 UTC is inside the 06:00–10:00 peak window. */
const PEAK_MS = Date.UTC(2026, 8, 28, 7, 0, 0)
/** The same Monday at 12:00 UTC is off-peak. */
const OFF_PEAK_MS = Date.UTC(2026, 8, 28, 12, 0, 0)
/** The following Sunday is off-peak all day. */
const SUNDAY_MS = Date.UTC(2026, 9, 4, 7, 0, 0)

function textRun(time0: number, dt: readonly number[], texts: readonly string[]): AssistantStreamRecord {
  return { type: 'text-chunks', time0, index: 0, dt, texts }
}

function event(type: 'turn/start' | 'turn/end', turn: number, time: number): SessionEvent {
  return type === 'turn/start'
    ? { type, seq: 1 as never, time, data: { turn } }
    : { type, seq: 2 as never, time, data: { turn, reason: { kind: 'completed' } } }
}

function stepStart(turn: number, step: number, time: number): SessionEvent {
  return { type: 'step/start', seq: 3 as never, time, data: { turn, step } }
}

function assistantMessage(
  turn: number,
  step: number,
  time: number,
  stream: readonly AssistantStreamRecord[],
  usage: TokenUsage | undefined,
): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 4 as never,
    time,
    data: {
      turn,
      step,
      message: { id: 'm1', role: 'assistant', content: [] } as never,
      stream: [...stream],
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent
}

function toolCall(turn: number, callId: string, time: number): SessionEvent {
  return { type: 'tool/call', seq: 5 as never, time, data: { turn, step: 0, callId: callId as never, name: 'echo', arguments: '{}' } }
}

function toolResult(turn: number, callId: string, time: number): SessionEvent {
  return {
    type: 'tool/result',
    seq: 6 as never,
    time,
    data: { turn, step: 0, message: { toolCallId: callId as never, role: 'tool', content: [] } as never },
  } as unknown as SessionEvent
}

/** One turn: a model step with a stream, one tool round, then a second model step. */
function collectTwoStepTurn(prices = DEEPSEEK_PRICE_TABLE, model = 'deepseek-flash', atMs = PEAK_MS): TurnStats | undefined {
  const collector = new TurnStatsCollector(7, () => model, prices)
  collector.record(event('turn/start', 7, atMs))
  collector.record(stepStart(7, 0, atMs + 100))
  collector.record(assistantMessage(7, 0, atMs + 2_000, [textRun(atMs + 900, [100], ['a', 'b'])], {
    inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 20,
  }))
  collector.record(toolCall(7, 'c1', atMs + 2_100))
  collector.record(toolResult(7, 'c1', atMs + 2_600))
  collector.record(stepStart(7, 1, atMs + 2_700))
  collector.record(assistantMessage(7, 1, atMs + 4_000, [textRun(atMs + 3_400, [], ['done'])], {
    inputTokens: 1_200, outputTokens: 30,
  }))
  collector.record(event('turn/end', 7, atMs + 4_100))
  return collector.result()
}

describe('turn statistics collection', () => {
  it('derives timing and token totals from durable event times', () => {
    const stats = collectTwoStepTurn()
    expect(stats).toBeDefined()
    if (stats === undefined) return
    expect(stats.turn).toBe(7)
    // Step 0: stream ends at time0+100 = atMs+1000; step started at atMs+100 → 900ms.
    // Step 1: single-chunk stream ends at its time0 = atMs+3400; step started at atMs+2700 → 700ms.
    expect(stats.modelMs).toBe(1_600)
    expect(stats.toolMs).toBe(500)
    // Decode windows: 100ms (two chunks) and 0ms (single chunk, excluded).
    expect(stats.outputMs).toBe(100)
    expect(stats.ttftSamplesMs).toEqual([800, 700])
    expect(stats.usage).toEqual({
      inputTokens: 2_200,
      outputTokens: 80,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 20,
      modelCalls: 2,
    })
  })

  it('prices listed models per model call and reports no cost for unlisted ones', () => {
    const priced = collectTwoStepTurn()
    // flash peak: 800 hit·0.006 + 200 miss·0.3 + 50 out·1.2 = 124.8 → $0.0001248;
    // second call uncached: 1200·0.3 + 30·1.2 = 396 → $0.000396.
    expect(priced?.cost).toEqual({ amount: 0.000521, currency: 'USD' })

    const unpriced = collectTwoStepTurn(DEEPSEEK_PRICE_TABLE, 'mock')
    expect(unpriced?.cost).toBeUndefined()
  })

  it('ignores events from other turns', () => {
    const collector = new TurnStatsCollector(1, () => 'mock', DEEPSEEK_PRICE_TABLE)
    collector.record(event('turn/start', 2, 0))
    collector.record(stepStart(2, 0, 0))
    collector.record(assistantMessage(2, 0, 10, [textRun(5, [], ['x'])], { inputTokens: 1, outputTokens: 1 }))
    expect(collector.result()).toBeUndefined()
  })

  it('returns undefined when no model call reported usage', () => {
    const collector = new TurnStatsCollector(3, () => 'mock', DEEPSEEK_PRICE_TABLE)
    collector.record(event('turn/start', 3, 0))
    collector.record(stepStart(3, 0, 10))
    collector.record(assistantMessage(3, 0, 20, [textRun(15, [], ['x'])], undefined))
    collector.record(event('turn/end', 3, 30))
    expect(collector.result()).toBeUndefined()
  })
})

describe('DeepSeek list pricing', () => {
  it('classifies weekday peak windows', () => {
    expect(isPeakUtcTime(PEAK_MS)).toBe(true)
    expect(isPeakUtcTime(Date.UTC(2026, 8, 28, 1, 30))).toBe(true)
    expect(isPeakUtcTime(OFF_PEAK_MS)).toBe(false)
    expect(isPeakUtcTime(SUNDAY_MS)).toBe(false)
    expect(isPeakUtcTime(Date.UTC(2026, 8, 28, 4, 0))).toBe(false)
  })

  it('bills tiered models at peak rates and exactly half off-peak', () => {
    const peak = resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', PEAK_MS)
    expect(peak).toEqual({ rates: { hit: 0.006, miss: 0.3, out: 1.2 }, currency: 'USD' })
    const offPeak = resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', OFF_PEAK_MS)
    expect(offPeak).toEqual({ rates: { hit: 0.003, miss: 0.15, out: 0.6 }, currency: 'USD' })
  })

  it('resolves retired aliases and leaves unknown models unpriced', () => {
    expect(resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-v4-flash', PEAK_MS)).toEqual(
      resolvePrice(DEEPSEEK_PRICE_TABLE, 'deepseek-flash', PEAK_MS),
    )
    expect(resolvePrice(DEEPSEEK_PRICE_TABLE, 'some-gateway-model', PEAK_MS)).toBeUndefined()
  })

  it('prices cache reads at the hit rate and the remainder at the miss rate', () => {
    const rates = { hit: 0.006, miss: 0.3, out: 1.2 }
    expect(priceUsage(rates, { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800 }))
      .toBeCloseTo(0.0001248, 10)
    // Reads beyond the reported input still bill at the hit rate; the miss
    // side never goes negative.
    expect(priceUsage(rates, { inputTokens: 300, outputTokens: 0, cacheReadTokens: 1_000 }))
      .toBeCloseTo(0.000006, 10)
  })
})

describe('DSH_ACP_PRICES overrides', () => {
  it('parses flat entries and lets them shadow tiered and unknown models', () => {
    const overrides = parsePriceOverrides('{"my-model":{"hit":0.1,"miss":1,"out":2,"currency":"CNY"}}')
    const table = mergePriceOverrides(DEEPSEEK_PRICE_TABLE, overrides)
    expect(resolvePrice(table, 'my-model', PEAK_MS)).toEqual({ rates: { hit: 0.1, miss: 1, out: 2 }, currency: 'CNY' })
    const replaced = parsePriceOverrides('{"deepseek-flash":{"hit":0,"miss":0,"out":0}}')
    const zeroed = mergePriceOverrides(DEEPSEEK_PRICE_TABLE, replaced)
    expect(resolvePrice(zeroed, 'deepseek-flash', PEAK_MS)?.rates.miss).toBe(0)
  })

  it('rejects malformed documents with a descriptive error', () => {
    expect(() => parsePriceOverrides('[]')).toThrow(/object/)
    expect(() => parsePriceOverrides('{"m":{"hit":"x","miss":1,"out":1}}')).toThrow(/hit/)
    expect(() => parsePriceOverrides('{"m":{"hit":1,"miss":1,"out":1,"currency":"dollars"}}')).toThrow(/currency/)
    expect(() => parsePriceOverrides('not json')).toThrow()
  })

  it('builds the default table for absent values and warns for malformed ones', () => {
    expect(buildPriceTable(undefined, () => { throw new Error('unreachable') })).toBe(DEEPSEEK_PRICE_TABLE)
    expect(buildPriceTable('  ', () => { throw new Error('unreachable') })).toBe(DEEPSEEK_PRICE_TABLE)
    const warnings: string[] = []
    const table = buildPriceTable('nope', (message) => { warnings.push(message) })
    expect(table).toBe(DEEPSEEK_PRICE_TABLE)
    expect(warnings[0]).toMatch(/DSH_ACP_PRICES ignored/)
  })
})

describe('stats presentation', () => {
  const session: SessionStats = {
    usage: { inputTokens: 2_200, outputTokens: 80, cacheReadTokens: 800, cacheWriteTokens: 100, reasoningTokens: 20, modelCalls: 2 },
    cost: { amount: 0.000521, currency: 'USD' },
  }

  it('renders the card with token rows, timing, and cost', () => {
    const stats = collectTwoStepTurn()
    if (stats === undefined) throw new Error('expected stats')
    const card = formatStatsCard(stats, session, 'deepseek-flash')
    expect(card).toContain('**Turn stats · deepseek-flash**')
    expect(card).toContain('model 1.6s')
    expect(card).toContain('tools 500ms')
    expect(card).toContain('| Input · cache read | 800 |')
    expect(card).toContain('| Input · uncached | 1,300 |')
    expect(card).toContain('| Output · reasoning | 20 |')
    expect(card).toContain('avg first token 750ms')
    expect(card).toContain('output 800.0 tok/s')
    expect(card).toContain('turn $0.0005')
    expect(card).toContain('session $0.0005')
  })

  it('omits timing and cost segments without facts', () => {
    const bare: TurnStats = {
      turn: 1,
      usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1 },
      modelMs: 0,
      toolMs: 0,
      outputMs: 0,
      ttftSamplesMs: [],
      cost: undefined,
    }
    const card = formatStatsCard(bare, { usage: bare.usage, cost: undefined }, undefined)
    expect(card).toContain('**Turn stats**')
    expect(card).toContain('| Input · uncached | 10 |')
    expect(card).not.toContain('cache read')
    expect(card).not.toContain('avg first token')
    expect(card).not.toContain('tok/s')
    expect(card).not.toContain('$')
  })

  it('folds turns into session totals and emits machine-readable meta', () => {
    const stats = collectTwoStepTurn()
    if (stats === undefined) throw new Error('expected stats')
    const folded = foldTurnStats({ usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 }, cost: undefined }, stats)
    expect(folded.usage.modelCalls).toBe(2)
    expect(folded.cost).toEqual({ amount: 0.000521, currency: 'USD' })
    const meta = statsMeta(stats, folded)
    expect(meta.dsh.turn).toMatchObject({ turn: 7, inputTokens: 2_200, modelMs: 1_600, toolMs: 500, ttftAvgMs: 750 })
    expect(meta.dsh.session).toMatchObject({ modelCalls: 2, cost: { amount: 0.000521, currency: 'USD' } })
  })
})

describe('bridge turn-stats delivery', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('emits the card and a final usage_update with _meta after a completed turn', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('hi')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(result.stopReason).toBe('end_turn')
    await vi.waitFor(() => { expect(harness!.updates.at(-1)?.sessionUpdate).toBe('usage_update') })

    const card = harness.updates.find(update =>
      update.sessionUpdate === 'agent_message_chunk' && 'messageId' in update && update.messageId?.startsWith('dsh-stats-'))
    expect(card).toMatchObject({ sessionUpdate: 'agent_message_chunk', content: { type: 'text' } })
    if (card?.sessionUpdate !== 'agent_message_chunk' || card.content.type !== 'text') throw new Error('expected card')
    expect(card.content.text).toContain('**Turn stats')
    expect(card.content.text).toContain('| Output | 2 |')

    const final = harness.updates.at(-1)
    if (final?.sessionUpdate !== 'usage_update') throw new Error('expected final usage update')
    expect(final._meta?.dsh).toMatchObject({
      turn: expect.objectContaining({ inputTokens: 5, modelCalls: 1 }),
      session: expect.objectContaining({ modelCalls: 1 }),
    })
    expect(final.cost).toBeUndefined()
  })
})
