// The routine tools against the real api (support/real-api.js): what lands on disk, and that the
// server's own sync records keep a delete deleted and let an undo come back.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { createRoutine, editRoutine, deleteRoutineTool, restoreRoutineTool } from '../src/routine-tools.js'

const DOC = { unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }], week: { 1: ['r1'] }, dayPlan: {}, workouts: [], bodyweight: [], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('routines against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())
  const r1 = () => api.stored().routines.find(r => r.id === 'r1')

  test('an edit is stored and stamped, and restore puts the old values back', async () => {
    await editRoutine.handler({ routine_id: 'r1', changes: [{ action: 'update', slot: 1, weight: 105, reps: 3 }] }, { env: api.env })
    expect(r1().ex[0]).toMatchObject({ weight: 105, reps: 3 })
    expect(r1()._ts).toBeGreaterThan(1000)
    await restoreRoutineTool.handler({ routine_id: 'r1' }, { env: api.env })
    expect(r1().ex[0]).toMatchObject({ weight: 100, reps: 5 })
  })

  test('a new routine is stored; a deleted one is on record as deleted, and comes back on restore', async () => {
    const made = await createRoutine.handler({ name: 'Legs', exercises: [{ exercise: '0043', sets: 5, reps: 5, weight: 80 }] }, { env: api.env })
    expect(api.stored().routines.map(r => r.name)).toEqual(['Push', 'Legs'])
    await deleteRoutineTool.handler({ routine_id: 'r1' }, { env: api.env })
    let s = api.stored()
    expect(s.routines.map(r => r.id)).toEqual([made.routine.id])
    expect(s.week).toEqual({})
    expect(s.deleted.routines.r1).toBeGreaterThan(0)
    await restoreRoutineTool.handler({ routine_id: 'r1' }, { env: api.env })
    s = api.stored()
    expect(s.routines.map(r => r.id)).toEqual(['r1', made.routine.id])
    expect(s.week).toEqual({ 1: ['r1'] })
  })
})
