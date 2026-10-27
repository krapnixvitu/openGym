// src/socket.js: one stdio server per connection on a Unix socket only its own user can open,
// gone again when the connection closes.
import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'socket.js')
let dir, sock, proc

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-sock-'))
  sock = path.join(dir, 'mcp.sock')
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'u1', name: 'Matt' }], creds: [], subs: [], invites: [] }))
  fs.writeFileSync(sock, 'stale')
  proc = spawn(process.execPath, [SRC], { env: { ...process.env, MCP_SOCKET: sock, OPENGYM_DATA: dir, OPENGYM_UID: 'u1', OPENGYM_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise((resolve, reject) => {
    proc.stderr.on('data', d => { if (/listening/.test(d)) resolve() })
    proc.once('exit', code => reject(new Error(`socket.js exited (${code})`)))
  })
}, 20000)
afterAll(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }) })

const ask = msg => new Promise((resolve, reject) => {
  const c = net.connect(sock)
  let buf = ''
  c.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, i))) } })
  c.on('error', reject)
  c.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
})
const init = { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }

test('replaces a stale socket and opens it to its own user only', () => {
  expect(fs.statSync(sock).isSocket()).toBe(true)
  expect(fs.statSync(sock).mode & 0o077).toBe(0)
})

test('each connection gets its own server', async () => {
  const a = await ask(init)
  const b = await ask(init)
  expect(a.result.serverInfo.name).toBe('opengym')
  expect(b.result.serverInfo.name).toBe('opengym')
})
