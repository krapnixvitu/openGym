// The equipment tools: the writes against a stand-in for the api (support/stub-api.js), the read
// against a data folder, as the read tools are tested.
import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubApi } from './support/stub-api.js'
import { saveEquipmentProfile, deleteEquipmentProfile, setActiveEquipment } from '../src/equipment-tools.js'
import { _resetWriteWindow } from '../src/write-tools.js'

let api
afterEach(() => api?.server.close())
beforeEach(() => _resetWriteWindow())
const HOME = { id: 'eqhome', name: 'Home', equipment: ['dumbbell', 'bench'], accV: 2 }
const GYM = { id: 'eqgym', name: 'Gym', equipment: ['barbell', 'dumbbell', 'cable', 'bench', 'pull-up bar'], accV: 2 }
const DOC = () => ({ unit: 'kg', routines: [], workouts: [], equipProfiles: [structuredClone(HOME), structuredClone(GYM)], activeEquipId: 'eqgym', equipFilterOn: false, _wid: 'w-1' })
const run = (tool, params) => tool.handler(params, { env: api.env })
const prof = id => api.doc.equipProfiles.find(p => p.id === id)

describe('save_equipment_profile', () => {
  test('a new profile, as the sheet saves one; the first one made is the one in use', async () => {
    api = await stubApi({ ...DOC(), equipProfiles: [], activeEquipId: null })
    const out = await run(saveEquipmentProfile, { name: 'Hotel', equipment: ['dumbbell', 'band'] })
    expect(out.updated).toBe(true)
    const p = api.doc.equipProfiles[0]
    expect(p).toMatchObject({ name: 'Hotel', equipment: ['dumbbell', 'band'], accV: 2 })
    expect(p.id).toMatch(/^eq/)
    expect(api.doc.activeEquipId).toBe(p.id)
  })

  test('changing one: add and remove, or the whole list', async () => {
    api = await stubApi(DOC())
    await run(saveEquipmentProfile, { profile_id: 'eqhome', add: ['kettlebell'], remove: ['bench'] })
    expect(prof('eqhome').equipment).toEqual(['dumbbell', 'kettlebell'])
    await run(saveEquipmentProfile, { profile_id: 'eqhome', name: 'Flat', equipment: ['band'] })
    expect(prof('eqhome')).toMatchObject({ name: 'Flat', equipment: ['band'] })
  })

  test('an old profile reads with the accessories it was given, and saving keeps them', async () => {
    api = await stubApi({ ...DOC(), equipProfiles: [{ id: 'eqold', name: 'Old', equipment: ['barbell'] }] })
    await run(saveEquipmentProfile, { profile_id: 'eqold', add: ['cable'] })
    expect(prof('eqold')).toMatchObject({ equipment: ['barbell', 'bench', 'pull-up bar', 'cable'], accV: 2 })
  })

  test('a name already taken, an unknown id, or nothing changed saves nothing', async () => {
    api = await stubApi(DOC())
    expect((await run(saveEquipmentProfile, { name: 'home' })).problem).toMatch(/already/)
    expect((await run(saveEquipmentProfile, { profile_id: 'nope', add: ['band'] })).problem).toMatch(/nope/)
    expect((await run(saveEquipmentProfile, { profile_id: 'eqhome', add: ['dumbbell'] })).updated).toBe(false)
    expect(api.puts).toHaveLength(0)
  })
})

describe('set_active_equipment and delete_equipment_profile', () => {
  test('a profile in use turns the filter on; null turns it off', async () => {
    api = await stubApi(DOC())
    const out = await run(setActiveEquipment, { profile_id: 'eqhome' })
    expect(out.in_use).toMatchObject({ name: 'Home', in_use: true })
    expect(api.doc).toMatchObject({ activeEquipId: 'eqhome', equipFilterOn: true })
    expect((await run(setActiveEquipment, { profile_id: null })).in_use).toBe('everything (no filter)')
    expect(api.doc.equipFilterOn).toBe(false)
  })

  test('deleting the profile in use hands over to the next one', async () => {
    api = await stubApi(DOC())
    await run(deleteEquipmentProfile, { profile_id: 'eqgym' })
    expect(api.doc.equipProfiles.map(p => p.id)).toEqual(['eqhome'])
    expect(api.doc.activeEquipId).toBe('eqhome')
  })
})

describe('each profile is a gym with its own plates (#808)', () => {
  const PL = n => ({ kg: { 20: { n, _ts: 1 } } })
  const GYMS = () => ({ ...DOC(), equipProfiles: [{ ...structuredClone(HOME), plates: PL(1) }, { ...structuredClone(GYM), plates: PL(8) }], plates: PL(8), invGym: 'eqgym' })

  test('switching brings that gym\'s plates into use, and hands the other ones back', async () => {
    api = await stubApi(GYMS())
    await run(setActiveEquipment, { profile_id: 'eqhome' })
    expect(api.doc).toMatchObject({ activeEquipId: 'eqhome', invGym: 'eqhome', equipFilterOn: true })
    expect(api.doc.plates.kg[20].n).toBe(1)
    expect(prof('eqgym').plates.kg[20].n).toBe(8)
  })

  test('deleting the gym in use loads the next one\'s plates', async () => {
    api = await stubApi(GYMS())
    await run(deleteEquipmentProfile, { profile_id: 'eqgym' })
    expect(api.doc).toMatchObject({ activeEquipId: 'eqhome', invGym: 'eqhome' })
    expect(api.doc.plates.kg[20].n).toBe(1)
  })

  test('a new gym starts with the lists in use, as the app makes one', async () => {
    api = await stubApi(GYMS())
    await run(saveEquipmentProfile, { name: 'Hotel', equipment: ['dumbbell'] })
    expect(api.doc.equipProfiles.find(p => p.name === 'Hotel').plates.kg[20].n).toBe(8)
  })
})

describe('list_equipment_profiles', () => {
  const dirs = []
  afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
  afterEach(() => vi.unstubAllEnvs())
  test('the profiles, which is in use, and the names a profile can hold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-equip-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'alex', name: 'Alex' }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dir, 'state-alex.json'), JSON.stringify({ ...DOC(), equipFilterOn: true }))
    vi.resetModules()
    vi.stubEnv('OPENGYM_DATA', dir)
    vi.stubEnv('OPENGYM_UID', 'alex')
    const { listEquipmentProfiles } = await import('../src/equipment-tools.js')
    const out = listEquipmentProfiles.handler({})
    expect(out.in_use).toBe('Gym')
    expect(out.profiles.map(p => [p.name, p.in_use])).toEqual([['Home', false], ['Gym', true]])
    expect(out.equipment_names).toEqual(expect.arrayContaining(['barbell', 'bench', 'pull-up bar']))
  })
})
