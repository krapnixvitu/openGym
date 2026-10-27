// The body-weight tools against a stand-in for the api (support/stub-api.js).
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { stubApi } from './support/stub-api.js'
import { addBodyweight, deleteBodyweight, setGoalWeight, setWeeklyRateGoal } from '../src/body-tools.js'
import { localIso, _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const DOC = () => ({ unit: 'kg', bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }], targetW: null, workouts: [], _wid: 'w-1' })
const today = () => localIso(new Date())
const run = (tool, params) => tool.handler(params, { env: api.env })

describe('add_bodyweight', () => {
  test('today by default, kept in date order', async () => {
    api = await stubApi(DOC())
    const out = await run(addBodyweight, { weight: 79.46 })
    expect(out).toMatchObject({ logged: true, date: today(), weight: 79.5, unit: 'kg' })
    expect(api.doc.bodyweight.map(b => b.d)).toEqual(['2026-10-01', today()])
  })

  test('a second one today replaces the first', async () => {
    api = await stubApi(DOC())
    await run(addBodyweight, { weight: 80 })
    const out = await run(addBodyweight, { weight: 79 })
    expect(out.replaced).toBe(true)
    expect(api.doc.bodyweight.filter(b => b.d === today())).toEqual([expect.objectContaining({ w: 79 })])
  })

  test('an earlier day that has one is only replaced when asked', async () => {
    api = await stubApi(DOC())
    const out = await run(addBodyweight, { weight: 81, date: '2026-10-01' })
    expect(out.logged).toBe(false)
    expect(out.problem).toMatch(/replace: true/)
    await run(addBodyweight, { weight: 81, date: '2026-10-01', replace: true })
    expect(api.doc.bodyweight[0].w).toBe(81)
  })

  test('pounds into a kg profile, to the tenth', async () => {
    api = await stubApi(DOC())
    await run(addBodyweight, { weight: 176, unit: 'lb', date: '2026-10-02' })
    expect(api.doc.bodyweight[1]).toMatchObject({ d: '2026-10-02', w: 79.8 })
  })

  test('the future and an impossible weight are refused', async () => {
    api = await stubApi(DOC())
    expect((await run(addBodyweight, { weight: 80, date: '2999-01-01' })).logged).toBe(false)
    expect((await run(addBodyweight, { weight: 9999 })).problem).toMatch(/700 kg/)
    expect(api.puts).toHaveLength(0)
  })

  test('another device writing in between is kept', async () => {
    api = await stubApi(DOC())
    api.conflictOnce = true
    await run(addBodyweight, { weight: 80 })
    expect(api.doc.restSec).toBe(75)
    expect(api.doc.bodyweight).toHaveLength(2)
  })
})

describe('delete_bodyweight', () => {
  test('removes that day only; a day without one is ENOENT', async () => {
    api = await stubApi({ ...DOC(), bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }, { d: '2026-10-02', w: 79, t: 2 }] })
    expect(await run(deleteBodyweight, { date: '2026-10-01' })).toMatchObject({ deleted: true, weight: 80 })
    expect(api.doc.bodyweight.map(b => b.d)).toEqual(['2026-10-02'])
    await expect(run(deleteBodyweight, { date: '2026-10-05' })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('set_goal_weight', () => {
  test('set, converted, and removed', async () => {
    api = await stubApi(DOC())
    await run(setGoalWeight, { weight: 165, unit: 'lb' })
    expect(api.doc.targetW).toBe(74.8)
    await run(setGoalWeight, { weight: null })
    expect(api.doc.targetW).toBeNull()
  })

  test('the same goal again saves nothing', async () => {
    api = await stubApi({ ...DOC(), targetW: 75 })
    expect((await run(setGoalWeight, { weight: 75 })).updated).toBe(false)
    expect(api.puts).toHaveLength(0)
  })
})

describe('set_weekly_rate_goal', () => {
  test('stored as the app stores it, and cleared', async () => {
    api = await stubApi(DOC())
    const out = await run(setWeeklyRateGoal, { direction: 'lose', by: '%', low: 0.5, high: 1 })
    expect(api.doc.rateGoal).toEqual({ dir: 'lose', by: '%', lo: 0.5, hi: 1 })
    expect(out.range).toMatchObject({ direction: 'lose', per_week_min: -1, per_week_max: -0.5 })
    await run(setWeeklyRateGoal, { clear: true })
    expect(api.doc.rateGoal).toBeNull()
  })

  test('hold, in the profile\'s unit', async () => {
    api = await stubApi(DOC())
    await run(setWeeklyRateGoal, { direction: 'hold', by: 'weight', high: 0.3 })
    expect(api.doc.rateGoal).toEqual({ dir: 'hold', by: 'w', lo: 0, hi: 0.3 })
  })

  test('without a direction it is EINVAL', async () => {
    await expect(setWeeklyRateGoal.handler({ high: 1 }, { env: {} })).rejects.toMatchObject({ code: 'EINVAL' })
  })
})
