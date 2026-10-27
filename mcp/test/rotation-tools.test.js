// set_rotation and plan_week against a stand-in for the api (support/stub-api.js).
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { stubApi } from './support/stub-api.js'
import { setRotation, planWeek } from '../src/rotation-tools.js'
import { localIso, _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const R = ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), ex: [] }))
const DOC = () => ({ unit: 'kg', routines: structuredClone(R), week: { 1: ['a'] }, dayPlan: {}, workouts: [], rotation: null, queue: null, _wid: 'w-1' })
const run = (tool, params) => tool.handler(params, { env: api.env })
const today = localIso(new Date())

describe('set_rotation', () => {
  test('a loop is saved and becomes how the person trains, its first pass from today', async () => {
    api = await stubApi(DOC())
    const out = await run(setRotation, { sequence: ['a', 'b', 'c'], label: 'ABC' })
    expect(out).toMatchObject({ updated: true, mode: 'rotation', rotation: ['A', 'B', 'C'] })
    expect(out.current_pass.sessions.map(s => s.state)).toEqual(['next', 'later', 'later'])
    expect(api.doc.rotation).toMatchObject({ sequence: ['a', 'b', 'c'], label: 'ABC' })
    expect(api.doc.queue).toMatchObject({ ids: ['a', 'b', 'c'], startsOn: today, rotationId: api.doc.rotation.id })
    expect(api.doc.scheduleMode).toBe('rotation')
    // the weekday plan is kept for later
    expect(api.doc.week).toEqual({ 1: ['a'] })
  })

  test('rest days run as segments; back to the weekly plan keeps the loop; and on again', async () => {
    api = await stubApi(DOC())
    await run(setRotation, { sequence: ['a', 'b', 'rest', 'c'] })
    expect(api.doc.queue.ids).toEqual(['a', 'b'])
    const off = await run(setRotation, { use: 'weekly plan' })
    expect(off.mode).toBe('weekly plan')
    expect(api.doc.queue).toBeNull()
    expect(api.doc.rotation.sequence).toEqual(['a', 'b', 'rest', 'c'])
    await run(setRotation, { use: 'rotation' })
    expect(api.doc.queue.ids).toEqual(['a', 'b'])
  })

  test('unknown routines, or a planner\'s queue in the way, are a problem', async () => {
    api = await stubApi({ ...DOC(), queue: { ids: ['a'], since: 1, startsOn: today, label: 'W1' } })
    expect((await run(setRotation, { sequence: ['nope'] })).problem).toMatch(/nope/)
    expect((await run(setRotation, { sequence: ['a', 'b'] })).problem).toMatch(/planner/)
    expect(api.puts).toHaveLength(0)
  })
})

describe('plan_week', () => {
  test('a planner\'s queue: no rotation id, so the app never refills it; [] clears it', async () => {
    api = await stubApi(DOC())
    const out = await run(planWeek, { routine_ids: ['b', 'a'], label: 'Week 3', starts_on: '2026-11-02' })
    expect(api.doc.queue).toMatchObject({ ids: ['b', 'a'], startsOn: '2026-11-02', label: 'Week 3' })
    expect('rotationId' in api.doc.queue).toBe(false)
    expect(out.current_pass.sessions.map(s => s.name)).toEqual(['B', 'A'])
    await run(planWeek, { routine_ids: [] })
    expect(api.doc.queue).toBeNull()
  })

  test('over the app\'s rotation only when asked to', async () => {
    api = await stubApi(DOC())
    await run(setRotation, { sequence: ['a', 'b'] })
    const n = api.puts.length
    expect((await run(planWeek, { routine_ids: ['c'] })).problem).toMatch(/replace_rotation/)
    expect((await run(planWeek, { routine_ids: [] })).problem).toMatch(/set_rotation/)
    expect(api.puts).toHaveLength(n)
    await run(planWeek, { routine_ids: ['c'], replace_rotation: true })
    expect(api.doc.queue.ids).toEqual(['c'])
  })
})
