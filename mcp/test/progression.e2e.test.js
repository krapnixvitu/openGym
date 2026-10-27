// set_progression against the real api (support/real-api.js): the rule lands on the routine and
// the server stamps the change, so an older phone does not undo it.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { setProgression } from '../src/progression-tools.js'

const DOC = { unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }], week: {}, dayPlan: {}, workouts: [], bodyweight: [], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('set_progression against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('the exercise\'s rule and step are stored, and the routine stamped', async () => {
    await setProgression.handler({ exercise: '0025', rule: 'double', increment: 5 }, { env: api.env })
    const r = api.stored().routines[0]
    expect(r.ex[0]).toMatchObject({ prog: 'double', inc: 5 })
    expect(r._ts).toBeGreaterThan(1000)
  })
})
