// update_settings against the real api (support/real-api.js): the settings stored and stamped, so
// a phone that has not seen the change does not undo it.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { updateSettings } from '../src/settings-tools.js'

const DOC = { unit: 'kg', restSec: 90, routines: [], week: {}, workouts: [], bodyweight: [], deleted: {}, edited: { restSec: 900 }, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('settings against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('stored, and stamped newer than the last device change', async () => {
    await updateSettings.handler({ rest_sec: 150, effort: 'rir' }, { env: api.env })
    const s = api.stored()
    expect(s).toMatchObject({ restSec: 150, effort: 'rir' })
    expect(s.edited.restSec).toBeGreaterThan(900)
    expect(s.edited.effort).toBeGreaterThan(0)
  })
})
