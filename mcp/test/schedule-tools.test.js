// The schedule tools against a stand-in for the api (support/stub-api.js).
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { stubApi } from './support/stub-api.js'
import { assignWeekday, overrideDay, setDayNote } from '../src/schedule-tools.js'
import { localIso, _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const DOC = () => ({ unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [] }, { id: 'r2', name: 'Legs', ex: [] }], week: { 1: ['r1'] }, dayPlan: {}, workouts: [], _wid: 'w-1' })
const run = (tool, params) => tool.handler(params, { env: api.env })

describe('assign_weekday', () => {
  test('one routine, a combined day in order, and a rest day', async () => {
    api = await stubApi(DOC())
    await run(assignWeekday, { weekday: 'wednesday', routine_ids: ['r2'] })
    expect(api.doc.week[3]).toEqual(['r2'])
    const out = await run(assignWeekday, { weekday: 'monday', routine_ids: ['r2', 'r1'] })
    expect(out.routines).toEqual(['Legs', 'Push'])
    expect(api.doc.week[1]).toEqual(['r2', 'r1'])
    await run(assignWeekday, { weekday: 'monday', routine_ids: [] })
    expect('1' in api.doc.week).toBe(false)
  })

  test('an unknown routine is a problem, nothing saved', async () => {
    api = await stubApi(DOC())
    const out = await run(assignWeekday, { weekday: 'friday', routine_ids: ['nope'] })
    expect(out.problem).toMatch(/nope/)
    expect(api.puts).toHaveLength(0)
  })

  test('the same plan again saves nothing', async () => {
    api = await stubApi(DOC())
    expect((await run(assignWeekday, { weekday: 'monday', routine_ids: ['r1'] })).updated).toBe(false)
    expect(api.puts).toHaveLength(0)
  })
})

describe('override_day', () => {
  // 2026-11-02 is a Monday, which the weekly plan gives Push.
  test('another routine, rest, and back to the weekly plan', async () => {
    api = await stubApi(DOC())
    expect((await run(overrideDay, { date: '2026-11-02', routine_id: 'r2' })).planned).toEqual(['Legs'])
    expect(api.doc.dayPlan['2026-11-02']).toBe('r2')
    expect((await run(overrideDay, { date: '2026-11-02', routine_id: 'rest' })).planned).toBe('rest')
    const back = await run(overrideDay, { date: '2026-11-02', routine_id: null })
    expect(back.planned).toEqual(['Push'])
    expect('2026-11-02' in api.doc.dayPlan).toBe(false)
  })

  test('an unknown routine is a problem', async () => {
    api = await stubApi(DOC())
    expect((await run(overrideDay, { date: '2026-11-02', routine_id: 'nope' })).updated).toBe(false)
  })
})

describe('set_day_note', () => {
  test('a tag and a text, then cleared as a stamped empty entry', async () => {
    api = await stubApi(DOC())
    const out = await run(setDayNote, { date: '2026-10-01', tag: 'sick', text: 'flu' })
    expect(out.note).toEqual({ tag: 'sick', text: 'flu' })
    expect(api.doc.dayNotes['2026-10-01']).toMatchObject({ tag: 'sick', text: 'flu', _ts: expect.any(Number) })
    await run(setDayNote, { date: '2026-10-01', clear: true })
    expect(api.doc.dayNotes['2026-10-01']).toEqual({ _ts: expect.any(Number) })
  })

  test('not for a day still to come', async () => {
    api = await stubApi(DOC())
    const d = new Date(); d.setDate(d.getDate() + 2)
    expect((await run(setDayNote, { date: localIso(d), tag: 'travel' })).updated).toBe(false)
  })

  test('nothing to say is EINVAL', async () => {
    await expect(setDayNote.handler({ date: '2026-10-01' }, { env: {} })).rejects.toMatchObject({ code: 'EINVAL' })
  })
})
