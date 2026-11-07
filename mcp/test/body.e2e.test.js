// The body-weight tools against the real api (support/real-api.js): what lands on disk.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { addBodyweight, deleteBodyweight, setGoalWeight } from '../src/body-tools.js'

const DOC = { unit: 'kg', targetW: 80, routines: [], workouts: [], bodyweight: [{ d: '2026-10-13', w: 80, t: 1000 }], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('body weight against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('a weigh-in and a goal are stored, the rest of the document as it was', async () => {
    await addBodyweight.handler({ weight: 79.4, date: '2026-10-14' }, { env: api.env })
    await setGoalWeight.handler({ weight: 76 }, { env: api.env })
    const s = api.stored()
    expect(s.bodyweight.map(b => [b.d, b.w])).toEqual([['2026-10-13', 80], ['2026-10-14', 79.4]])
    expect(s.targetW).toBe(76)
    expect(s.unit).toBe('kg')
  })

  test('a deleted weigh-in is on record as deleted, so no device brings it back', async () => {
    await deleteBodyweight.handler({ date: '2026-10-13' }, { env: api.env })
    const s = api.stored()
    expect(s.bodyweight.map(b => b.d)).toEqual(['2026-10-14'])
    expect(JSON.stringify(s.deleted?.bodyweight || {})).toContain('2026-10-13')
  })

  test('a second weigh-in of a day, then one of two removed, as the server keeps them', async () => {
    await addBodyweight.handler({ weight: 80.2, date: '2026-10-14', time: '21:30' }, { env: api.env })
    let day = api.stored().bodyweight.find(b => b.d === '2026-10-14')
    expect(day.ins.map(r => [r.at, r.w])).toEqual([['08:00', 79.4], ['21:30', 80.2]])
    expect(day.w).toBe(79.4)
    await deleteBodyweight.handler({ date: '2026-10-14', time: '08:00' }, { env: api.env })
    day = api.stored().bodyweight.find(b => b.d === '2026-10-14')
    expect(day.ins.map(r => r.at)).toEqual(['21:30'])
    expect(day.w).toBe(80.2)
    expect(Object.keys(day.gone)).toHaveLength(1)
  })
})
