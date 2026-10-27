// The exercise tools against the real api (support/real-api.js): stored as the app stores them,
// stamped for the sync, and a deleted exercise on record so no device brings it back.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { createCustomExercise, deleteCustomExercise, setExerciseNote, favouriteExercise } from '../src/exercise-tools.js'

const DOC = { unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], customEx: [], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('exercises against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('an exercise of one\'s own made, noted, starred and deleted', async () => {
    const made = await createCustomExercise.handler({ name: 'Sled push', body_part: 'upper legs', equipment: 'sled machine' }, { env: api.env })
    const id = made.exercise.id
    await setExerciseNote.handler({ exercise: id, note: 'low handles' }, { env: api.env })
    await favouriteExercise.handler({ exercise: id, favourite: true }, { env: api.env })
    let s = api.stored()
    expect(s.customEx.map(c => c.n)).toEqual(['Sled push'])
    expect(s.exNotes[id]).toBe('low handles')
    expect(s.favEx).toEqual([id])
    expect(s.edited[`exNotes.${id}`]).toBeGreaterThan(0)
    await deleteCustomExercise.handler({ exercise_id: id }, { env: api.env })
    s = api.stored()
    expect(s.customEx).toEqual([])
    expect(s.deleted.customEx[id]).toBeGreaterThan(0)
  })
})
