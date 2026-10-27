// The schedule tools against the real api (support/real-api.js): what lands on disk, and that
// get_week_plan's own reading of it is what the tools said.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { assignWeekday, overrideDay, setDayNote } from '../src/schedule-tools.js'

const DOC = { unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }, { id: 'r2', name: 'Legs', ex: [], _ts: 1000 }], week: { 1: ['r1'] }, dayPlan: {}, workouts: [], bodyweight: [], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('the schedule against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('weekday, override and note are stored, and the plan days are stamped for the sync', async () => {
    await assignWeekday.handler({ weekday: 'thursday', routine_ids: ['r2'] }, { env: api.env })
    await overrideDay.handler({ date: '2026-11-02', routine_id: 'rest' }, { env: api.env })
    await setDayNote.handler({ date: '2026-10-01', tag: 'rest' }, { env: api.env })
    const s = api.stored()
    expect(s.week).toEqual({ 1: ['r1'], 4: ['r2'] })
    expect(s.dayPlan).toEqual({ '2026-11-02': 'rest' })
    expect(s.dayNotes['2026-10-01'].tag).toBe('rest')
    expect(s.routines.map(r => r.id)).toEqual(['r1', 'r2'])
    // The server records when each plan day changed, so an older phone does not undo it.
    expect(s.edited).toMatchObject({ 'week.4': expect.any(Number), 'dayPlan.2026-11-02': expect.any(Number) })
  })
})
