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
})
