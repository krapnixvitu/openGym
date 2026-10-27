// The more reads (report-tools.js) on the demo seed: each answers what the app's own screen shows,
// so these pin the shape and the edge cases rather than re-deriving the lib maths.
import { describe, beforeEach, afterAll, test, expect, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { _seedStateForTests } from '../src/state.js'
import { REPORT_TOOLS } from '../src/report-tools.js'

const call = (name, params = {}) => REPORT_TOOLS.find(t => t.name === name).handler(params)
let S

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-07-27T12:00:00'), toFake: ['Date'] })
  S = buildDemoState()
  S.unit = 'kg'
  _seedStateForTests(S)
})
afterAll(() => vi.useRealTimers())

test('every report tool is a read', () => {
  expect(REPORT_TOOLS.map(t => t.name)).toEqual(['exercise_history', 'training_report', 'recovery', 'strength_balance', 'plate_math'])
  REPORT_TOOLS.forEach(t => expect(t.read).toBe(true))
})

test('no synced state answers with an error, not a throw', () => {
  _seedStateForTests(null)
  REPORT_TOOLS.forEach(t => expect(t.handler(t.name === 'exercise_history' ? { exercise: 'x' } : { weight: 60 }).error).toMatch(/no synced state/))
})

describe('exercise_history', () => {
  test('newest session first, with a trend', () => {
    const r = call('exercise_history', { exercise: '0025', limit: 2 })
    expect(r.id).toBe('0025')
    expect(r.unit).toBe('kg')
    expect(r.sessions.length).toBeLessThanOrEqual(2)
    expect(r.sessions_logged).toBeGreaterThanOrEqual(r.sessions.length)
    const dates = r.sessions.map(s => s.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    r.sessions.forEach(s => expect(s.sets.every(x => typeof x === 'string')).toBe(true))
    expect(r.trend.length).toBe(r.sessions_logged)
  })
  test('an unknown name says so', () => {
    expect(call('exercise_history', { exercise: 'zzqx no such lift' }).problem).toBeTruthy()
  })
})

describe('training_report', () => {
  test('four weeks by default, against the stretch before', () => {
    const r = call('training_report')
    expect(r.days).toBe(28)
    expect(r.totals.workouts).toBeGreaterThan(0)
    expect(r.before).toHaveProperty('workouts')
    expect(r.per_week.length).toBeGreaterThan(0)
    expect(r.muscles_worked.length).toBeGreaterThan(0)
  })
  test('from and to make a custom range', () => {
    const r = call('training_report', { from: '2026-07-20', to: '2026-07-26' })
    expect(r.from).toBe('2026-07-20')
    expect(r.to).toBe('2026-07-26')
    expect(r.days).toBe(7)
  })
})

test('recovery lists every muscle with a state', () => {
  const r = call('recovery')
  expect(r.muscles.length).toBeGreaterThan(10)
  r.muscles.forEach(m => {
    expect(typeof m.muscle).toBe('string')
    expect(m.strength_kept).toBeGreaterThanOrEqual(0)
    expect(m.strength_kept).toBeLessThanOrEqual(1)
  })
  expect(r.ready).toEqual(r.muscles.filter(m => m.state === 'ready').map(m => m.muscle))
})

test('strength_balance uses the default template and says what is missing', () => {
  const r = call('strength_balance')
  expect(r.template).toBeTruthy()
  expect(r.lifts.length).toBeGreaterThan(0)
  r.lifts.forEach(l => expect(l.actual_pct != null || l.missing || l.status).toBeTruthy())
})

describe('plate_math', () => {
  test('a barbell, per side', () => {
    const r = call('plate_math', { weight: 102.5 })
    expect(r.bar).toBe(20)
    expect(r.per_side).toBe(41.25)
    expect(r.plates.reduce((a, b) => a + b, 0)).toBe(41.25)
  })
  test('the bar alone', () => {
    expect(call('plate_math', { weight: 20 }).plates).toEqual([])
  })
  test('an exercise not loaded with plates', () => {
    const r = call('plate_math', { weight: 20, exercise: '4087' })
    expect(r.plates).toBeNull()
  })
})
