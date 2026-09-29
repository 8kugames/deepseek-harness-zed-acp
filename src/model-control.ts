/** Standard ACP session configuration over one Agent's model selection. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, errorChain, type LlmCallConfig, type LlmModelReasoningInfo, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const MODEL_CONFIG_ID = 'model'
const REASONING_CONFIG_ID = 'reasoning_effort'
// DSH reasoning effort ids are non-empty, so the empty opaque ACP value is a disjoint provider-default choice.
const PROVIDER_DEFAULT_REASONING_VALUE = ''
const PREFERENCE_FILE_VERSION = 1

interface ModelChoice {
  selection: ModelSelection
  value: SessionConfigValueId
}

interface ConfigState {
  choices: Map<SessionConfigValueId, ModelSelection>
  options: SessionConfigOption[]
}

/** Caller-correctable session configuration failure. */
export class AcpModelConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpModelConfigError'
  }
}

/** Persisted reasoning-effort preference port; production uses one JSON file. */
export interface ReasoningPreferenceStore {
  /** Read every persisted route choice; a missing file reads as empty. */
  load(): Promise<Iterable<readonly [routeValue: string, effort: string]>>
  /** Merge one route choice into the persisted file; `undefined` deletes it. */
  update(routeValue: string, effort: string | undefined): Promise<void>
}

/** A preference file whose content fails format validation; safe to rebuild from empty. */
class PreferenceFormatError extends Error {}

/**
 * Build the file-backed preference store. Updates are read-merge-write with a
 * same-directory rename so a crash never leaves a torn file at the target
 * path; a corrupt file is rebuilt from the triggering update (format errors
 * only — transient I/O failures rethrow so they can never wipe usable
 * preferences), and updates are serialized per process because concurrent
 * sessions share one store instance. Cross-process writes race
 * last-writer-wins on single routes.
 * ponytail: the route count is unbounded but capped in practice by the
 * distinct provider/model pairs one user ever picks; revisit only if providers
 * start exposing rotate-by-date model ids.
 */
export function createReasoningPreferenceStore(path: string): ReasoningPreferenceStore {
  const readEntries = async (): Promise<Map<string, string>> => {
    let json: string
    try {
      json = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (_invalidJson) {
      throw new PreferenceFormatError(`invalid JSON in reasoning preference file ${path}`)
    }
    const efforts = (parsed as { efforts?: unknown })?.efforts
    if (typeof parsed !== 'object' || parsed === null
      || (parsed as { version?: unknown }).version !== PREFERENCE_FILE_VERSION
      || typeof efforts !== 'object' || efforts === null || Array.isArray(efforts)) {
      throw new PreferenceFormatError(`invalid shape in reasoning preference file ${path}`)
    }
    const entries = new Map<string, string>()
    // Whole-file integrity: one invalid entry rejects the file instead of
    // salvaging the rest — a format error means external tampering or a torn
    // write, and the next update's empty-table rebuild is the honest recovery;
    // per-entry salvage would silently resurrect half-corrupted state.
    for (const [routeValue, effort] of Object.entries(efforts as Record<string, unknown>)) {
      if (typeof effort !== 'string' || effort.length === 0) {
        throw new PreferenceFormatError(`invalid reasoning preference entry for ${routeValue} in ${path}`)
      }
      entries.set(routeValue, effort)
    }
    return entries
  }
  let updateTail: Promise<void> = Promise.resolve()
  return {
    load: async () => await readEntries(),
    update: (routeValue, effort) => {
      const operation = async (): Promise<void> => {
        let entries: Map<string, string>
        try {
          entries = await readEntries()
        } catch (error: unknown) {
          if (!(error instanceof PreferenceFormatError)) throw error
          entries = new Map()
        }
        if (effort === undefined) entries.delete(routeValue)
        else entries.set(routeValue, effort)
        await mkdir(dirname(path), { recursive: true })
        const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(tmp, `${JSON.stringify({ version: PREFERENCE_FILE_VERSION, efforts: Object.fromEntries(entries) }, null, 2)}\n`)
        await rename(tmp, path)
      }
      const result = updateTail.then(operation)
      updateTail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

/** Default user-scope path for the persisted reasoning-effort preferences. */
export function defaultReasoningPreferencePath(): string {
  return join(homedir(), '.dsh', 'zed-acp-reasoning-efforts.json')
}

/**
 * Project and mutate one Agent's provider/model/reasoning selection through ACP
 * config options. Explicitly chosen reasoning efforts are remembered per exact
 * route — optionally persisted across sessions through a preference store — so
 * switching models restores the target route's choice or carries a surviving
 * id instead of resetting to provider defaults. A route whose resolution fails
 * after an earlier success degrades to the last resolved state: the model
 * option keeps the selection and the reasoning option is reassembled from the
 * last resolved reasoning metadata for that exact route, with a warning
 * instead of a silent omission.
 */
export class AcpModelControl {
  /** Scoped selection reference consumed by Agent request assembly. */
  readonly selection: ModelSelectionRef
  private tail = Promise.resolve()
  private selected: ModelSelection | undefined
  private turnSelection: { turn: number; selection: ModelSelection } | undefined
  private hasResolvedState = false
  /**
   * Last resolved reasoning metadata per exact route, for degraded option
   * assembly. A successful resolve that reports no reasoning clears the entry,
   * so the cache always mirrors the latest successful answer. Keys reuses the
   * ACP model value; this stays valid only while `resolveCallConfig` preserves
   * the requested provider/model identity in its result (it materializes
   * defaults but never rewrites the route).
   */
  private readonly reasoningOfRoute = new Map<SessionConfigValueId, LlmModelReasoningInfo>()
  /**
   * Explicitly chosen effort per exact route, overlaying one persisted-store
   * seed loaded on first use. Route memory is what keeps a model switch from
   * discarding the user's choice; entries appear only through explicit
   * `reasoning_effort` mutations, never through adapter defaults.
   */
  private readonly effortOfRoute = new Map<SessionConfigValueId, ReasoningEffortId>()
  private persistedLoad: Promise<void> | undefined

  constructor(
    private readonly llm: LlmRuntime,
    initial: ModelSelection | undefined,
    private readonly warn: (message: string) => void,
    private readonly persist?: ReasoningPreferenceStore,
  ) {
    this.selected = initial
    const getCurrent = (): ModelSelection | undefined => this.turnSelection?.selection ?? this.selected
    const setCurrent = (value: ModelSelection | undefined): void => { this.selected = value }
    this.selection = {
      get current() { return getCurrent() },
      set current(value) { setCurrent(value) },
      assembled: undefined,
    }
  }

  /**
   * Install request/prompt consistency listeners in the unpublished Agent scope.
   * @param agentCtx - Agent scope that consumes this selection.
   */
  install(agentCtx: Context): void {
    installModelSelection(agentCtx, this.selection)
  }

  /**
   * Snapshot the selection attached to the next accepted ACP prompt.
   * @returns a detached future selection, or undefined when listeners supply the route.
   */
  snapshot(): ModelSelection | undefined {
    return this.selected === undefined ? undefined : { ...this.selected }
  }

  /**
   * Pin one admitted ACP message's selection for every step in its turn.
   * @param turn - admitted Agent turn.
   * @param selection - exact prompt-admission selection.
   */
  pinTurn(turn: number, selection: ModelSelection): void {
    this.turnSelection = { turn, selection: { ...selection } }
  }

  /**
   * Release only the exact completed turn's routing override.
   * @param turn - completed Agent turn.
   */
  releaseTurn(turn: number): void {
    if (this.turnSelection?.turn === turn) this.turnSelection = undefined
  }

  /**
   * Return the complete standard config-option state after prior mutations settle.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  options(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => (await this.state(signal)).options)
  }

  /**
   * Set one advertised option and return the complete resulting option state.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  set(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => {
      if (typeof value !== 'string') throw new AcpModelConfigError(`${configId} requires a select value`)
      const current = this.selected
      if (current === undefined) throw new AcpModelConfigError('this session has no model selection')
      if (configId === MODEL_CONFIG_ID) {
        const state = await this.state(signal)
        const target = state.choices.get(value)
        if (target === undefined) throw new AcpModelConfigError(`unknown model option: ${value}`)
        // Re-read after state(): its adoption may have just materialized the
        // remembered effort onto this.selected, and the carry-over layer must
        // see it even when the client never pulled options first.
        const from: ModelSelection = this.selected ?? current
        const effort = await this.switchEffort(from, target, signal)
        const switched: ModelSelection = { ...target, ...effort === undefined ? {} : { reasoningEffort: effort } }
        await this.resolveSelection(switched, signal)
        this.selected = switched
      } else if (configId === REASONING_CONFIG_ID) {
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE
          && info.reasoning?.defaultEffort === undefined
        if (
          info.reasoning === undefined
          || (!providerDefault && !info.reasoning.efforts.some(effort => effort.id === value))
        ) {
          throw new AcpModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`)
        }
        this.selected = await this.resolveSelection({
          provider: current.provider,
          model: current.model,
          ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) },
        }, signal)
        const route = modelValue(current.provider, current.model)
        if (value === PROVIDER_DEFAULT_REASONING_VALUE) this.effortOfRoute.delete(route)
        else this.effortOfRoute.set(route, ReasoningEffortId(value))
        if (this.persist !== undefined) {
          // Write-through failure only loses persistence; the in-session choice already holds.
          await this.persist.update(route, value === PROVIDER_DEFAULT_REASONING_VALUE ? undefined : value)
            .catch((error: unknown) => {
              this.warn(`acp: reasoning preference persist failed for ${current.provider}/${current.model}: ${errorChain(error)}`)
            })
        }
      } else {
        throw new AcpModelConfigError(`unknown session config option: ${configId}`)
      }
      return (await this.state(signal)).options
    })
  }

  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Build detached model choices and the dependent reasoning option. */
  private async state(signal?: AbortSignal): Promise<ConfigState> {
    let selected = this.selected
    if (selected === undefined) return { choices: new Map(), options: [] }
    // Adopt the route's remembered effort when this session has no explicit
    // choice yet: a remembered preference outranks the adapter's default.
    if (selected.reasoningEffort === undefined) {
      const remembered = await this.rememberedEffort(selected)
      if (remembered !== undefined) {
        // Support probing only drops stale ids; route failures stay
        // authoritative in the resolveSelection below, which retries the same
        // adapter and either fails loudly or degrades with a warning. A
        // transiently failing probe only delays adoption to the next options()
        // call: this.selected never records the materialized adapter default,
        // so the adoption precondition keeps holding until it succeeds.
        const supported = await this.llm.resolveModelInfo(selected.provider, selected.model, signal)
          .then(info => info.reasoning?.efforts.some(effort => effort.id === remembered) === true)
          .catch(() => false)
        if (supported) {
          selected = { ...selected, reasoningEffort: remembered }
          this.selected = selected
        }
      }
    }
    let resolved: ModelSelection
    let routeAvailable = true
    try {
      resolved = await this.resolveSelection(selected, signal)
      this.hasResolvedState = true
    } catch (error: unknown) {
      if (!this.hasResolvedState) throw error
      resolved = selected
      routeAvailable = false
      this.warn(`acp: model route resolution degraded to the last known state for ${selected.provider}/${selected.model}: ${errorChain(error)}`)
    }
    const choices = new Map<SessionConfigValueId, ModelSelection>()
    const groups = await Promise.all(this.llm.listProviders().map(async (provider) => {
      try {
        const models = await this.llm.listModels(provider.id)
        const entries = models.map((model) => {
          const choice: ModelChoice = {
            value: modelValue(provider.id, model.id),
            selection: { provider: provider.id, model: model.id },
          }
          choices.set(choice.value, choice.selection)
          return {
            value: choice.value,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
          }
        })
        return { group: provider.id, name: provider.name, options: entries }
      } catch (_providerCatalogUnavailable) {
        return { group: provider.id, name: provider.name, options: [] }
      }
    }))
    const currentValue = modelValue(resolved.provider, resolved.model)
    if (!choices.has(currentValue)) {
      choices.set(currentValue, { provider: resolved.provider, model: resolved.model })
      let group = groups.find(item => item.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    const options: SessionConfigOption[] = [{
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: groups.filter(group => group.options.length > 0),
    }]
    const info = routeAvailable
      ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      : undefined
    if (routeAvailable) {
      const route = modelValue(resolved.provider, resolved.model)
      if (info?.reasoning !== undefined) this.reasoningOfRoute.set(route, info.reasoning)
      else this.reasoningOfRoute.delete(route)
    }
    // A degraded resolve serves the last resolved reasoning metadata for this
    // exact route so a transient catalog failure cannot silently unpublish the
    // selector; a successful resolve that reports no reasoning stays omitted.
    const reasoning = info?.reasoning
      ?? (routeAvailable ? undefined : this.reasoningOfRoute.get(modelValue(resolved.provider, resolved.model)))
    if (reasoning !== undefined) {
      if (resolved.reasoningEffort === undefined && reasoning.defaultEffort !== undefined) {
        resolved = { ...resolved, reasoningEffort: reasoning.defaultEffort }
      }
      options.push(this.reasoningOption(reasoning, resolved.reasoningEffort))
    }
    return { choices, options }
  }

  /** Assemble the reasoning-effort selector from resolved route metadata. */
  private reasoningOption(reasoning: LlmModelReasoningInfo, currentEffort: ReasoningEffortId | undefined): SessionConfigOption {
    return {
      id: REASONING_CONFIG_ID,
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: currentEffort === undefined
        ? PROVIDER_DEFAULT_REASONING_VALUE
        : String(currentEffort),
      options: [
        ...reasoning.defaultEffort === undefined
          ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
          : [],
        ...reasoning.efforts.map(effort => ({
          value: String(effort.id),
          name: effort.name,
          ...effort.description === undefined ? {} : { description: effort.description },
        })),
      ],
    }
  }

  /**
   * Resolve the reasoning effort one model switch should carry: the target
   * route's remembered choice first, the outgoing explicit choice second when
   * its id survives on the target, and no field otherwise so provider
   * defaults materialize. A support-probe failure only drops the carry-over;
   * the route-validating resolveSelection after it stays the authoritative
   * failure path, so a transient catalog hiccup can never fail the switch.
   */
  private async switchEffort(from: ModelSelection, to: ModelSelection, signal?: AbortSignal): Promise<ReasoningEffortId | undefined> {
    const remembered = await this.rememberedEffort(to)
    const candidates = [remembered, from.reasoningEffort]
      .filter((effort): effort is ReasoningEffortId => effort !== undefined)
    if (candidates.length === 0) return undefined
    const reasoning = await this.llm.resolveModelInfo(to.provider, to.model, signal)
      .then(info => info.reasoning)
      .catch(() => undefined)
    if (reasoning === undefined) return undefined
    return candidates.find(effort => reasoning.efforts.some(candidate => candidate.id === effort))
  }

  /**
   * Read one exact route's remembered explicit effort. Session choices
   * overlay a persisted store seeded once on first use, so a fresh session
   * adopts the user's cross-install preference before any explicit choice.
   */
  private async rememberedEffort(route: { provider: string; model: string }): Promise<ReasoningEffortId | undefined> {
    if (this.persist !== undefined && this.persistedLoad === undefined) {
      this.persistedLoad = this.persist.load().then((entries) => {
        for (const [routeValue, effort] of entries) {
          if (!this.effortOfRoute.has(routeValue)) this.effortOfRoute.set(routeValue, ReasoningEffortId(effort))
        }
      }, (error: unknown) => {
        this.warn(`acp: reasoning preference seed failed: ${errorChain(error)}`)
      })
    }
    await this.persistedLoad
    return this.effortOfRoute.get(modelValue(route.provider, route.model))
  }

  /** Validate an exact route and retain only Agent-owned selection fields. */
  private async resolveSelection(selection: ModelSelection, signal?: AbortSignal): Promise<ModelSelection> {
    const resolved: LlmCallConfig = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
  }
}

/** Opaque ACP selector value carrying the full route identity. */
function modelValue(provider: string, model: string): SessionConfigValueId {
  return JSON.stringify([provider, model])
}
