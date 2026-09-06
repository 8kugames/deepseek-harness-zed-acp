/**
 * The ACP `preset` config option over one Agent's agent-preset membership:
 * the roster select, the recorded switch through the roster's serialized
 * blank-session contract, and the caller-correctable refusals.
 * @module @deepseek-ai/dsh-acp/preset-control
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'

/** The config option id the preset select advertises. */
export const PRESET_CONFIG_ID = 'preset'

/** Caller-correctable preset selection failure. */
export class AcpPresetConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpPresetConfigError'
  }
}

/**
 * Project and mutate one Agent's preset membership through the ACP `preset`
 * select. Absent whenever the deployment composes no roster: the bridge then
 * advertises no preset option and the host-plane rows serve every session.
 */
export class AcpPresetControl {
  constructor(
    private readonly presets: AgentPresets,
    private readonly agent: Agent,
  ) {}

  /**
   * Build the advertised select from the roster, keeping the composed preset
   * selectable even when its file broke after the session joined it.
   * @returns the config option, or `undefined` while the roster lists nothing.
   */
  async option(): Promise<SessionConfigOption | undefined> {
    const [rows, current] = await Promise.all([
      this.presets.list(),
      Promise.resolve(this.presets.composedPreset(this.agent.ctx)),
    ])
    if (current === undefined && rows.length === 0) return undefined
    const usable = rows.filter(row => row.broken === undefined)
      .map(row => ({
        value: row.id,
        name: row.name ?? row.id,
        ...row.description === undefined ? {} : { description: row.description },
      }))
    if (current !== undefined && !usable.some(option => option.value === current)) {
      // A joined preset whose composition broke since the session mounted it
      // stays honest: it is the current value, and switching away is the fix.
      usable.unshift({ value: current, name: current })
    }
    return {
      id: PRESET_CONFIG_ID,
      name: 'Agent preset',
      type: 'select',
      currentValue: current ?? '',
      options: usable,
    }
  }

  /**
   * Switch the Agent's preset through the roster's serialized switch: refused
   * once the session has produced output, recorded in the session log when it
   * commits.
   * @param value - the selected preset id.
   */
  async set(value: unknown): Promise<void> {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AcpPresetConfigError(`${PRESET_CONFIG_ID} requires a preset id`)
    }
    try {
      await this.presets.select(this.agent, value)
    } catch (error: unknown) {
      if (error instanceof RemoteError) throw new AcpPresetConfigError(error.message)
      throw error
    }
  }
}
