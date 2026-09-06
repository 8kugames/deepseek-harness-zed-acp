/** In-memory ACP transport fixture over the real agent factory and loop. */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  type Agent as AcpAgent,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { type GenerateOptions, LlmAdapter, ReasoningEffortId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-presets/types'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import * as AcpPlugin from '../src/index.ts'
import type { AcpConfig } from '../src/index.ts'

/** Scripted adapter for protocol tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly imageCapable: boolean,
    private readonly provider = 'mock',
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== this.provider) throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: this.provider, name: this.provider === 'mock' ? 'Mock' : `Mock ${this.provider}` }
  }

  override listModels(provider: string) {
    return Promise.resolve(provider === this.provider ? [
      {
        provider: this.provider,
        id: 'mock',
        name: 'Mock Reasoner',
        description: 'Mock model with selectable reasoning.',
        inputModalities: this.imageCapable ? ['text', 'image'] as const : ['text'] as const,
      },
      {
        provider: this.provider,
        id: 'plain',
        name: 'Mock Plain',
        inputModalities: ['text'] as const,
      },
    ] : [])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: this.imageCapable && model === 'mock' ? ['text', 'image'] : ['text'],
      context: { contextWindow: 1_024 },
      ...model === 'mock' ? {
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      } : {},
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/**
 * Minimal roster stand-in: one fixed two-preset roster with the mount, select,
 * and recorded-composition reads the bridge consumes. Single-current, because
 * the bridge wiring tests drive one session at a time.
 */
export class StubAgentPresets {
  static readonly USABLE = ['standard', 'minimal']

  current: string | undefined = 'standard'
  /** The id `resolve()` falls back to; the real roster reads this from config. */
  default = 'standard'
  readonly mounted: (string | undefined)[] = []
  readonly selected: string[] = []
  /** When set, the next `select` rejects with this failure. */
  selectFailure: RemoteError | undefined
  /** Per-agent plan-mode state, standing in for the preset realm's controller. */
  readonly realmPlanModes = new Map<unknown, StubRealmPlanMode>()

  private row(id: string, extra: Partial<AgentPresetRow> = {}): AgentPresetRow {
    return { id, trust: 'system', isDefault: id === 'standard', ...extra }
  }

  async resolve(id?: string): Promise<AgentPresetRow> {
    if (id !== undefined && !StubAgentPresets.USABLE.includes(id)) {
      throw new RemoteError('agent-preset/not-found', `preset "${id}" not found`, { agentPreset: id, available: StubAgentPresets.USABLE })
    }
    return this.row(id ?? this.default)
  }

  async mount(_agentCtx: unknown, id?: string): Promise<AgentPresetRow> {
    const preset = await this.resolve(id)
    this.mounted.push(preset.id)
    this.current = preset.id
    return preset
  }

  composedPreset(): string | undefined {
    return this.current
  }

  /**
   * The per-agent realm read the real roster serves from the preset's
   * entry-local isolate: the mounted composition's own plan-mode instance,
   * invisible to the agent's scope context.
   */
  serviceFor(agent: unknown, name: string): StubRealmPlanMode | undefined {
    if (name !== 'planMode') return undefined
    let state = this.realmPlanModes.get(agent)
    if (state === undefined) {
      state = new StubRealmPlanMode()
      this.realmPlanModes.set(agent, state)
    }
    return state
  }

  async list(): Promise<AgentPresetRow[]> {
    return [
      this.row('standard', { name: 'Standard' }),
      this.row('minimal', { name: 'Minimal', description: 'Two tools' }),
      this.row('broken', { broken: 'composition failed' }),
    ]
  }

  async select(_agent: unknown, id: string): Promise<string> {
    if (this.selectFailure !== undefined) throw this.selectFailure
    if (!StubAgentPresets.USABLE.includes(id)) {
      throw new RemoteError('agent-preset/not-found', `preset "${id}" not found`, { agentPreset: id, available: StubAgentPresets.USABLE })
    }
    this.selected.push(id)
    this.current = id
    return id
  }
}

/**
 * Minimal plan-mode stand-in for the preset realm: the same get/set surface
 * the bridge consumes, tracked per agent by {@link StubAgentPresets.serviceFor}.
 */
export class StubRealmPlanMode {
  active = false
  readonly setCalls: boolean[] = []

  get(): { active: boolean } {
    return { active: this.active }
  }

  set(_agent: unknown, active: boolean): void {
    this.active = active
    this.setCalls.push(active)
  }
}

/**
 * Minimal permission-preset stand-in: the shipped three-preset table with a
 * per-session current value, mirroring the composed workspace-write default.
 */
export class StubPermissionPresets {
  static readonly TABLE = ['read-only', 'workspace-write', 'danger-full-access']

  private readonly currentBySession = new Map<unknown, string>()

  current(session: unknown): string {
    return this.currentBySession.get(session) ?? 'workspace-write'
  }

  get names(): readonly string[] {
    return StubPermissionPresets.TABLE
  }

  optionOf(name: string): { value: string; name: string; description?: string } {
    const descriptions: Record<string, string> = {
      'read-only': 'Read-only inspection.',
      'workspace-write': 'Write inside the workspace.',
      'danger-full-access': 'Full access without approval prompts.',
    }
    const known = StubPermissionPresets.TABLE.includes(name)
    return {
      value: name,
      name,
      ...descriptions[name] === undefined ? { description: 'Current settings match no preset.' } : { description: descriptions[name] },
      ...known ? {} : { name: 'Custom' },
    }
  }

  set(session: unknown, name: string): void {
    if (!StubPermissionPresets.TABLE.includes(name)) {
      throw new Error(`permission: unknown preset "${name}" (known: ${StubPermissionPresets.TABLE.join(', ')})`)
    }
    this.currentBySession.set(session, name)
  }
}

/** The stub cast the bridge consumes; service typing stays on the real class. */
export interface BridgeHarnessPresets {
  /** The stub's membership state, for assertions. */
  readonly stub: StubAgentPresets
}

/** In-memory durable store for ACP wire-order and lifecycle tests. */
class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []
  readonly objects = new Map<string, StoredImageAttachment>()
  beforeValidate: (() => Promise<void>) | undefined
  beforeRead: (() => Promise<void>) | undefined

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.beforeValidate?.()
    if (input.data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${digest}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.objects.set(ref.attachmentId, { ref, data: Uint8Array.from(input.data) })
    return Promise.resolve(ref)
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    await this.beforeRead?.()
    const stored = this.objects.get(ref.attachmentId)
    if (stored === undefined) throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    return { ref: stored.ref, data: Uint8Array.from(stored.data) }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response ending at the output-token ceiling. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

export type CapturedUpdate = SessionNotification['update']

/** Stable-v1 client methods exercised by the bridge tests. */
interface BridgeClient {
  initialize: NonNullable<AcpAgent['initialize']>
  authenticate: NonNullable<AcpAgent['authenticate']>
  newSession: NonNullable<AcpAgent['newSession']>
  listSessions: NonNullable<AcpAgent['listSessions']>
  resumeSession: NonNullable<AcpAgent['resumeSession']>
  closeSession: NonNullable<AcpAgent['closeSession']>
  setSessionConfigOption: NonNullable<AcpAgent['setSessionConfigOption']>
  setSessionMode: NonNullable<AcpAgent['setSessionMode']>
  prompt: (params: PromptRequest, options?: SendRequestOptions) => Promise<PromptResponse>
  cancel: NonNullable<AcpAgent['cancel']>
}

export interface BridgeHarness {
  ctx: Context
  client: BridgeClient
  adapter: MockAdapter
  attachments: MemoryAttachmentStore | undefined
  updates: CapturedUpdate[]
  sessionUpdates: { sessionId: string; update: CapturedUpdate }[]
  /** The mounted stub roster; undefined unless the harness option mounted one. */
  presets: StubAgentPresets | undefined
  /** The mounted stub permission service; undefined unless the option mounted one. */
  permissions: StubPermissionPresets | undefined
  permissionRequests: RequestPermissionRequest[]
  persistenceRoot: string
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onSessionUpdateError: (() => void) | undefined
  registerCatalogProvider: (provider: string) => () => void
  replacePrimaryProviders: (providers: string[]) => void
  closeClientTransport: () => Promise<void>
  abortClientTransport: () => Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  /** The AgentLoop fiber, so a test can reload the loop out from under the bridge. */
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

type AcpConfigOverrides = { [K in keyof AcpConfig]?: AcpConfig[K] | undefined }

/** Build the bridge and a connected SDK client over cross-wired byte streams. */
export async function makeBridgeHarness(options: {
  script?: (StreamChunk[] | 'hang')[]
  config?: AcpConfigOverrides
  persona?: string
  imageCapable?: boolean
  attachments?: boolean
  persistenceRoot?: string
  /** Mount the plan-mode service, as the shipped dsh-base bundle does. */
  planMode?: boolean
  /** Mount the user-questions service, as the shipped dsh-base bundle does. */
  userQuestions?: boolean
  /** Mount the stub preset roster, as the shipped acp bundle does. */
  presets?: boolean
  /** Mount the stub permission-preset service, as the shipped dsh-base bundle does. */
  permissions?: boolean
} = {}): Promise<BridgeHarness> {
  const adapter = new MockAdapter(options.script ?? [], options.imageCapable === true)
  const ctx = new Context()
  const ownsPersistenceRoot = options.persistenceRoot === undefined
  const persistenceRoot = options.persistenceRoot ?? await mkdtemp(join(tmpdir(), 'dsh-acp-test-'))
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: options.persona ?? '' } })
  // The agent loop and the composed approval/permission services declare
  // sessionProjections a required injection: mount the registry (and with it
  // the loop's turnBoundary unit) before the loop activates.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(TokenMeter)
  if (options.attachments !== false) await ctx.plugin(MemoryAttachmentStore)
  if (options.planMode === true) {
    await ctx.plugin(PlanModeController, { section: 'Test plan guidance: stay in plan mode.' })
  }
  if (options.userQuestions === true) await ctx.plugin(UserQuestionService)
  const stubPresets = options.presets === true ? new StubAgentPresets() : undefined
  if (stubPresets !== undefined) {
    ctx.provide('agentPresets', stubPresets as never)
    // The real roster registers this projection on activation; the stub cannot.
    ctx.sessionProjections.register(agentPresetProjectionDefinition)
  }
  const stubPermissions = options.permissions === true ? new StubPermissionPresets() : undefined
  if (stubPermissions !== undefined) ctx.provide('permissionPresets', stubPermissions as unknown as PermissionPresetService)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const primaryAdapter = ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)

  const updates: CapturedUpdate[] = []
  const sessionUpdates: { sessionId: string; update: CapturedUpdate }[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    attachments: ctx.get('attachments') as MemoryAttachmentStore | undefined,
    updates,
    sessionUpdates,
    permissionRequests,
    presets: stubPresets,
    permissions: stubPermissions,
    persistenceRoot,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    onSessionUpdateError: undefined,
    registerCatalogProvider: provider => ctx.llm.registerAdapter([provider], new MockAdapter([], false, provider)),
    replacePrimaryProviders: (providers) => { primaryAdapter.replace(providers) },
    client: undefined as unknown as BridgeClient,
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    closeClientTransport: async () => { await clientToAgentWriter.close() },
    abortClientTransport: async () => { await clientToAgentWriter.abort(new Error('client transport failed')) },
    dispose: async () => {
      await ctx.fiber.dispose()
      if (ownsPersistenceRoot) await rm(persistenceRoot, { recursive: true, force: true })
    },
  }

  const clientApp = createAcpClientApp({ name: 'dsh-acp-test-client' })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update)
      sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    })

  const config = { stream: agentStream, ...options.config } as AcpConfig
  if (!(options.config && 'provider' in options.config)) config.provider = 'mock'
  if (!(options.config && 'model' in options.config)) config.model = 'mock'
  harness.acpFiber = await ctx.plugin({
    name: 'acp-test',
    inject: [...AcpPlugin.inject],
    apply: (inner: Context) => { AcpPlugin.apply(inner, config) },
  })
  const clientConnection = clientApp.connect(clientStream)
  const client = clientConnection.agent
  harness.client = {
    initialize: params => client.request(methods.agent.initialize, params),
    authenticate: params => client.request(methods.agent.authenticate, params),
    newSession: params => client.request(methods.agent.session.new, params),
    listSessions: params => client.request(methods.agent.session.list, params),
    resumeSession: params => client.request(methods.agent.session.resume, params),
    closeSession: params => client.request(methods.agent.session.close, params),
    setSessionConfigOption: params => client.request(methods.agent.session.setConfigOption, params),
    setSessionMode: params => client.request(methods.agent.session.setMode, params),
    prompt: (params, options) => client.request(methods.agent.session.prompt, params, options),
    cancel: params => client.notify(methods.agent.session.cancel, params),
  }
  return harness
}
