// update_workout and delete_workout against a stand-in for the api (as write-tools.test.js): the
// workout is filed with log_workout first, so what is corrected is a record the app would hold.
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { logWorkout, updateWorkout, deleteWorkout, swapExercise, addToWorkout, moveWorkoutTool, excludeFromProgression, _resetWriteWindow } from '../src/write-tools.js'

const TOKEN = 'tok.secret-value'

let api
function stubApi(doc) {
  const s = { doc: structuredClone(doc), rev: 7, puts: [], conflictOnce: false }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'u1', name: 'Matt' } })
    if (req.url === '/api/data' && req.method === 'GET') return send(200, { state: s.doc, rev: s.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      s.puts.push(body)
      if (s.conflictOnce) {
        // Another device wrote in between: a weigh-in, which the retry has to keep.
        s.conflictOnce = false
        s.doc = { ...s.doc, bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }] }
        s.rev++
        return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())

const DOC = () => ({ unit: 'kg', workouts: [], routines: [], customEx: [], exWeights: {}, _wid: 'w-abc', _ts: 1 })
const CURLS = { date: '2026-10-20', exercises: [{ exercise: 'dumbbell curl', sets: [{ reps: 12, weight: 12 }, { reps: 12, weight: 12 }, { reps: 10, weight: 12 }] }] }

async function withLogged() {
  api = await stubApi(DOC())
  const logged = await logWorkout.handler(CURLS, { env: api.env })
  expect(logged.logged).toBe(true)
  return logged.workout_id
}
const stored = id => api.doc.workouts.find(w => w.id === id)

describe('update_workout', () => {
  test('changes one set, works the volume out again and stamps the record', async () => {
    const id = await withLogged()
    const before = stored(id)
    const out = await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 2, weight: 14, failure: true }] }, { env: api.env })
    expect(out.updated).toBe(true)
    const after = stored(id)
    expect(after.entries[0].sets[1]).toMatchObject({ w: 14, r: 12, failure: true })
    expect(after.entries[0].sets[0]).toMatchObject({ w: 12, r: 12 })
    expect(after.vol).toBe(12 * 12 + 14 * 12 + 12 * 10)
    expect(after._ts).toBeGreaterThanOrEqual(before._ts || 0)
    expect(out.revision).toBe(api.rev)
  })

  test('takes a set out, and the note can be set and cleared', async () => {
    const id = await withLogged()
    await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 3, remove: true }], note: 'grip gave out' }, { env: api.env })
    expect(stored(id).entries[0].sets).toHaveLength(2)
    expect(stored(id).note).toBe('grip gave out')
    await updateWorkout.handler({ workout_id: id, note: '' }, { env: api.env })
    expect(stored(id).note).toBeUndefined()
  })

  test('a dry run saves nothing', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 1, reps: 15 }], dry_run: true }, { env: api.env })
    expect(out).toMatchObject({ updated: false, dry_run: true })
    expect(out.would_save.exercises[0].sets[0].reps).toBe(15)
    expect(api.puts.length).toBe(puts)
    expect(stored(id).entries[0].sets[0].r).toBe(12)
  })

  test('a set or exercise that is not there is a problem to put to the user, not a save', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 9, reps: 5 }] }, { env: api.env })
    expect(out.updated).toBe(false)
    expect(out.problem).toMatch(/3 sets/)
    expect(api.puts.length).toBe(puts)
  })

  test('taking out every set points to delete_workout', async () => {
    const id = await withLogged()
    const out = await updateWorkout.handler({ workout_id: id, sets: [1, 2, 3].map(set => ({ exercise: 1, set, remove: true })) }, { env: api.env })
    expect(out.problem).toMatch(/delete_workout/)
    expect(stored(id).entries[0].sets).toHaveLength(3)
  })

  test('a write from another device in between is kept (409, then the edit again on its copy)', async () => {
    const id = await withLogged()
    api.conflictOnce = true
    await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 1, weight: 13 }] }, { env: api.env })
    expect(stored(id).entries[0].sets[0].w).toBe(13)
    expect(api.doc.bodyweight).toHaveLength(1)
  })

  test('a session running on a phone is left as it was', async () => {
    const id = await withLogged()
    api.doc = { ...api.doc, active: { routineId: 'r1', entries: [], start: 5 } }
    await updateWorkout.handler({ workout_id: id, sets: [{ exercise: 1, set: 1, reps: 11 }] }, { env: api.env })
    expect(api.doc.active).toEqual({ routineId: 'r1', entries: [], start: 5 })
    expect(stored(id).entries[0].sets[0].r).toBe(11)
  })

  test('an unknown workout id is ENOENT', async () => {
    await withLogged()
    await expect(updateWorkout.handler({ workout_id: 'nope', note: 'x' }, { env: api.env })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('without anything to change it is EINVAL', async () => {
    await expect(updateWorkout.handler({ workout_id: 'x' }, { env: {} })).rejects.toMatchObject({ code: 'EINVAL' })
  })
})

describe('delete_workout', () => {
  test('removes the workout and only it, and no key is added for a session nobody is running', async () => {
    const id = await withLogged()
    const other = await logWorkout.handler({ ...CURLS, date: '2026-10-21' }, { env: api.env })
    const out = await deleteWorkout.handler({ workout_id: id }, { env: api.env })
    expect(out).toMatchObject({ deleted: true, workout_id: id, date: '2026-10-20' })
    expect(stored(id)).toBeUndefined()
    expect(stored(other.workout_id)).toBeDefined()
    expect('active' in api.puts.at(-1).state).toBe(false)
  })

  test('an unknown workout id is ENOENT and saves nothing', async () => {
    await withLogged()
    const puts = api.puts.length
    await expect(deleteWorkout.handler({ workout_id: 'nope' }, { env: api.env })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(api.puts.length).toBe(puts)
  })
})

describe('swap_exercise', () => {
  test('moves the sets to the exercise it really was, and the badges follow', async () => {
    const id = await withLogged()
    const out = await swapExercise.handler({ workout_id: id, exercise: 1, to: 'dumbbell hammer curl' }, { env: api.env })
    expect(out.swapped).toBe(true)
    expect(out.to).toEqual({ id: '0313', name: 'dumbbell hammer curl' })
    const e = stored(id).entries[0]
    expect(e.id).toBe(out.to.id)
    expect(e.sets.map(r => r.r)).toEqual([12, 12, 10])
    expect(e.muscleSnapshot).toBeUndefined()
  })

  test('an ambiguous or unknown name comes back with candidates, nothing saved', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await swapExercise.handler({ workout_id: id, exercise: 1, to: 'zzz no such lift' }, { env: api.env })
    expect(out.swapped).toBe(false)
    expect(out.problem).toBeTruthy()
    expect(api.puts.length).toBe(puts)
  })

  test('a lifting entry does not swap with cardio, whose sets mean time and speed', async () => {
    const id = await withLogged()
    const out = await swapExercise.handler({ workout_id: id, exercise: 1, to: '2197' }, { env: api.env })
    expect(out.swapped).toBe(false)
    expect(out.problem).toMatch(/not logged the same way/)
  })

  test('a dry run shows the match and saves nothing', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await swapExercise.handler({ workout_id: id, exercise: 1, to: 'dumbbell hammer curl', dry_run: true }, { env: api.env })
    expect(out).toMatchObject({ swapped: false, dry_run: true })
    expect(api.puts.length).toBe(puts)
  })
})

describe('add_to_workout', () => {
  test('a forgotten set goes onto the exercise, and a forgotten exercise onto the workout', async () => {
    const id = await withLogged()
    const out = await addToWorkout.handler({ workout_id: id, add: [
      { exercise: 1, sets: [{ reps: 8, weight: 12 }] },
      { name: '0313', sets: [{ reps: 10, weight: 10 }, { reps: 10, weight: 10 }] },
    ] }, { env: api.env })
    expect(out.updated).toBe(true)
    const w = stored(id)
    expect(w.entries[0].sets.map(r => r.r)).toEqual([12, 12, 10, 8])
    expect(w.entries[1]).toMatchObject({ id: '0313', sets: [{ w: 10, r: 10, done: true }, { w: 10, r: 10, done: true }] })
    expect(w.vol).toBe(12 * 12 * 2 + 12 * 10 + 12 * 8 + 10 * 10 * 2)
  })

  test('weights in the other unit are converted, as log_workout converts them', async () => {
    const id = await withLogged()
    await addToWorkout.handler({ workout_id: id, unit: 'lb', add: [{ exercise: 1, sets: [{ reps: 5, weight: 22 }] }] }, { env: api.env })
    expect(stored(id).entries[0].sets[3].w).toBe(10)
  })

  test('an ambiguous name comes back as a problem with candidates, nothing saved', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await addToWorkout.handler({ workout_id: id, add: [{ name: 'hammer curl', sets: [{ reps: 10 }] }] }, { env: api.env })
    expect(out.updated).toBe(false)
    expect(JSON.stringify(out.problems)).toContain('candidates')
    expect(api.puts.length).toBe(puts)
  })

  test('exercise and name together are refused', async () => {
    const id = await withLogged()
    const out = await addToWorkout.handler({ workout_id: id, add: [{ exercise: 1, name: '0313', sets: [{ reps: 10 }] }] }, { env: api.env })
    expect(out.problem).toMatch(/not both/)
  })
})

describe('move_workout', () => {
  test('to another day, keeping its length, filed in date order', async () => {
    const id = await withLogged()
    await logWorkout.handler({ ...CURLS, date: '2026-10-21' }, { env: api.env })
    const before = stored(id)
    const out = await moveWorkout.handler({ workout_id: id, date: '2026-10-22', start: '07:30' }, { env: api.env })
    expect(out).toMatchObject({ moved: true, date: '2026-10-22', start: '07:30' })
    const after = stored(id)
    expect(after.end - after.start).toBe(before.end - before.start)
    expect(api.doc.workouts.map(w => w.d)).toEqual(['2026-10-21', '2026-10-22'])
  })

  test('a new duration moves the end, not the start', async () => {
    const id = await withLogged()
    const start = stored(id).start
    await moveWorkout.handler({ workout_id: id, duration_min: 75 }, { env: api.env })
    expect(stored(id)).toMatchObject({ start, end: start + 75 * 60000 })
  })

  test('a day in the future is refused', async () => {
    const id = await withLogged()
    const out = await moveWorkout.handler({ workout_id: id, date: '2999-01-01' }, { env: api.env })
    expect(out.moved).toBe(false)
    expect(stored(id).d).toBe('2026-10-20')
  })
})
const moveWorkout = moveWorkoutTool

describe('exclude_from_progression', () => {
  test('the whole session, and back', async () => {
    const id = await withLogged()
    await excludeFromProgression.handler({ workout_id: id, exclude: true }, { env: api.env })
    expect(stored(id).excludeFromProgression).toBe(true)
    expect(stored(id).entries[0].noProg).toBe(true)
    await excludeFromProgression.handler({ workout_id: id, exclude: false }, { env: api.env })
    expect(stored(id).excludeFromProgression).toBeUndefined()
    expect(stored(id).entries[0].noProg).toBeUndefined()
  })

  test('one entry only', async () => {
    const id = await withLogged()
    await addToWorkout.handler({ workout_id: id, add: [{ name: '0313', sets: [{ reps: 10, weight: 10 }] }] }, { env: api.env })
    const out = await excludeFromProgression.handler({ workout_id: id, exclude: true, exercise: 2 }, { env: api.env })
    expect(out.entries.map(e => e.counts_for_progression)).toEqual([true, false])
    expect(stored(id).excludeFromProgression).toBeUndefined()
  })

  test('asking for what already is saves nothing', async () => {
    const id = await withLogged()
    const puts = api.puts.length
    const out = await excludeFromProgression.handler({ workout_id: id, exclude: false }, { env: api.env })
    expect(out.updated).toBe(false)
    expect(api.puts.length).toBe(puts)
  })
})
