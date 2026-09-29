import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AcpModelControl, createReasoningPreferenceStore, type ReasoningPreferenceStore } from '../src/model-control.ts'

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

describe('reasoning-effort stickiness and persistence', () => {
  const ROUTE_A = '["mock","a"]'
  const ROUTE_B = '["mock","b"]'

  /** Multi-model catalog override: per-model effort ids and optional default. */
  function catalog(models: Record<string, { efforts: string[]; defaultEffort?: string }>): Partial<LlmRuntime> {
    return {
      listModels: () => Promise.resolve(Object.keys(models).map(id => ({ provider: 'mock', id, name: id }))),
      resolveModelInfo: (provider: string, model: string) => {
        const entry = models[model]
        if (entry === undefined) return Promise.reject(new Error(`unknown model ${model}`))
        return Promise.resolve({
          provider,
          id: model,
          name: model,
          reasoning: {
            efforts: entry.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
            ...entry.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(entry.defaultEffort) },
          },
        })
      },
      resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
        provider: selection.provider ?? 'a',
        model: selection.model ?? 'a',
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      }),
    }
  }

  /** In-memory preference store double exposing its data for assertions. */
  function memoryStore(entries: Record<string, string> = {}): ReasoningPreferenceStore & { data: Map<string, string> } {
    const data = new Map(Object.entries(entries))
    return {
      data,
      load: () => Promise.resolve(data.entries()),
      update: (routeValue, effort) => {
        if (effort === undefined) data.delete(routeValue)
        else data.set(routeValue, effort)
        return Promise.resolve()
      },
    }
  }

  it('keeps a surviving effort id across model switches', async () => {
    const control = new AcpModelControl(
      llmRuntime(catalog({
        a: { efforts: ['low', 'high'], defaultEffort: 'high' },
        b: { efforts: ['low', 'high'], defaultEffort: 'high' },
      })),
      { provider: 'mock', model: 'a' },
      vi.fn(),
    )
    await control.set('reasoning_effort', 'low')

    const switched = await control.set('model', ROUTE_B)

    expect(switched.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
  })

  it('falls back to the target default when the id does not survive, and restores route memory on return', async () => {
    const control = new AcpModelControl(
      llmRuntime(catalog({
        a: { efforts: ['low', 'high'], defaultEffort: 'high' },
        b: { efforts: ['medium'], defaultEffort: 'medium' },
      })),
      { provider: 'mock', model: 'a' },
      vi.fn(),
    )
    await control.set('reasoning_effort', 'low')

    const onB = await control.set('model', ROUTE_B)
    expect(onB.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'medium' })

    const backOnA = await control.set('model', ROUTE_A)
    expect(backOnA.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
  })

  it('drops the carry-over instead of failing the switch when the support probe fails once', async () => {
    const probes = new Map<string, number>()
    const resolveModelInfo = (provider: string, model: string) => {
      const seen = (probes.get(model) ?? 0) + 1
      probes.set(model, seen)
      // The target route's first probe fails, modeling a transient catalog
      // hiccup; later calls succeed, so the route-validating resolve below
      // still passes and the switch must complete on the target default.
      if (model === 'b' && seen === 1) return Promise.reject(new Error('catalog hiccup'))
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('high'),
        },
      })
    }
    const control = new AcpModelControl(
      llmRuntime({ ...catalog({ a: { efforts: ['low', 'high'] }, b: { efforts: ['low', 'high'] } }), resolveModelInfo }),
      { provider: 'mock', model: 'a' },
      vi.fn(),
    )
    await control.set('reasoning_effort', 'low')

    const switched = await control.set('model', ROUTE_B)

    expect(switched.find(option => option.id === 'model')).toMatchObject({ currentValue: ROUTE_B })
    expect(switched.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'high' })
  })

  it('seeds a fresh session from the persisted store over adapter defaults', async () => {
    const control = new AcpModelControl(
      llmRuntime(catalog({ a: { efforts: ['low', 'high'], defaultEffort: 'high' } })),
      { provider: 'mock', model: 'a' },
      vi.fn(),
      memoryStore({ [ROUTE_A]: 'low' }),
    )

    const options = await control.options()

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
  })

  it('records explicit choices and deletes the entry when clearing to provider default', async () => {
    const store = memoryStore()
    const control = new AcpModelControl(
      llmRuntime(catalog({ a: { efforts: ['low', 'high'] } })),
      { provider: 'mock', model: 'a' },
      vi.fn(),
      store,
    )

    await control.set('reasoning_effort', 'low')
    expect(store.data.get(ROUTE_A)).toBe('low')

    await control.set('reasoning_effort', '')
    expect(store.data.has(ROUTE_A)).toBe(false)
  })

  it('warns and continues from adapter defaults when the persisted seed fails', async () => {
    const warn = vi.fn()
    const control = new AcpModelControl(
      llmRuntime(catalog({ a: { efforts: ['low', 'high'], defaultEffort: 'high' } })),
      { provider: 'mock', model: 'a' },
      warn,
      { load: () => Promise.reject(new Error('disk gone')), update: () => Promise.resolve() },
    )

    const options = await control.options()

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'high' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reasoning preference seed failed/))
  })

  it('keeps the in-session choice when the write-through fails', async () => {
    const warn = vi.fn()
    const control = new AcpModelControl(
      llmRuntime(catalog({ a: { efforts: ['low', 'high'], defaultEffort: 'high' } })),
      { provider: 'mock', model: 'a' },
      warn,
      { load: () => Promise.resolve([]), update: () => Promise.reject(new Error('disk full')) },
    )

    const options = await control.set('reasoning_effort', 'low')

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reasoning preference persist failed/))
  })

  it('round-trips the file-backed preference store and rejects corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pref-'))
    try {
      const path = join(dir, 'prefs.json')
      const store = createReasoningPreferenceStore(path)
      expect([...await store.load()]).toEqual([])

      await store.update('["p","m"]', 'high')
      expect([...await store.load()]).toEqual([['["p","m"]', 'high']])

      await store.update('["p","m"]', undefined)
      expect([...await store.load()]).toEqual([])

      await writeFile(path, '{ not json', 'utf8')
      await expect(store.load()).rejects.toThrow(/invalid JSON/)
      await writeFile(path, JSON.stringify({ version: 2, efforts: {} }), 'utf8')
      await expect(store.load()).rejects.toThrow(/invalid shape/)
      await writeFile(path, JSON.stringify({ version: 1, efforts: ['x'] }), 'utf8')
      await expect(store.load()).rejects.toThrow(/invalid shape/)
      await writeFile(path, JSON.stringify({ version: 1, efforts: { route: 7 } }), 'utf8')
      await expect(store.load()).rejects.toThrow(/invalid reasoning preference entry/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rebuilds a corrupt preference file from the triggering update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pref-'))
    try {
      const path = join(dir, 'prefs.json')
      await writeFile(path, '{ not json', 'utf8')
      const store = createReasoningPreferenceStore(path)

      await store.update('["p","m"]', 'high')

      expect([...await store.load()]).toEqual([['["p","m"]', 'high']])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
