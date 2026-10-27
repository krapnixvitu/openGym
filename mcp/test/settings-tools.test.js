// The settings tools: update against a stand-in for the api (support/stub-api.js), get against a
// data folder, as the read tools are tested.
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubApi } from './support/stub-api.js'
import { updateSettings } from '../src/settings-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const DOC = () => ({ unit: 'kg', restSec: 120, showRir: true, routines: [], workouts: [], _wid: 'w-1' })
const run = params => updateSettings.handler(params, { env: api.env })

describe('update_settings', () => {
  test('written as Settings writes them; only what changed is reported', async () => {
    api = await stubApi(DOC())
    const out = await run({ rest_sec: 120, effort: 'rpe', week_start: 'sunday', weigh_in_before_workout: false, speed_unit: 'mph' })
    expect(out).toMatchObject({ updated: true, changed: { effort: 'rpe', week_start: 'sunday', weigh_in_before_workout: false, speed_unit: 'mph' } })
    expect(out.changed.rest_sec).toBeUndefined()
    expect(api.doc).toMatchObject({ restSec: 120, effort: 'rpe', weekStart: 0, weighIn: false, speedUnit: 'mph' })
    expect('showRir' in api.doc).toBe(false)
  })

  test('nothing named, or nothing different, saves nothing; the unit is not a setting here', async () => {
    api = await stubApi(DOC())
    expect((await run({})).problem).toMatch(/name a setting/)
    expect((await run({ rest_sec: 120 })).updated).toBe(false)
    expect((await run({ unit: 'lb' })).problem).toMatch(/name a setting/)
    expect(api.puts).toHaveLength(0)
  })
})

describe('get_settings', () => {
  const dirs = []
  afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
  afterEach(() => vi.unstubAllEnvs())
  test('each setting as the app reads it, an unset one at its default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-set-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'alex', name: 'Alex' }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dir, 'state-alex.json'), JSON.stringify({ unit: 'lb', restSec: 0, showRir: true }))
    vi.resetModules()
    vi.stubEnv('OPENGYM_DATA', dir)
    vi.stubEnv('OPENGYM_UID', 'alex')
    const { getSettings } = await import('../src/settings-tools.js')
    const out = getSettings.handler({})
    expect(out.unit).toBe('lb')
    expect(out.settings).toMatchObject({ rest_sec: 0, effort: 'rir', week_start: 'monday', speed_unit: 'mph', start_from: 'plan', weigh_in_before_workout: true })
    expect(Object.keys(out.about)).toEqual(Object.keys(out.settings))
  })
})
