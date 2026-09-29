import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpModelControl } from '../src/model-control.ts'

/** Minimal LLM catalog/runtime double for pure standard-option tests. */
function llmRuntime(overrides: Partial<LlmRuntime> = {}): LlmRuntime {
  return {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels: () => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]),
    resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? { reasoningEffort: ReasoningEffortId('high') }
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low', description: 'Less thought.' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }),
    ...overrides,
  } as unknown as LlmRuntime
}

describe('ACP model configuration control', () => {
  it('represents an absent route and validates value types before mutation', async () => {
    const control = new AcpModelControl(llmRuntime(), undefined, vi.fn())

    expect(control.snapshot()).toBeUndefined()
    await expect(control.options()).resolves.toEqual([])
    await expect(control.set('model', false)).rejects.toThrow(/requires a select value/)
    await expect(control.set('model', 'missing')).rejects.toThrow(/no model selection/)

    control.selection.current = { provider: 'mock', model: 'mock' }
    expect(control.selection.current).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('synthesizes an unlisted current route and exposes reasoning descriptions', async () => {
    const control = new AcpModelControl(llmRuntime({ listProviders: () => [] }), {
      provider: 'private',
      model: 'unlisted',
    }, vi.fn())

    const options = await control.options()

    const model = options.find(option => option.id === 'model')
    const reasoning = options.find(option => option.id === 'reasoning_effort')
    expect(model).toMatchObject({
      type: 'select',
      currentValue: '["private","unlisted"]',
      options: [{ group: 'private', name: 'private', options: [{ name: 'unlisted' }] }],
    })
    expect(reasoning).toMatchObject({
      type: 'select',
      currentValue: 'high',
      options: [{ name: 'Low', description: 'Less thought.' }, { name: 'High' }],
    })

    control.pinTurn(3, { provider: 'turn', model: 'pinned' })
    expect(control.selection.current).toEqual({ provider: 'turn', model: 'pinned' })
    control.releaseTurn(2)
    expect(control.selection.current).toEqual({ provider: 'turn', model: 'pinned' })
    control.releaseTurn(3)
    expect(control.selection.current).toEqual({ provider: 'private', model: 'unlisted' })
  })

  it('keeps the selected route when its provider catalog is temporarily unavailable', async () => {
    const listModels = vi.fn(() => Promise.reject(new Error('catalog unavailable')))
    const control = new AcpModelControl(llmRuntime({ listModels }), { provider: 'mock', model: 'mock' }, vi.fn())

    const options = await control.options()

    expect(listModels).toHaveBeenCalledWith('mock')
    expect(options[0]).toMatchObject({
      type: 'select',
      options: [{ group: 'mock', options: [{ name: 'mock' }] }],
    })
  })

  it('rejects an unadvertised reasoning effort and accepts a later valid change', async () => {
    const control = new AcpModelControl(llmRuntime(), { provider: 'mock', model: 'mock' }, vi.fn())

    await expect(control.set('reasoning_effort', 'extreme')).rejects.toThrow(/unknown reasoning effort/)
    const options = await control.set('reasoning_effort', 'low')

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
  })

  it('exposes and restores a provider-owned reasoning default', async () => {
    const runtime = llmRuntime({
      resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
        provider: selection.provider ?? 'mock',
        model: selection.model ?? 'mock',
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      }),
      resolveModelInfo: (provider: string, model: string) => Promise.resolve({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
        },
      }),
    })
    const control = new AcpModelControl(runtime, { provider: 'mock', model: 'mock' }, vi.fn())

    const initial = await control.options()
    expect(initial.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: '',
      options: [{ value: '', name: 'Provider default' }, { value: 'low' }, { value: 'high' }],
    })
    await control.set('reasoning_effort', 'low')
    const restored = await control.set('reasoning_effort', '')

    expect(restored.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: '' })
    expect(control.selection.current).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('reassembles the reasoning option from the last resolved route when resolution degrades', async () => {
    let failResolve = false
    const resolveCallConfig = vi.fn((selection: { provider?: string; model?: string; reasoningEffort?: string }) => {
      if (failResolve) return Promise.reject(new Error('route resolve failed'))
      return Promise.resolve({
        provider: selection.provider ?? 'mock',
        model: selection.model ?? 'mock',
        ...selection.reasoningEffort === undefined
          ? { reasoningEffort: ReasoningEffortId('high') }
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      })
    })
    const warn = vi.fn()
    const control = new AcpModelControl(llmRuntime({ resolveCallConfig }), { provider: 'mock', model: 'mock' }, warn)

    const before = await control.options()
    expect(before.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'high' })

    // A transient resolve failure after a prior success must not silently
    // unpublish the selector: it degrades to the cached route metadata and
    // materializes the cached default effort as the current value.
    failResolve = true
    const after = await control.options()
    expect(after.find(option => option.id === 'model')).toMatchObject({ currentValue: '["mock","mock"]' })
    expect(after.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: 'high',
      options: [{ name: 'Low', description: 'Less thought.' }, { name: 'High' }],
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mock/mock'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('route resolve failed'))
  })

  it('keeps the user-selected effort as the degraded current value', async () => {
    let failResolve = false
    const resolveCallConfig = vi.fn((selection: { provider?: string; model?: string; reasoningEffort?: string }) => {
      if (failResolve) return Promise.reject(new Error('route resolve failed'))
      return Promise.resolve({
        provider: selection.provider ?? 'mock',
        model: selection.model ?? 'mock',
        ...selection.reasoningEffort === undefined
          ? { reasoningEffort: ReasoningEffortId('high') }
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      })
    })
    const control = new AcpModelControl(llmRuntime({ resolveCallConfig }), { provider: 'mock', model: 'mock' }, vi.fn())
    await control.options()
    await control.set('reasoning_effort', 'low')

    failResolve = true
    const degraded = await control.options()

    expect(degraded.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
  })

  it('serves Provider default on degradation when the cached route declares no default effort', async () => {
    let failResolve = false
    const runtime = llmRuntime({
      resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => {
        if (failResolve) return Promise.reject(new Error('route resolve failed'))
        return Promise.resolve({ provider: selection.provider ?? 'mock', model: selection.model ?? 'mock' })
      },
      resolveModelInfo: (provider: string, model: string) => Promise.resolve({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
        },
      }),
    })
    const control = new AcpModelControl(runtime, { provider: 'mock', model: 'mock' }, vi.fn())
    await control.options()

    failResolve = true
    const degraded = await control.options()

    expect(degraded.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: '',
      options: [{ value: '', name: 'Provider default' }, { value: 'low' }, { value: 'high' }],
    })
  })

  it('fails loudly when the route never resolved at least once', async () => {
    const control = new AcpModelControl(
      llmRuntime({ resolveCallConfig: () => Promise.reject(new Error('first resolve failed')) }),
      { provider: 'mock', model: 'mock' },
      vi.fn(),
    )

    await expect(control.options()).rejects.toThrow(/first resolve failed/)
  })

  it('omits the reasoning option when a successful resolve reports no reasoning', async () => {
    const control = new AcpModelControl(
      llmRuntime({ resolveModelInfo: (provider: string, model: string) => Promise.resolve({ provider, id: model, name: model }) }),
      { provider: 'mock', model: 'mock' },
      vi.fn(),
    )

    const options = await control.options()

    expect(options.find(option => option.id === 'reasoning_effort')).toBeUndefined()
  })

  it('drops stale cached reasoning once a successful resolve reports none', async () => {
    let withReasoning = true
    const resolveModelInfo = vi.fn((provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      ...withReasoning ? {
        reasoning: {
          efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {},
    }))
    let failResolve = false
    const resolveCallConfig = vi.fn((selection: { provider?: string; model?: string }) => {
      if (failResolve) return Promise.reject(new Error('route resolve failed'))
      return Promise.resolve({ provider: selection.provider ?? 'mock', model: selection.model ?? 'mock' })
    })
    const control = new AcpModelControl(
      llmRuntime({ resolveModelInfo, resolveCallConfig }),
      { provider: 'mock', model: 'mock' },
      vi.fn(),
    )
    await control.options()

    // The latest successful answer wins: once the route resolves without
    // reasoning, a later degradation must not resurrect the stale metadata.
    withReasoning = false
    await control.options()
    failResolve = true
    const degraded = await control.options()

    expect(degraded.find(option => option.id === 'reasoning_effort')).toBeUndefined()
  })
})
