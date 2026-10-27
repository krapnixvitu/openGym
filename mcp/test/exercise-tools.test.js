// The exercise tools: the writes against a stand-in for the api (support/stub-api.js), the reads
// against a data folder, as the read tools are tested.
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubApi } from './support/stub-api.js'
import { createCustomExercise, editCustomExercise, deleteCustomExercise, setExerciseNote, setAlias, favouriteExercise, setBarWeight } from '../src/exercise-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const SLED = { id: 'csled', n: 'Prowler push', bp: 'upper legs', eq: 'sled machine', tg: 'quadriceps', primaries: ['quadriceps'], secondaries: ['gluteal'], sm: ['gluteal'], muscleGroups: ['quadriceps', 'gluteal'], desc: '', custom: true, aliases: [] }
const DOC = () => ({
  unit: 'kg', customEx: [structuredClone(SLED)], favEx: [], exNotes: {}, exAliases: {}, barWeights: {}, exWeights: { csled: { w: 100, d: '2026-10-01' } },
  routines: [{ id: 'r1', name: 'Legs', ex: [{ id: '0043', sets: 3, reps: 5, sg: 'g1' }, { id: 'csled', sets: 3, reps: 1, sg: 'g1' }] }],
  workouts: [{ id: 'w1', d: '2026-10-01', entries: [{ id: 'csled', sets: [{ w: 100, r: 1, done: true }] }] }],
  _wid: 'w-1',
})
const run = (tool, params) => tool.handler(params, { env: api.env })

describe('custom exercises', () => {
  test('made as the form makes one: target the first primary, muscles in body order', async () => {
    api = await stubApi(DOC())
    const out = await run(createCustomExercise, { name: 'Banded hip thrust', body_part: 'upper legs', equipment: 'band', primary_muscles: ['hamstring', 'gluteal'], secondary_muscles: ['gluteal', 'lower-back'], other_names: ['hip bridge', 'Hip Bridge'] })
    expect(out.created).toBe(true)
    const c = api.doc.customEx.at(-1)
    expect(c).toMatchObject({ n: 'Banded hip thrust', bp: 'upper legs', eq: 'band', custom: true, tg: 'hamstring', primaries: ['gluteal', 'hamstring'], secondaries: ['lower-back'], sm: ['lower-back'], aliases: ['hip bridge'] })
    expect(c.id).toMatch(/^c/)
  })

  test('a name the library or the person already has is refused', async () => {
    api = await stubApi(DOC())
    expect((await run(createCustomExercise, { name: 'barbell bench press', body_part: 'chest', equipment: 'barbell' })).problem).toMatch(/already exists/)
    expect((await run(createCustomExercise, { name: 'prowler PUSH', body_part: 'upper legs', equipment: 'sled machine' })).problem).toMatch(/already exists/)
    expect(api.puts).toHaveLength(0)
  })

  test('edited: the target stays while it is still a primary', async () => {
    api = await stubApi(DOC())
    await run(editCustomExercise, { exercise_id: 'csled', name: 'Sled push', primary_muscles: ['gluteal', 'quadriceps'], description: 'low handles' })
    expect(api.doc.customEx[0]).toMatchObject({ n: 'Sled push', tg: 'gluteal', primaries: ['gluteal', 'quadriceps'], secondaries: [], desc: 'low handles' })
    expect((await run(editCustomExercise, { exercise_id: '0025', name: 'X' })).problem).toMatch(/own/)
  })

  test('deleted as the app deletes one: out of routines and favourites, history keeps its name', async () => {
    api = await stubApi({ ...DOC(), favEx: ['csled'] })
    const out = await run(deleteCustomExercise, { exercise_id: 'csled' })
    expect(out).toMatchObject({ deleted: true, removed_from_routines: ['Legs'] })
    expect(api.doc.customEx).toEqual([])
    expect(api.doc.routines[0].ex).toEqual([{ id: '0043', sets: 3, reps: 5 }])
    expect(api.doc.favEx).toEqual([])
    expect(api.doc.exWeights).toEqual({})
    expect(api.doc.workouts[0].entries[0]).toMatchObject({ id: 'csled', n: 'Prowler push' })
  })

  test('not while a workout running on a device has it', async () => {
    api = await stubApi({ ...DOC(), active: { entries: [{ id: 'csled' }] } })
    expect((await run(deleteCustomExercise, { exercise_id: 'csled' })).problem).toMatch(/running/)
  })
})

describe('what is kept about any exercise', () => {
  test('a standing note, and taking it off', async () => {
    api = await stubApi(DOC())
    await run(setExerciseNote, { exercise: 'smith machine squat', note: '  seat 4, pin 7 ' })
    expect(api.doc.exNotes).toEqual({ '0770': 'seat 4, pin 7' })
    await run(setExerciseNote, { exercise: '0770', note: '' })
    expect(api.doc.exNotes).toEqual({})
  })

  test('other names: in the library map for a catalogue exercise, on the exercise for one\'s own', async () => {
    api = await stubApi(DOC())
    await run(setAlias, { exercise: '0025', names: ['flat bench', 'bench'] })
    expect(api.doc.exAliases).toEqual({ '0025': ['flat bench', 'bench'] })
    await run(setAlias, { exercise: 'csled', names: ['prowler'] })
    expect(api.doc.customEx[0].aliases).toEqual(['prowler'])
    expect((await run(setAlias, { exercise: '0025', names: ['flat bench', 'bench'] })).updated).toBe(false)
  })

  test('a favourite on and off', async () => {
    api = await stubApi(DOC())
    await run(favouriteExercise, { exercise: '0025', favourite: true })
    expect(api.doc.favEx).toEqual(['0025'])
    expect((await run(favouriteExercise, { exercise: '0025', favourite: true })).updated).toBe(false)
    await run(favouriteExercise, { exercise: '0025', favourite: false })
    expect(api.doc.favEx).toEqual([])
  })

  test('a bar: lighter, none (a stored 0), back to the type\'s, and only on a bar exercise', async () => {
    api = await stubApi(DOC())
    expect((await run(setBarWeight, { exercise: '0025', weight: 15 })).bar).toBe(15)
    expect((await run(setBarWeight, { exercise: '0770', weight: 0 })).bar).toBe(0)
    expect(api.doc.barWeights).toEqual({ '0025': 15, '0770': 0 })
    expect((await run(setBarWeight, { exercise: '0025', weight: null })).bar).toBe(20)
    expect(api.doc.barWeights).toEqual({ '0770': 0 })
    expect((await run(setBarWeight, { exercise: '0294', weight: 10 })).problem).toMatch(/not done on a bar/)
  })
})

describe('search_exercises and similar_exercises', () => {
  const dirs = []
  afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
  afterEach(() => vi.unstubAllEnvs())
  async function load(doc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ex-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'alex', name: 'Alex' }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dir, 'state-alex.json'), JSON.stringify(doc))
    vi.resetModules()
    vi.stubEnv('OPENGYM_DATA', dir)
    vi.stubEnv('OPENGYM_UID', 'alex')
    return import('../src/exercise-tools.js')
  }

  test('typos, the person\'s own exercises and other names are found; favourites first', async () => {
    const { searchExercisesTool: s } = await load({ ...DOC(), favEx: ['0043'], exAliases: { '0025': ['flatty'] } })
    expect(s.handler({ query: 'bnech press' }).results.some(r => r.id === '0025')).toBe(true)
    expect(s.handler({ query: 'prowler' }).results[0]).toMatchObject({ id: 'csled', custom: true })
    expect(s.handler({ query: 'flatty' }).results[0].id).toBe('0025')
    const squats = s.handler({ query: 'squat', equipment: 'barbell' })
    expect(squats.results[0]).toMatchObject({ id: '0043', favourite: true })
    expect(squats.results.every(r => r.equipment === 'barbell')).toBe(true)
  })

  test('similar: the same main muscle, the same equipment first, and only what the gym has when asked', async () => {
    const gym = { id: 'eqhome', name: 'Home', equipment: ['dumbbell', 'bench'], accV: 2 }
    const { similarExercisesTool: sim } = await load({ ...DOC(), equipProfiles: [gym], activeEquipId: 'eqhome', equipFilterOn: true })
    const out = sim.handler({ exercise: '0025', limit: 50 })
    expect(out.similar.length).toBeGreaterThan(5)
    expect(out.similar.every(r => r.target === out.exercise.target)).toBe(true)
    expect(out.similar[0].equipment).toBe('barbell')
    const home = sim.handler({ exercise: '0025', available_only: true })
    expect(home.similar.length).toBeGreaterThan(0)
    expect(home.similar.every(r => !r.not_in_equipment_in_use && ['dumbbell', 'body weight'].includes(r.equipment))).toBe(true)
  })
})
