/**
 * The single composition point for the standard ACP configuration state: the
 * option set `session/new` and `session/resume` advertise, in the order
 * clients render it. Adding a selector category means editing this file alone.
 * @module @8kugames/dsh-zed-acp/config-options
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpModelControl } from './model-control.ts'
import type { AcpPermissionControl } from './permission-control.ts'
import type { AcpPresetControl } from './preset-control.ts'
import type { AcpSessionModeControl } from './session-mode-control.ts'

/** The live configuration controls one ACP session composes its options from. */
export interface AcpConfigOptionsSources {
  /** The agent-preset select, absent without a roster. */
  preset: AcpPresetControl | undefined
  /** The permission select, absent without the permission service. */
  permission: AcpPermissionControl | undefined
  /** The Default/Plan session mode, absent without a plan-mode service. */
  mode: AcpSessionModeControl
  /** The model and reasoning-effort selects. */
  model: AcpModelControl
}

/**
 * Assemble the complete standard configuration state in the order clients
 * render it: the agent-preset select, the permission select, the Default/Plan
 * session mode, then the model and reasoning-effort selects. A deployment that
 * composes no service behind a selector advertises nothing for it.
 * @param sources - the session's live configuration controls.
 * @param signal - optional catalog and exact-model cancellation.
 * @returns all current configuration options.
 */
export async function acpConfigOptions(
  sources: AcpConfigOptionsSources,
  signal?: AbortSignal,
): Promise<SessionConfigOption[]> {
  const [preset, mode, model] = await Promise.all([
    sources.preset?.option(),
    sources.mode.option(),
    sources.model.options(signal),
  ])
  const permission = sources.permission?.option()
  return [
    ...(preset === undefined ? [] : [preset]),
    ...(permission === undefined ? [] : [permission]),
    ...(mode === undefined ? [] : [mode]),
    ...model,
  ]
}
