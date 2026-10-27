// set_rotation and plan_week against the real api (support/real-api.js): stored as the app stores
// them, and stamped, so a phone that has not seen the change does not undo it.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { setRotation, planWeek } from '../src/rotation-tools.js'

const DOC = { unit: 'kg', routines: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), ex: [], _ts: 1000 })), week: {}, dayPlan: {}, workouts: [], bodyweight: [], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('rotation and week queue against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('a rotation, then a planner\'s week over it', async () => {
    await setRotation.handler({ sequence: ['a', 'rest', 'b'] }, { env: api.env })
    let s = api.stored()
    expect(s.rotation.sequence).toEqual(['a', 'rest', 'b'])
    expect(s.queue).toMatchObject({ ids: ['a'], rotationId: s.rotation.id })
    expect(s.edited).toMatchObject({ rotation: expect.any(Number), queue: expect.any(Number), scheduleMode: expect.any(Number) })
    await planWeek.handler({ routine_ids: ['b', 'a'], label: 'W1', replace_rotation: true }, { env: api.env })
    s = api.stored()
    expect(s.queue).toMatchObject({ ids: ['b', 'a'], label: 'W1' })
    expect(s.queue.rotationId).toBeUndefined()
  })
})
