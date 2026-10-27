// The real api/server.js in a child process, on a temp data directory, for end-to-end tests of
// the write tools: what the server stores when the MCP writes, read back off disk. Needs api/'s
// dependencies (`npm ci` in api/); without them the suites skip on a laptop and fail in CI, as
// log-workout.e2e.test.js does.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'api')
export const HAVE_API = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
if (!HAVE_API && process.env.CI) throw new Error('api/node_modules is missing: run `npm ci` in api/ before the MCP tests in CI')

const UID = 'u_mcp_1'

/** Starts the api on `doc` (a profile document). Resolves { env, stored(), stop() }. */
export async function realApi(doc) {
  const secret = crypto.randomBytes(32).toString('hex')
  const payload = `${UID}:${Date.now() + 86400000}:0`
  const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-e2e-'))
  fs.writeFileSync(path.join(dir, 'secret'), secret, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: UID, name: 'Matt', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }))
  fs.writeFileSync(path.join(dir, `state-${UID}.json`), JSON.stringify(doc))
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' },
  })
  let log = ''
  child.stderr.on('data', d => { log += d })
  const port = await new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error('server never announced a port:\n' + log)), 20000)
    child.stdout.on('data', d => {
      log += d
      const m = /gym-api on :(\d+)/.exec(log)
      if (m) { clearTimeout(give); resolve(+m[1]) }
    })
    child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
  })
  return {
    env: { OPENGYM_URL: `http://127.0.0.1:${port}`, OPENGYM_TOKEN: token },
    stored: () => JSON.parse(fs.readFileSync(path.join(dir, `state-${UID}.json`), 'utf8')),
    stop: () => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}
