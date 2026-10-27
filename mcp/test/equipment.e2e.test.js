// The equipment tools against the real api (support/real-api.js): stored as the app stores them,
// and a deleted profile on record so no device brings it back.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { HAVE_API, realApi } from './support/real-api.js'
import { saveEquipmentProfile, deleteEquipmentProfile, setActiveEquipment } from '../src/equipment-tools.js'

const DOC = { unit: 'kg', routines: [], week: {}, workouts: [], bodyweight: [], equipProfiles: [{ id: 'eqgym', name: 'Gym', equipment: ['barbell'], accV: 2, _ts: 1000 }], activeEquipId: 'eqgym', deleted: {}, edited: {}, _rev: 5, _wid: 'w-seed', _ts: 1000 }

describe.skipIf(!HAVE_API)('equipment against the real api', () => {
  let api
  beforeAll(async () => { api = await realApi(DOC) }, 30000)
  afterAll(() => api?.stop())

  test('a new profile put in use, and the old one deleted', async () => {
    const made = await saveEquipmentProfile.handler({ name: 'Home', equipment: ['dumbbell', 'bench'] }, { env: api.env })
    await setActiveEquipment.handler({ profile_id: made.profile.id }, { env: api.env })
    await deleteEquipmentProfile.handler({ profile_id: 'eqgym' }, { env: api.env })
    const s = api.stored()
    expect(s.equipProfiles.map(p => p.name)).toEqual(['Home'])
    expect(s).toMatchObject({ activeEquipId: made.profile.id, equipFilterOn: true })
    expect(s.deleted.equipProfiles.eqgym).toBeGreaterThan(0)
  })
})
