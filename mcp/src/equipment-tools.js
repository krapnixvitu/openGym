/* Equipment profiles: "Home", "Gym", each a checklist of what is there, and which one is in use,
   made and switched the way Settings > Equipment and its profile sheet do (lib/equipment.js).
   With a profile in use and the filter on, the library and the picker show only what it has, and
   a routine's exercises that need something else are flagged. */
import { z } from 'zod'
import { getState } from './state.js'
import { changeProfile } from './write-tools.js'
import { ALL_EQUIPMENT, ACC_V, profileEquipment, newProfile, activeProfile } from '../../frontend/src/lib/equipment.js'
import { ownsNoDumbbells } from '../../frontend/src/lib/dumbbells.js'

const nothing = text => ({ save: false, result: { updated: false, problem: text, next: 'Nothing was saved.' } })
const profilesOf = S => (Array.isArray(S.equipProfiles) ? S.equipProfiles : []).filter(p => p && p.id)
const inUse = S => activeProfile(S)?.id || null
const view = (S, p) => ({ id: p.id, name: p.name, equipment: profileEquipment(p), in_use: inUse(S) === p.id })

export const listEquipmentProfiles = {
  name: 'list_equipment_profiles',
  // A read: index.js brings the profile up to date first, as for the read tools in tools.js.
  read: true,
  description: 'The equipment profiles saved in Settings > Equipment ("Home", "Gym"), what each has, and which one is in use, if any. With one in use the app shows only exercises it can do. Also lists every equipment name a profile can hold.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return { error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile' }
    const p = activeProfile(S)
    return {
      profiles: profilesOf(S).map(x => view(S, x)),
      in_use: p ? p.name : 'everything (no filter)',
      ...(ownsNoDumbbells(S) ? { owns_no_dumbbells: true } : {}),
      equipment_names: ALL_EQUIPMENT,
    }
  },
}

const equipmentName = z.enum(ALL_EQUIPMENT)

export const saveEquipmentProfile = {
  name: 'save_equipment_profile',
  description: [
    'Make an equipment profile or change one, as Settings > Equipment does: a name and the equipment that place has (names from list_equipment_profiles; body weight exercises are always shown).',
    'For an existing profile, equipment replaces its list, or add and remove change it. The first profile made is the one in use.',
  ].join(' '),
  schema: {
    profile_id: z.string().min(1).optional().describe('The profile to change; leave out to make a new one.'),
    name: z.string().trim().min(1).max(40).optional(),
    equipment: z.array(equipmentName).optional(),
    add: z.array(equipmentName).optional(),
    remove: z.array(equipmentName).optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const { profile_id: id, name, equipment, add = [], remove = [] } = params
    if (!id && !name) return { updated: false, problem: 'a new profile needs a name' }
    if (equipment && (add.length || remove.length)) return { updated: false, problem: 'give the whole list (equipment) or the changes (add, remove), not both' }
    let made = null
    return changeProfile({ tool: 'save_equipment_profile', env, fetchImpl }, S => {
      S.equipProfiles = Array.isArray(S.equipProfiles) ? S.equipProfiles : []
      let p = id ? S.equipProfiles.find(x => x?.id === id) : null
      if (id && !p) return nothing(`no equipment profile with id ${id} (list_equipment_profiles gives the ids)`)
      if (!p && S.equipProfiles.some(x => (x?.name || '').toLowerCase() === name.toLowerCase())) return nothing(`there already is a profile called ${name}; pass its profile_id to change it`)
      const before = JSON.stringify(p)
      const base = p ? profileEquipment(p) : []
      const list = equipment || [...base.filter(e => !remove.includes(e)), ...add]
      if (!p) {
        // Made once, so a retry after another device's write saves it under the same id.
        made = made || newProfile(name)
        p = { ...made }
        S.equipProfiles.push(p)
        if (!S.activeEquipId) S.activeEquipId = p.id
      }
      // As the profile sheet saves: the name, the ticked list, and the checklist version it saw.
      if (name) p.name = name
      p.equipment = [...new Set(list)]
      p.accV = ACC_V
      if (JSON.stringify(p) === before) return { save: false, result: { updated: false, message: 'The profile already is that way; nothing changed.' } }
      return { result: { updated: true, profile: view(S, p) }, trail: `equipment profile ${p.id} saved, ${p.equipment.length} items` }
    })
  },
}

export const deleteEquipmentProfile = {
  name: 'delete_equipment_profile',
  description: 'Delete an equipment profile, as Settings > Equipment does. If it was in use, the next profile takes its place. Confirm with the user first.',
  schema: { profile_id: z.string().min(1) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'delete_equipment_profile', env, fetchImpl }, S => {
      const p = profilesOf(S).find(x => x.id === params.profile_id)
      if (!p) return nothing(`no equipment profile with id ${params.profile_id} (list_equipment_profiles gives the ids)`)
      S.equipProfiles = S.equipProfiles.filter(x => x?.id !== p.id)
      if (S.activeEquipId === p.id) S.activeEquipId = (S.equipProfiles[0] && S.equipProfiles[0].id) || null
      const now = activeProfile(S)
      return { result: { deleted: true, profile: p.name, in_use: now ? now.name : 'everything (no filter)' }, trail: `equipment profile ${p.id} deleted` }
    })
  },
}

export const setActiveEquipment = {
  name: 'set_active_equipment',
  description: [
    'Choose where the person trains now ("only dumbbells at home today"): the equipment profile in use, with the filter on, as Settings > Equipment does. Then the app shows only exercises that profile has.',
    'profile_id null turns the filter off, so everything shows again. Check routines against it with get_routine and the exercises\' equipment.',
  ].join(' '),
  schema: { profile_id: z.string().min(1).nullable() },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'set_active_equipment', env, fetchImpl }, S => {
      const id = params.profile_id
      const before = JSON.stringify([S.activeEquipId ?? null, !!S.equipFilterOn])
      if (id == null) S.equipFilterOn = false
      else {
        const p = profilesOf(S).find(x => x.id === id)
        if (!p) return nothing(`no equipment profile with id ${id} (list_equipment_profiles gives the ids)`)
        S.activeEquipId = p.id
        S.equipFilterOn = true
      }
      if (JSON.stringify([S.activeEquipId ?? null, !!S.equipFilterOn]) === before) return { save: false, result: { updated: false, message: 'That already is the profile in use; nothing changed.' } }
      const now = activeProfile(S)
      return { result: { updated: true, in_use: now ? view(S, now) : 'everything (no filter)' }, trail: `equipment in use: ${id ?? 'none'}` }
    })
  },
}

export const EQUIPMENT_TOOLS = [listEquipmentProfiles, saveEquipmentProfile, deleteEquipmentProfile, setActiveEquipment]
