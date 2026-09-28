// ACP probe: drive dsh --profile zed over stdio and report what Zed would see.
import { spawn } from 'node:child_process'

const proc = spawn('dsh', ['--profile', 'zed'], {
  cwd: '/tmp',
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buf = ''
const pending = new Map()
let nextId = 1

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line === '') continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      } else if (msg.method) {
        console.log('[notify]', msg.method)
      }
    } catch {}
  }
})
proc.stderr.on('data', (c) => process.stderr.write(c))

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const timeout = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))
const race = (p, ms, label) => Promise.race([p, timeout(ms, label)])

try {
  const init = await race(request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'probe', version: '0.0.0' },
  }), 120000, 'initialize')
  console.log('== promptCapabilities ==')
  console.log(JSON.stringify(init.agentCapabilities?.promptCapabilities ?? null))
  console.log('== sessionCapabilities ==')
  console.log(JSON.stringify(init.agentCapabilities?.sessionCapabilities ?? null))

  const created = await race(request('session/new', {
    cwd: '/tmp',
    mcpServers: {},
  }), 120000, 'session/new')
  console.log('== session/new configOptions ==')
  for (const opt of created.configOptions ?? []) {
    console.log(`- id=${opt.id} name=${opt.name} category=${opt.category} type=${opt.type} current=${opt.currentValue}`)
  }
  console.log('== session/new modes ==')
  console.log(JSON.stringify(created.modes ?? null))
  await request('session/close', { sessionId: created.sessionId }).catch(() => {})
} catch (e) {
  console.error('PROBE FAILED:', e.message)
} finally {
  proc.kill()
}
