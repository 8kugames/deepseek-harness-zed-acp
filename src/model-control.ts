/** Standard ACP session configuration over one Agent's model selection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, errorChain, type LlmCallConfig, type LlmModelReasoningInfo, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const MODEL_CONFIG_ID = 'model'
const REASONING_CONFIG_ID = 'reasoning_effort'
// DSH reasoning effort ids are non-empty, so the empty opaque ACP value is a disjoint provider-default choice.
const PROVIDER_DEFAULT_REASONING_VALUE = ''

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

/**
 * Project and mutate one Agent's provider/model/reasoning selection through ACP
 * config options. A route whose resolution fails after an earlier success
 * degrades to the last resolved state: the model option keeps the selection
 * and the reasoning option is reassembled from the last resolved reasoning
 * metadata for that exact route, with a warning instead of a silent omission.
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

  constructor(
    private readonly llm: LlmRuntime,
    initial: ModelSelection | undefined,
    private readonly warn: (message: string) => void,
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
        const selected = state.choices.get(value)
        if (selected === undefined) throw new AcpModelConfigError(`unknown model option: ${value}`)
        await this.resolveSelection(selected, signal)
        this.selected = selected
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
    const selected = this.selected
    if (selected === undefined) return { choices: new Map(), options: [] }
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
