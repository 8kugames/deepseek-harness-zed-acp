/**
 * Turn-scoped token and timing statistics derived from committed DSH events,
 * plus DeepSeek list pricing for cumulative session cost reporting.
 *
 * Timing reads the durable facts themselves: `step/start` anchors each model
 * call, the assistant stream records carry per-chunk times, and tool duration
 * is the `tool/call` → `tool/result` gap. Nothing here watches the clock at
 * projection time, so replayed facts reproduce identical numbers.
 * @module @8kugames/dsh-zed-acp/stats
 */

import { assistantStreamFirstTokenTime, type AssistantStreamRecord, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Per-1M-token prices for one pricing tier. */
export interface UsagePrice {
  /** 1M input tokens served from cache. */
  hit: number
  /** 1M input tokens not served from cache (cache writes bill here). */
  miss: number
  /** 1M output tokens. */
  out: number
}

/** Env-override entry: flat rates applied at every hour. */
export interface FlatPriceEntry extends UsagePrice {
  /** ISO 4217 code; defaults to USD. */
  currency: string
}

/** Built-in entry: peak rates; off-peak hours bill at exactly half. */
export interface TieredPriceEntry {
  peak: UsagePrice
  currency: string
}

/** Resolved model prices: rate triple plus billing currency. */
export interface ResolvedPrice {
  rates: UsagePrice
  currency: string
}

/** Model → price resolution state, built once per bridge process. */
export interface PriceTable {
  /** Exact-id flat entries (DSH_ACP_PRICES overrides) checked first. */
  flat: ReadonlyMap<string, FlatPriceEntry>
  /** Canonical-id tiered entries for DeepSeek's published list prices. */
  tiered: ReadonlyMap<string, TieredPriceEntry>
  /** Retired model ids redirected to their serving successor. */
  aliases: ReadonlyMap<string, string>
}

/**
 * DeepSeek list prices (USD per 1M tokens), published 2026-09 on
 * api-docs.deepseek.com: peak hours 01:00–04:00 and 06:00–10:00 UTC on
 * weekdays, off-peak exactly half. Chinese-public-holiday exclusion is not
 * modeled; override with DSH_ACP_PRICES when that precision matters.
 */
export const DEEPSEEK_PRICE_TABLE: PriceTable = {
  flat: new Map(),
  tiered: new Map([
    ['deepseek-flash', { peak: { hit: 0.006, miss: 0.3, out: 1.2 }, currency: 'USD' }],
    ['deepseek-v4-pro', { peak: { hit: 0.044, miss: 1.32, out: 3.96 }, currency: 'USD' }],
  ]),
  aliases: new Map([
    ['deepseek-v4-flash', 'deepseek-flash'],
    ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
  ]),
}

/**
 * Whether a UTC instant falls in DeepSeek's published peak window:
 * 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday.
 * @param ms - Unix epoch milliseconds.
 * @returns true inside a weekday peak window.
 */
export function isPeakUtcTime(ms: number): boolean {
  const date = new Date(ms)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Validate one parsed DSH_ACP_PRICES entry and normalize its currency. */
function normalizeEntry(model: string, value: unknown): FlatPriceEntry {
  if (typeof value !== 'object' || value === null) throw new Error(`entry "${model}" must be an object`)
  const { hit, miss, out, currency } = value as Record<string, unknown>
  const rates = { hit, miss, out } as Record<string, unknown>
  for (const [name, rate] of Object.entries(rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`entry "${model}" field "${name}" must be a finite non-negative number`)
    }
  }
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error(`entry "${model}" currency must be an ISO 4217 code such as "USD"`)
  }
  return { hit: hit as number, miss: miss as number, out: out as number, currency: currency === undefined ? 'USD' : currency as string }
}

/**
 * Parse the DSH_ACP_PRICES override document: an object mapping model ids to
 * `{ hit, miss, out, currency? }` per-1M flat rates.
 * @param json - raw environment value.
 * @returns validated flat entries by exact model id.
 * @throws Error describing the first malformed aspect.
 */
export function parsePriceOverrides(json: string): Map<string, FlatPriceEntry> {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('value must be a JSON object of model entries')
  }
  const entries = new Map<string, FlatPriceEntry>()
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    entries.set(model, normalizeEntry(model, value))
  }
  return entries
}

/**
 * Overlay flat env entries on a base table; flat entries win over tiered ones
 * for the same resolved id, and extra ids add new coverage.
 */
export function mergePriceOverrides(base: PriceTable, overrides: ReadonlyMap<string, FlatPriceEntry>): PriceTable {
  return { ...base, flat: new Map([...base.flat, ...overrides]) }
}

/**
 * Resolve one model's price at one instant.
 * @param table - merged price table.
 * @param model - model id exactly as selected (aliases resolve first).
 * @param atMs - Unix epoch milliseconds deciding the tier.
 * @returns rates plus currency, or undefined when the model is unlisted.
 */
export function resolvePrice(table: PriceTable, model: string, atMs: number): ResolvedPrice | undefined {
  const canonical = table.aliases.get(model) ?? model
  const flat = table.flat.get(canonical) ?? table.flat.get(model)
  if (flat !== undefined) return { rates: { hit: flat.hit, miss: flat.miss, out: flat.out }, currency: flat.currency }
  const tiered = table.tiered.get(canonical)
  if (tiered === undefined) return undefined
  if (isPeakUtcTime(atMs)) return { rates: tiered.peak, currency: tiered.currency }
  const { hit, miss, out } = tiered.peak
  return { rates: { hit: hit / 2, miss: miss / 2, out: out / 2 }, currency: tiered.currency }
}

/**
 * Price one usage record: cache-read tokens at the hit rate, the remaining
 * input at the miss rate (DeepSeek bills cache writes as misses), output at
 * the out rate.
 * @param rates - per-1M prices.
 * @param usage - one model call's accounting.
 * @returns cost in the entry's currency unit.
 */
export function priceUsage(rates: UsagePrice, usage: TokenUsage): number {
  const cached = usage.cacheReadTokens ?? 0
  const uncached = Math.max(0, usage.inputTokens - cached)
  return (cached * rates.hit + uncached * rates.miss + usage.outputTokens * rates.out) / 1_000_000
}

/**
 * Compose the process-wide table from the environment, containing malformed
 * overrides with a warning instead of failing the bridge.
 * @param env - raw DSH_ACP_PRICES value, if set.
 * @param warn - warning sink for a rejected document.
 * @returns the effective price table.
 */
export function buildPriceTable(env: string | undefined, warn: (message: string) => void): PriceTable {
  if (env === undefined || env.trim() === '') return DEEPSEEK_PRICE_TABLE
  try {
    return mergePriceOverrides(DEEPSEEK_PRICE_TABLE, parsePriceOverrides(env))
  } catch (error: unknown) {
    warn(`DSH_ACP_PRICES ignored: ${(error as Error).message}`)
    return DEEPSEEK_PRICE_TABLE
  }
}

/** Cumulative token accounting across the model calls of one scope. */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Model calls that reported usage. */
  modelCalls: number
}

/** Final statistics for one Agent turn, priced where the model is listed. */
export interface TurnStats {
  turn: number
  usage: UsageTotals
  /** Σ per model call of (last stream chunk − step start): request to stream end. */
  modelMs: number
  /** Σ over tool calls of (tool/result − tool/call). */
  toolMs: number
  /** Σ per model call of (last chunk − first token): the visible decode window. */
  outputMs: number
  /** Per model call, first-token time minus that call's step start. */
  ttftSamplesMs: number[]
  /** Priced cost of this turn's usage, when every listing resolved. */
  cost: { amount: number; currency: string } | undefined
}

/** Session-lifetime totals kept by the ACP session for final updates. */
export interface SessionStats {
  usage: UsageTotals
  /** Cumulative cost across live turns since this ACP session opened. */
  cost: { amount: number; currency: string } | undefined
}

/** Last chunk time across one settlement's compact stream records. */
function lastStreamTime(stream: readonly AssistantStreamRecord[]): number | undefined {
  let last: number | undefined
  for (const record of stream) {
    const time = record.type === 'chunk' ? record.time : record.time0 + record.dt.reduce((sum, delta) => sum + delta, 0)
    if (last === undefined || time > last) last = time
  }
  return last
}

/** Add one call's usage into running totals, preserving reported cache fields. */
function addUsage(totals: UsageTotals, usage: TokenUsage): UsageTotals {
  const read = (totals.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
  const write = (totals.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const reasoning = (totals.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: read === 0 ? undefined : read,
    cacheWriteTokens: write === 0 ? undefined : write,
    reasoningTokens: reasoning === 0 ? undefined : reasoning,
    modelCalls: totals.modelCalls + 1,
  }
}

/** Round a currency amount away from floating-point noise. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Accumulate one Agent turn's statistics from its committed events. The
 * collector is created at `turn/start`, fed every event of that turn, and
 * finalized at `turn/end`; events of other turns are ignored.
 */
export class TurnStatsCollector {
  private readonly stepStarts = new Map<number, number>()
  private readonly toolStarts = new Map<string, number>()
  private usage: UsageTotals = { inputTokens: 0, outputTokens: 0, modelCalls: 0 }
  private modelMs = 0
  private toolMs = 0
  private outputMs = 0
  private readonly ttftSamplesMs: number[] = []
  private costAmount = 0
  private costCurrency: string | undefined

  /**
   * @param turn - the turn number this collector follows.
   * @param modelId - live model selection at each usage-bearing event.
   * @param prices - effective price table.
   */
  constructor(
    readonly turn: number,
    private readonly modelId: () => string | undefined,
    private readonly prices: PriceTable,
  ) {}

  /**
   * Fold one committed session event into the running statistics when it
   * belongs to this collector's turn.
   * @param event - committed durable event with its authoritative time.
   */
  record(event: SessionEvent): void {
    if (event.type === 'step/start') {
      if (event.data.turn === this.turn) this.stepStarts.set(event.data.step, event.time)
      return
    }
    if (event.type === 'tool/call') {
      if (event.data.turn === this.turn) this.toolStarts.set(event.data.callId, event.time)
      return
    }
    if (event.type === 'tool/result') {
      if (event.data.turn !== this.turn) return
      const start = this.toolStarts.get(event.data.message.toolCallId)
      if (start === undefined) return
      this.toolStarts.delete(event.data.message.toolCallId)
      this.toolMs += Math.max(0, event.time - start)
      return
    }
    if (event.type === 'assistant/message') {
      if (event.data.turn !== this.turn) return
      const { stream, usage } = event.data
      const start = this.stepStarts.get(event.data.step)
      const first = assistantStreamFirstTokenTime(stream)
      const last = lastStreamTime(stream)
      if (start !== undefined) {
        if (first !== undefined) this.ttftSamplesMs.push(Math.max(0, first - start))
        this.modelMs += Math.max(0, (last ?? event.time) - start)
      }
      if (first !== undefined && last !== undefined && last > first) this.outputMs += last - first
      if (usage === undefined) return
      this.usage = addUsage(this.usage, usage)
      const priced = resolvePrice(this.prices, this.modelId() ?? '', event.time)
      if (priced !== undefined) {
        this.costAmount += priceUsage(priced.rates, usage)
        this.costCurrency = priced.currency
      }
    }
  }

  /**
   * Finalize the turn.
   * @returns its statistics, or undefined when no model call reported usage.
   */
  result(): TurnStats | undefined {
    if (this.usage.modelCalls === 0) return undefined
    return {
      turn: this.turn,
      usage: this.usage,
      modelMs: this.modelMs,
      toolMs: this.toolMs,
      outputMs: this.outputMs,
      ttftSamplesMs: this.ttftSamplesMs,
      cost: this.costCurrency === undefined
        ? undefined
        : { amount: round6(this.costAmount), currency: this.costCurrency },
    }
  }
}

/**
 * Fold one finalized turn into session-lifetime totals.
 * @param session - running session totals.
 * @param turn - the finalized turn's statistics.
 * @returns the next session totals snapshot.
 */
export function foldTurnStats(session: SessionStats, turn: TurnStats): SessionStats {
  const usage: UsageTotals = {
    ...addUsage(session.usage, turn.usage),
    modelCalls: session.usage.modelCalls + turn.usage.modelCalls,
  }
  const cost = turn.cost === undefined
    ? session.cost
    : {
        amount: round6((session.cost?.amount ?? 0) + turn.cost.amount),
        currency: turn.cost.currency,
      }
  return { usage, cost }
}

/** Format a millisecond duration compactly for the stats card. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Format a currency amount with stable precision. */
function formatMoney(amount: number, currency: string): string {
  return currency === 'USD' ? `$${amount.toFixed(4)}` : `${amount.toFixed(4)} ${currency}`
}

/**
 * Render the end-of-turn statistics card as the markdown text of one ACP
 * agent message. Cache rows appear only when the adapter reported them;
 * timing and cost segments appear only when their facts exist.
 * @param turn - finalized turn statistics.
 * @param session - session-lifetime totals for the cumulative line.
 * @param modelId - model selection that served the turn, if known.
 * @returns the card's markdown text.
 */
export function formatStatsCard(turn: TurnStats, session: SessionStats, modelId: string | undefined): string {
  const lines: string[] = []
  const title = modelId === undefined ? 'Turn stats' : `Turn stats · ${modelId}`
  lines.push(`**${title}** — model ${formatMs(turn.modelMs)} · tools ${formatMs(turn.toolMs)}`, '')
  lines.push('| | tokens |', '|---|---:|')
  const read = turn.usage.cacheReadTokens
  const write = turn.usage.cacheWriteTokens
  if (read !== undefined) lines.push(`| Input · cache read | ${read.toLocaleString('en-US')} |`)
  if (write !== undefined) lines.push(`| Input · cache write | ${write.toLocaleString('en-US')} |`)
  const cached = (read ?? 0) + (write ?? 0)
  lines.push(`| Input · uncached | ${Math.max(0, turn.usage.inputTokens - cached).toLocaleString('en-US')} |`)
  lines.push(`| Output | ${turn.usage.outputTokens.toLocaleString('en-US')} |`)
  if ((turn.usage.reasoningTokens ?? 0) > 0) {
    lines.push(`| Output · reasoning | ${(turn.usage.reasoningTokens ?? 0).toLocaleString('en-US')} |`)
  }
  lines.push('')
  const tail: string[] = []
  if (turn.ttftSamplesMs.length > 0) {
    const avg = turn.ttftSamplesMs.reduce((sum, sample) => sum + sample, 0) / turn.ttftSamplesMs.length
    tail.push(`avg first token ${formatMs(avg)}`)
  }
  if (turn.outputMs >= 50) tail.push(`output ${(turn.usage.outputTokens / (turn.outputMs / 1000)).toFixed(1)} tok/s`)
  if (turn.cost !== undefined) tail.push(`turn ${formatMoney(turn.cost.amount, turn.cost.currency)}`)
  if (session.cost !== undefined) tail.push(`session ${formatMoney(session.cost.amount, session.cost.currency)}`)
  if (tail.length > 0) lines.push(tail.join(' · '))
  return lines.join('\n')
}

/**
 * Build the forward-compatibility `_meta` payload for the final usage update:
 * the same facts the card renders, in machine-readable form under a `dsh`
 * namespace ACP clients may ignore.
 * @param turn - finalized turn statistics.
 * @param session - session-lifetime totals.
 * @returns the `_meta` object for `usage_update`.
 */
export function statsMeta(turn: TurnStats, session: SessionStats): { dsh: Record<string, unknown> } {
  const ttftAvg = turn.ttftSamplesMs.length === 0
    ? undefined
    : Math.round(turn.ttftSamplesMs.reduce((sum, sample) => sum + sample, 0) / turn.ttftSamplesMs.length)
  return {
    dsh: {
      turn: {
        turn: turn.turn,
        ...turn.usage,
        modelMs: turn.modelMs,
        toolMs: turn.toolMs,
        outputMs: turn.outputMs,
        ttftAvgMs: ttftAvg,
        outputTps: turn.outputMs >= 50 ? Number((turn.usage.outputTokens / (turn.outputMs / 1000)).toFixed(2)) : undefined,
        cost: turn.cost,
      },
      session: {
        ...session.usage,
        cost: session.cost,
      },
    },
  }
}
