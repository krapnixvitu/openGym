// The measurement tools against the real api (support/real-api.js): a check-in stored as the app
// stores it, and a deleted day on record so no device brings it back.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { addMeasurements, deleteMeasurements } from '../src/measurement-tools.js'

const DOC = { unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], measurements: [{ d: '2026-10-01', t: 1000, waist: 84, other: [] }], deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('measurements against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('a reading added to a day, and another day deleted', async () => {
    await addMeasurements.handler({ date: '2026-10-08', values: { waist: 83 } }, { env: api.env })
    await deleteMeasurements.handler({ date: '2026-10-01' }, { env: api.env })
    const s = api.stored()
    expect(s.measurements.map(e => [e.d, e.waist])).toEqual([['2026-10-08', 83]])
    expect(s.deleted.measurements['2026-10-01']).toBeGreaterThan(0)
  })
})
