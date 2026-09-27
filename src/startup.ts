/**
 * The Zed ACP profile's command-line and stdin-lifetime provider. A successful
 * parse publishes {@link ZED_ACP_STARTUP_SERVICE}; the ACP bridge waits for
 * that service, so help starts no transport.
 * @module @8kugames/dsh-zed-acp/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'zed-acp-startup'

/** Launcher service required before this app can parse its invocation. */
export const inject = ['cmdlineArgs']

/** Service the ACP bridge row waits for before claiming stdio. */
export const ZED_ACP_STARTUP_SERVICE = 'zedAcpStartup'

/**
 * Build this app's zero-option command and help.
 * @returns a fresh program for one invocation.
 */
function zedAcpCommand(): Command {
  return new Command()
    .name('dsh --profile zed')
    .description('Serve Zed and other interactive clients over Agent Client Protocol stdio.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile zed     serve ACP until the client disconnects
`)
}

/**
 * Accept a Zed ACP profile invocation, publish readiness, and bind EOF to the
 * launcher's bounded shutdown.
 * @param ctx - plugin context carrying command-line and exit launcher values.
 */
export function apply(ctx: Context): void {
  const program = zedAcpCommand()
  program.action(() => {
    exitOnStdinEnd(ctx, 'zed-acp.stdin')
    ctx.provide(ZED_ACP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
