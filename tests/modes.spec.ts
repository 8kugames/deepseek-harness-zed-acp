import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

const AVAILABLE_MODES = [
  { id: 'default', name: 'Default', description: 'Full editing and execution tools.' },
  { id: 'plan', name: 'Plan', description: 'Read-only exploration that ends in a plan for review.' },
]

describe('ACP session modes', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function harnessWithModes(): Promise<BridgeHarness> {
    harness = await makeBridgeHarness({ planMode: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('returns the initial default mode in the session/new response', async () => {
    const bridge = await harnessWithModes()
    const response = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(response.modes).toEqual({ currentModeId: 'default', availableModes: AVAILABLE_MODES })
  })

  it('switches to plan mode, notifies the client, and reports the durable state', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(bridge.client.setSessionMode({ sessionId, modeId: 'plan' })).resolves.toEqual({})
    await vi.waitFor(() => {
      expect(bridge.sessionUpdates.at(-1)).toMatchObject({
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      })
    })

    // The appended plan/mode event is the durable state the projection folds.
    const agent = bridge.ctx.agents.get(SessionId(sessionId))!
    expect(bridge.ctx.planMode.get(agent).active).toBe(true)
  })

  it('switches back to the default mode', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await bridge.client.setSessionMode({ sessionId, modeId: 'plan' })
    await vi.waitFor(() => {
      expect(bridge.sessionUpdates.at(-1)?.update).toMatchObject({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    })

    await bridge.client.setSessionMode({ sessionId, modeId: 'default' })
    await vi.waitFor(() => {
      expect(bridge.sessionUpdates.at(-1)?.update).toMatchObject({ sessionUpdate: 'current_mode_update', currentModeId: 'default' })
    })
  })

  it('rejects unknown mode ids without notifying the client', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(bridge.client.setSessionMode({ sessionId, modeId: 'yolo' })).rejects.toThrow(/unknown mode/)
    expect(bridge.sessionUpdates).toHaveLength(0)
  })

  it('rejects mode changes when the deployment composes no plan-mode service', async () => {
    harness = await makeBridgeHarness({ script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(response.modes).toBeUndefined()
    await expect(harness.client.setSessionMode({ sessionId: response.sessionId, modeId: 'plan' }))
      .rejects.toThrow(/modes are not available/)
  })

  it('serves modes from the preset realm when the host plane composes no plan-mode service', async () => {
    harness = await makeBridgeHarness({ presets: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(response.modes).toEqual({ currentModeId: 'default', availableModes: AVAILABLE_MODES })
  })

  it('switches the preset realm instance in preference to the host plane', async () => {
    harness = await makeBridgeHarness({ presets: true, planMode: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await harness.client.setSessionMode({ sessionId, modeId: 'plan' })
    const realm = harness.presets!.realmPlanModes.get(agent)
    expect(realm?.setCalls).toEqual([true])
    expect(realm?.active).toBe(true)
    // The host controller stays untouched: the session's own composition owns its plan mode.
    expect(harness.ctx.planMode.get(agent).active).toBe(false)
  })

  it('advertises the mode select alongside the legacy mode state', async () => {
    const bridge = await harnessWithModes()
    const response = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    // Clients that render the modern selector read this option; the legacy
    // `modes` field stays for clients that only implement the deprecated path.
    expect(response.configOptions?.find(option => option.id === 'session_mode')).toEqual({
      id: 'session_mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: 'Full editing and execution tools.' },
        { value: 'plan', name: 'Plan', description: 'Read-only exploration that ends in a plan for review.' },
      ],
    })
    expect(response.modes).toEqual({ currentModeId: 'default', availableModes: AVAILABLE_MODES })
  })

  it('resumes with the mode select carrying the restored plan state', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await bridge.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'plan' })
    await vi.waitFor(() => {
      expect(bridge.sessionUpdates.at(-1)?.update).toMatchObject({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    })
    await bridge.client.closeSession({ sessionId })

    const resumed = await bridge.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(resumed.configOptions?.find(option => option.id === 'session_mode'))
      .toMatchObject({ currentValue: 'plan' })
    expect(resumed.modes?.currentModeId).toBe('plan')
  })

  it('switches through the config option and converges with the legacy method', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = bridge.ctx.agents.get(SessionId(sessionId))!

    const switched = await bridge.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'plan' })
    expect(switched.configOptions?.find(option => option.id === 'session_mode'))
      .toMatchObject({ currentValue: 'plan' })
    await vi.waitFor(() => {
      expect(bridge.sessionUpdates.at(-1)).toMatchObject({
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      })
    })
    expect(bridge.ctx.planMode.get(agent).active).toBe(true)

    // The legacy method reads back the state the config option just wrote.
    const back = await bridge.client.setSessionMode({ sessionId, modeId: 'default' })
    expect(back).toEqual({})
    const readBack = await bridge.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'default' })
    expect(readBack.configOptions?.find(option => option.id === 'session_mode'))
      .toMatchObject({ currentValue: 'default' })
  })

  it('routes both mode APIs through the preset realm in preference to the host plane', async () => {
    harness = await makeBridgeHarness({ presets: true, planMode: true, script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    await harness.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'plan' })
    const realm = harness.presets!.realmPlanModes.get(agent)
    expect(realm?.setCalls).toEqual([true])
    expect(harness.ctx.planMode.get(agent).active).toBe(false)
  })

  it('rejects unknown mode values through the config option', async () => {
    const bridge = await harnessWithModes()
    const { sessionId } = await bridge.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(bridge.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'yolo' }))
      .rejects.toThrow(/unknown mode: yolo/)
  })

  it('advertises no mode select without a plan-mode service', async () => {
    harness = await makeBridgeHarness({ script: [] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId, configOptions } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(configOptions?.some(option => option.id === 'session_mode')).toBe(false)
    await expect(harness.client.setSessionConfigOption({ sessionId, configId: 'session_mode', value: 'plan' }))
      .rejects.toThrow(/modes are not available/)
  })
})
