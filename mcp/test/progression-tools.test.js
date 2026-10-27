// set_progression against a stand-in for the api (support/stub-api.js).
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { stubApi } from './support/stub-api.js'
import { setProgression } from '../src/progression-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const DOC = () => ({ unit: 'kg', routines: [
  { id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }, { id: '0294', sets: 3, reps: 12, mode: 'reps', pyramid: [12, 10, 8] }] },
  { id: 'r2', name: 'Push B', prog: 'greyskull', ex: [{ id: '0025', sets: 3, reps: 8, weight: 80, mode: 'reps', prog: 'linear' }, { id: '0463', sets: 3, sec: 45, mode: 'time' }] },
], workouts: [], _wid: 'w-1' })
const run = params => setProgression.handler(params, { env: api.env })
const ex = (rid, i) => api.doc.routines.find(r => r.id === rid).ex[i]

describe('set_progression', () => {
  test('a routine\'s rule, and back to the default', async () => {
    api = await stubApi(DOC())
    const out = await run({ routine_id: 'r1', rule: 'double' })
    expect(out).toMatchObject({ updated: true, rule: 'double', rule_name: 'Double progression' })
    expect(api.doc.routines[0].prog).toBe('double')
    await run({ routine_id: 'r2', rule: null })
    expect('prog' in api.doc.routines[1]).toBe(false)
  })

  test('one exercise in every routine: rule, step and deload factor', async () => {
    api = await stubApi(DOC())
    const out = await run({ exercise: '0025', rule: 'double', increment: 5, deload_factor: 0.85 })
    expect(out.slots.map(s => s.routine)).toEqual(['Push', 'Push B'])
    for (const [rid] of [['r1'], ['r2']]) expect(ex(rid, 0)).toMatchObject({ prog: 'double', inc: 5, deloadFactor: 0.85 })
    // the default factor is left out, as the config sheet leaves it out
    await run({ exercise: '0025', routine_id: 'r1', deload_factor: 0.9, rule: null })
    expect(ex('r1', 0)).toEqual({ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps', inc: 5 })
    expect(ex('r2', 0).prog).toBe('double')
  })

  test('a rule the exercise cannot take is a problem; a pyramid is skipped and said so', async () => {
    api = await stubApi(DOC())
    expect((await run({ exercise: '0463', rule: 'linear' })).problem).toMatch(/takes off, time/)
    expect(api.puts).toHaveLength(0)
    const out = await run({ exercise: '0294', rule: 'linear' })
    expect(out.updated).toBe(false)
    expect(out.skipped[0].why).toMatch(/pyramid/)
  })

  test('an exercise not in the routine, or nothing to set, saves nothing', async () => {
    api = await stubApi(DOC())
    expect((await run({ exercise: '0463', routine_id: 'r1', rule: 'time' })).problem).toMatch(/in that routine/)
    expect((await run({ routine_id: 'r1' })).problem).toMatch(/give a rule/)
    expect((await run({ routine_id: 'r1', increment: 5 })).problem).toMatch(/name it/)
    expect(api.puts).toHaveLength(0)
  })
})
