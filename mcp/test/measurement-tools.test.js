// The measurement tools: the writes against a stand-in for the api (support/stub-api.js), the read
// against a data folder, as the read tools are tested.
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubApi } from './support/stub-api.js'
import { addMeasurements, deleteMeasurements, addMeasurementField } from '../src/measurement-tools.js'
import { localIso, _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const today = localIso(new Date())
const OCT = { d: '2026-10-01', t: 1000, waist: 84, chest: 100, other: [{ id: 'm1', name: 'Grip', value: 50, unit: 'kg' }] }
const DOC = (unit = 'kg') => ({ unit, measurements: [structuredClone(OCT)], customMeasurements: [{ id: 'm1', name: 'Grip', enabled: true, unit: 'kg' }], measurementEnabled: ['waist', 'chest'], routines: [], workouts: [], _wid: 'w-1' })
const run = (tool, params) => tool.handler(params, { env: api.env })
const day = d => api.doc.measurements.find(e => e.d === d)

describe('add_measurements', () => {
  test('a new check-in, stored in cm and kg, the screen\'s units shown back', async () => {
    api = await stubApi(DOC('lb'))
    const out = await run(addMeasurements, { values: { waist: 33, Grip: 50 } })
    expect(out.values).toEqual({ Waist: '33 in', Grip: '50 kg' })
    const e = day(today)
    expect(e.waist).toBe(83.8)
    expect(e.other[0]).toMatchObject({ id: 'm1', value: 50, unit: 'kg' })
    expect(e.t).toBeGreaterThan(1000)
  })

  test('a day that has a check-in gets the new readings added, and a null clears one', async () => {
    api = await stubApi(DOC())
    await run(addMeasurements, { date: '2026-10-01', values: { hips: 98, chest: null, 'body fat': 18.5 } })
    expect(api.doc.measurements).toHaveLength(1)
    expect(day('2026-10-01')).toMatchObject({ waist: 84, chest: null, hips: 98, bodyFat: 18.5 })
    // switched-off built-ins that now hold a reading are switched on
    expect(api.doc.measurementEnabled).toEqual(['waist', 'chest', 'hips', 'bodyFat'])
  })

  test('unknown fields, readings out of range and future days are problems', async () => {
    api = await stubApi(DOC())
    expect((await run(addMeasurements, { values: { tail: 3 } })).problem).toMatch(/tail/)
    expect((await run(addMeasurements, { values: { 'body fat': 140 } })).problem).toMatch(/Body fat/)
    expect((await run(addMeasurements, { date: '2999-01-01', values: { waist: 80 } })).problem).toMatch(/today/)
    expect(api.puts).toHaveLength(0)
  })

  test('the same readings again save nothing', async () => {
    api = await stubApi(DOC())
    expect((await run(addMeasurements, { date: '2026-10-01', values: { waist: 84 } })).updated).toBe(false)
    expect(api.puts).toHaveLength(0)
  })
})

describe('delete_measurements and add_measurement_field', () => {
  test('a day deleted; a field added in its unit, a name taken refused', async () => {
    api = await stubApi(DOC())
    await run(deleteMeasurements, { date: '2026-10-01' })
    expect(api.doc.measurements).toEqual([])
    expect((await run(deleteMeasurements, { date: '2026-10-01' })).problem).toMatch(/no measurements/)
    const out = await run(addMeasurementField, { name: 'Muscle ratio', unit: '%' })
    expect(out).toMatchObject({ created: true, unit: '%' })
    expect(api.doc.customMeasurements[1]).toMatchObject({ name: 'Muscle ratio', unit: '%', enabled: true })
    expect((await run(addMeasurementField, { name: 'waist' })).problem).toMatch(/already/)
    await run(addMeasurements, { values: { 'Muscle ratio': 42 } })
    expect(day(today).other.find(o => o.name === 'Muscle ratio')).toMatchObject({ value: 42, unit: '%' })
  })
})

describe('get_measurements', () => {
  const dirs = []
  afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
  afterEach(() => vi.unstubAllEnvs())
  test('check-ins newest first in the screen\'s units, one field\'s history, what is tracked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-meas-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'alex', name: 'Alex' }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dir, 'state-alex.json'), JSON.stringify({ ...DOC('lb'), measurements: [OCT, { d: '2026-10-08', t: 2000, waist: 83 }] }))
    vi.resetModules()
    vi.stubEnv('OPENGYM_DATA', dir)
    vi.stubEnv('OPENGYM_UID', 'alex')
    const { getMeasurements } = await import('../src/measurement-tools.js')
    const all = getMeasurements.handler({})
    expect(all.check_ins.map(c => c.date)).toEqual(['2026-10-08', '2026-10-01'])
    expect(all.check_ins[1].values).toEqual({ Chest: '39.4 in', Waist: '33.1 in', Grip: '50 kg' })
    expect(all.tracked.map(f => f.name)).toEqual(['Chest', 'Waist', 'Grip'])
    expect(getMeasurements.handler({ field: 'grip' }).check_ins).toEqual([{ date: '2026-10-01', values: { Grip: '50 kg' } }])
  })
})
