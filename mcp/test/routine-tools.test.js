// The routine tools against a stand-in for the api (support/stub-api.js).
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { stubApi } from './support/stub-api.js'
import { createRoutine, editRoutine, deleteRoutineTool, duplicateRoutine, restoreRoutineTool, _resetUndo } from '../src/routine-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => { _resetWriteWindow(); _resetUndo() })
const PUSH = { id: 'r1', name: 'Push', emoji: 'figureStrength', ex: [
  { id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps', restSec: 180 },
  { id: '0294', sets: 3, reps: 12, weight: 12, mode: 'reps' },
  { id: '0313', sets: 3, reps: 10, weight: 14, mode: 'reps' },
], _ts: 1000 }
const DOC = () => ({ unit: 'kg', routines: [structuredClone(PUSH), { id: 'r2', name: 'Legs', ex: [] }], week: { 1: ['r1'], 4: ['r1', 'r2'] }, dayPlan: { '2026-11-03': 'r1' }, workouts: [], _wid: 'w-1' })
const run = (tool, params) => tool.handler(params, { env: api.env })
const r1 = () => api.doc.routines.find(r => r.id === 'r1')

describe('create_routine', () => {
  test('a named routine with its exercises, numbers and a superset, at the end of the list', async () => {
    api = await stubApi(DOC())
    const out = await run(createRoutine, {
      name: 'Arms', progression: 'double',
      exercises: [
        { exercise: 'dumbbell curl', sets: 3, reps: 12, reps_min: 8, weight: 12, rest_sec: 60 },
        { exercise: '0313', reps: 10, weight: 14 },
        { exercise: '0463' },
      ],
      supersets: [[1, 2]],
    })
    expect(out.created).toBe(true)
    const r = api.doc.routines.at(-1)
    expect(r).toMatchObject({ id: out.routine.id, name: 'Arms', prog: 'double', emoji: 'figureStrength' })
    expect(r.ex[0]).toMatchObject({ id: '0294', sets: 3, reps: 12, repsMin: 8, weight: 12, restSec: 60, mode: 'reps' })
    expect(r.ex[0].sg).toBeTruthy()
    expect(r.ex[1].sg).toBe(r.ex[0].sg)
    // a plank starts timed, as the app starts it
    expect(r.ex[2]).toMatchObject({ mode: 'time', sec: 45 })
    expect(out.routine.exercises[0].plan).toMatch(/3 × 8–12/)
  })

  test('dry_run shows the routine and saves nothing', async () => {
    api = await stubApi(DOC())
    const out = await run(createRoutine, { name: 'Arms', exercises: [{ exercise: '0294' }], dry_run: true })
    expect(out).toMatchObject({ created: false, dry_run: true })
    expect(out.would_create.exercises).toHaveLength(1)
    expect(api.puts).toHaveLength(0)
  })

  test('an exercise that matches nothing, or numbers that do not fit it, is a problem', async () => {
    api = await stubApi(DOC())
    expect((await run(createRoutine, { name: 'X', exercises: [{ exercise: 'zzqx nothing' }] })).problem).toMatch(/zzqx/)
    expect((await run(createRoutine, { name: 'X', exercises: [{ exercise: '0463', reps: 10 }] })).problem).toMatch(/reps/)
    expect((await run(createRoutine, { name: 'X', exercises: [{ exercise: '0294' }, { exercise: '0313' }, { exercise: '0025' }], supersets: [[1, 3]] })).problem).toMatch(/next to each other/)
    expect(api.puts).toHaveLength(0)
  })

  test('a per-side exercise keeps an even rep target', async () => {
    api = await stubApi(DOC())
    await run(createRoutine, { name: 'X', exercises: [{ exercise: '0294', per_side: true, reps: 15 }] })
    expect(api.doc.routines.at(-1).ex[0]).toMatchObject({ side: true, reps: 16 })
  })

  test('saved once under one id when another device writes in between', async () => {
    api = await stubApi(DOC())
    api.conflictOnce = true
    const out = await run(createRoutine, { name: 'Arms', exercises: [] })
    expect(api.puts).toHaveLength(2)
    expect(api.doc.routines.filter(r => r.name === 'Arms').map(r => r.id)).toEqual([out.routine.id])
    expect(api.doc.restSec).toBe(75)
  })
})

describe('edit_routine', () => {
  test('changes in order: update, add at a position, move, remove', async () => {
    api = await stubApi(DOC())
    const out = await run(editRoutine, {
      routine_id: 'r1', name: 'Push A',
      changes: [
        { action: 'update', slot: 1, weight: 102.5, warmup_sets: 2, note: 'pause at the chest' },
        { action: 'add', exercise: '0463', position: 2 },
        { action: 'move', slot: 3, to: 1 },
        { action: 'add', exercise: '0031' },
        { action: 'remove', slot: 5 },
      ],
    })
    expect(out.updated).toBe(true)
    const r = r1()
    expect(r.name).toBe('Push A')
    expect(r.ex.map(e => e.id)).toEqual(['0294', '0025', expect.any(String), '0313'])
    expect(r.ex[1]).toMatchObject({ weight: 102.5, warmupSets: 2, note: 'pause at the chest', restSec: 180 })
    expect(r.ex[2].mode).toBe('time')
    // the routine's sync stamp stays as it was: the server stamps what changed
    expect(r._ts).toBe(1000)
  })

  test('replace keeps the slot\'s sets, reps and rest', async () => {
    api = await stubApi(DOC())
    await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'replace', slot: 1, exercise: '0031' }] })
    expect(r1().ex[0]).toMatchObject({ id: '0031', sets: 3, reps: 5, restSec: 180 })
  })

  test('superset with name and rest, and taking it apart again', async () => {
    api = await stubApi(DOC())
    await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'superset', slot: 2, superset_name: 'Arms', superset_rest_sec: 90 }] })
    const [, a, b] = r1().ex
    expect(a.sg).toBeTruthy()
    expect(b).toMatchObject({ sg: a.sg, sgName: 'Arms', sgRest: 90 })
    await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'unsuperset', slot: 3 }] })
    expect(r1().ex.some(e => e.sg || e.sgName)).toBe(false)
  })

  test('rep range, pyramid, rest off and the progression rule', async () => {
    api = await stubApi(DOC())
    await run(editRoutine, { routine_id: 'r1', progression: 'linear', changes: [
      { action: 'update', slot: 2, reps: 12, reps_min: 8, progression: 'double', rest_sec: 0 },
      { action: 'update', slot: 3, pyramid: [12, 10, 8, 'max'] },
    ] })
    const r = r1()
    expect(r.prog).toBe('linear')
    expect(r.ex[1]).toMatchObject({ reps: 12, repsMin: 8, prog: 'double', restOff: true })
    expect(r.ex[2]).toMatchObject({ pyramid: [12, 10, 8, 'max'], sets: 4 })
  })

  test('a slot that is not there, or a rule that does not fit, is a problem and nothing is saved', async () => {
    api = await stubApi(DOC())
    expect((await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'remove', slot: 9 }] })).problem).toMatch(/slot 9/)
    expect((await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'update', slot: 1, progression: 'time' }] })).problem).toMatch(/time progression/)
    expect((await run(editRoutine, { routine_id: 'nope', name: 'X' })).problem).toMatch(/nope/)
    expect(api.puts).toHaveLength(0)
  })

  test('the same values again save nothing, and dry_run saves nothing', async () => {
    api = await stubApi(DOC())
    expect((await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'update', slot: 1, weight: 100 }] })).updated).toBe(false)
    const dry = await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'remove', slot: 1 }], dry_run: true })
    expect(dry.would_be.exercises).toHaveLength(2)
    expect(api.puts).toHaveLength(0)
  })
})

describe('delete, duplicate and restore', () => {
  test('delete takes the routine off its days and reschedules; restore puts it all back', async () => {
    api = await stubApi(DOC())
    expect((await run(deleteRoutineTool, { routine_id: 'r1' })).deleted).toBe(true)
    expect(api.doc.routines.map(r => r.id)).toEqual(['r2'])
    expect(api.doc.week).toEqual({ 4: ['r2'] })
    expect(api.doc.dayPlan).toEqual({})
    expect((await run(restoreRoutineTool, { routine_id: 'r1' })).restored).toBe(true)
    expect(api.doc.routines.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(api.doc.week).toEqual({ 1: ['r1'], 4: ['r1', 'r2'] })
    expect(api.doc.dayPlan).toEqual({ '2026-11-03': 'r1' })
  })

  test('restore undoes an edit, one step per call, and then has nothing left', async () => {
    api = await stubApi(DOC())
    await run(editRoutine, { routine_id: 'r1', name: 'Push A' })
    await run(editRoutine, { routine_id: 'r1', changes: [{ action: 'remove', slot: 1 }] })
    await run(restoreRoutineTool, { routine_id: 'r1' })
    expect(r1()).toMatchObject({ name: 'Push A' })
    expect(r1().ex).toHaveLength(3)
    await run(restoreRoutineTool, { routine_id: 'r1' })
    expect(r1().name).toBe('Push')
    expect((await run(restoreRoutineTool, { routine_id: 'r1' })).restored).toBe(false)
  })

  test('duplicate puts a copy right after the original, under a new id and name', async () => {
    api = await stubApi(DOC())
    const out = await run(duplicateRoutine, { routine_id: 'r1' })
    expect(api.doc.routines.map(r => r.name)).toEqual(['Push', 'Push (Copy)', 'Legs'])
    const copy = api.doc.routines[1]
    expect(copy.id).toBe(out.routine.id)
    expect(copy.id).not.toBe('r1')
    expect(copy.ex).toEqual(PUSH.ex)
    expect(copy._ts).toBeUndefined()
    await run(duplicateRoutine, { routine_id: 'r1', name: 'Push B' })
    expect(api.doc.routines[1].name).toBe('Push B')
  })
})
