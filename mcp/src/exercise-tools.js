/* Exercises: finding them in the library, the person's own exercises, and what they keep about
   any exercise (a standing note, other names, a favourite, the bar it uses), written the way the
   app's sheets write them (sheets.jsx CustomExForm and deleteCustomEx, the exercise note sheet,
   components/ExerciseAliases.jsx, the bar picker) with lib/exercises.js, lib/muscles.js,
   lib/favourites.js, lib/exercise-aliases.js and lib/bar.js. */
import { z } from 'zod'
import { getState } from './state.js'
import { changeProfile } from './write-tools.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { allExercises, searchExercises, similarExercises, EXIDX, BODYPARTS, isCustomEx } from '../../frontend/src/lib/exercises.js'
import { sameMuscleFirst } from '../../frontend/src/lib/similar-exercises.js'
import { registerExerciseAliases, normalizeAliases, exerciseAliases } from '../../frontend/src/lib/exercise-aliases.js'
import { ALL_EQUIPMENT, exAvailable, activeProfile } from '../../frontend/src/lib/equipment.js'
import { MUSCLES, inMuscleOrder, exerciseMuscleSnapshot } from '../../frontend/src/lib/muscles.js'
import { isFav, toggleFav } from '../../frontend/src/lib/favourites.js'
import { barWeightFor, usesBar } from '../../frontend/src/lib/bar.js'
import { cleanupSg, NOTE_MAX } from '../../frontend/src/lib/history.js'
import { uid } from '../../frontend/src/lib/format.js'

const noState = () => ({ error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile' })
const nothing = (text, extra = {}) => ({ save: false, result: { updated: false, problem: text, ...extra, next: 'Nothing was saved.' } })
const customsOf = S => (Array.isArray(S.customEx) ? S.customEx : []).filter(c => c && c.id)

// The person's other names for catalogue exercises take part in a search, as the app registers
// them at load (useStore.js); here for the length of one synchronous search, then taken back, so
// no other profile's read sees them (tools.js withCustomsIndexed does the same for customs).
function withAliases(S, run) {
  registerExerciseAliases(S.exAliases || {})
  try { return run() } finally { registerExerciseAliases({}) }
}

/** One exercise the way a search answers with it. */
const row = (S, e) => ({
  id: e.id, name: e.n, body_part: e.bp || null, equipment: e.eq || null, target: e.tg || null,
  ...(isCustomEx(e) || e.custom ? { custom: true } : {}),
  ...(isFav(S, e.id) ? { favourite: true } : {}),
  ...(activeProfile(S) && !exAvailable(S, e) ? { not_in_equipment_in_use: true } : {}),
})

/** The exercise `ref` names, as an object from the library or the person's own, or a problem. */
function findExercise(S, ref) {
  const hit = resolveExercise(S, ref)
  if (!hit.id) return { problem: `${JSON.stringify(ref)}: ${hit.problem}`, candidates: hit.candidates }
  return { ex: customsOf(S).find(c => c.id === hit.id) || EXIDX[hit.id] }
}
const problemOf = got => nothing(got.problem, got.candidates ? { candidates: got.candidates } : {})

export const searchExercisesTool = {
  name: 'search_exercises',
  read: true,
  description: 'Search the exercise library (over 5,600 exercises) and the person\'s own, as the app\'s picker does: typos and abbreviations ("rdl", "db") are understood, and the person\'s favourites come first. Returns ids the other tools take. Filter by body part or equipment.',
  schema: {
    query: z.string().max(80).describe('Words of the name, the muscle or the equipment; "" lists by the filters alone.'),
    body_part: z.enum(BODYPARTS).optional(),
    equipment: z.enum(ALL_EQUIPMENT).optional(),
    limit: z.number().int().min(1).max(50).optional().describe('How many to return, 15 if left out.'),
  },
  handler: ({ query, body_part: bp, equipment: eq, limit = 15 }) => {
    const S = getState()
    if (!S) return noState()
    return withAliases(S, () => {
      const list = allExercises(S).filter(e => (!bp || e.bp === bp) && (!eq || e.eq === eq))
      const found = searchExercises(list, query)
      const fav = found.filter(e => isFav(S, e.id))
      const ordered = [...fav, ...found.filter(e => !isFav(S, e.id))]
      const out = { results: ordered.slice(0, limit).map(e => row(S, e)), total: found.length }
      // The app's "Similar exercises" under the results, so a search rarely ends on nothing.
      if (!found.length && query.trim()) out.similar = similarExercises(list, query, [], limit).map(e => row(S, e))
      return out
    })
  },
}

export const similarExercisesTool = {
  name: 'similar_exercises',
  read: true,
  description: 'Exercises that train the same main muscle as one exercise, those on the same equipment first: what the app offers when a machine is taken. With an equipment profile in use, those it cannot do are marked.',
  schema: {
    exercise: z.string().min(1).describe('A name or id.'),
    available_only: z.boolean().optional().describe('Only exercises the equipment profile in use can do.'),
    limit: z.number().int().min(1).max(50).optional(),
  },
  handler: ({ exercise, available_only: availableOnly, limit = 15 }) => {
    const S = getState()
    if (!S) return noState()
    const got = findExercise(S, exercise)
    if (got.problem) return { problem: got.problem, ...(got.candidates ? { candidates: got.candidates } : {}) }
    let list = sameMuscleFirst(allExercises(S), got.ex)
    if (availableOnly) list = list.filter(e => exAvailable(S, e))
    const fav = list.filter(e => isFav(S, e.id))
    list = [...fav, ...list.filter(e => !isFav(S, e.id))]
    return { exercise: row(S, got.ex), similar: list.slice(0, limit).map(e => row(S, e)), ...(list.length ? {} : { note: 'The exercise has no main muscle on record, so nothing is matched to it.' }) }
  },
}

const customFields = {
  name: z.string().trim().min(1).max(80).optional(),
  body_part: z.enum(BODYPARTS).optional(),
  equipment: z.enum(ALL_EQUIPMENT).optional(),
  primary_muscles: z.array(z.enum(MUSCLES)).max(6).optional().describe('The main muscles, the first being the one it targets.'),
  secondary_muscles: z.array(z.enum(MUSCLES)).max(10).optional(),
  description: z.string().max(1000).optional().describe('Setup and cues.'),
  other_names: z.array(z.string().max(80)).max(20).optional().describe('Other names it goes by, found by search.'),
}

/** The form's fields onto custom exercise `c`, in place, as CustomExForm saves them. */
function applyCustom(c, p) {
  if (p.name) c.n = p.name
  if (p.body_part) c.bp = p.body_part
  if (p.equipment) c.eq = p.equipment
  if (p.description != null) c.desc = p.description.trim().slice(0, 1000)
  if (p.other_names) c.aliases = normalizeAliases(p.other_names)
  if (p.primary_muscles || p.secondary_muscles || p.body_part) {
    const first = p.primary_muscles?.[0]
    const prim = c.bp === 'cardio' ? ['cardiovascular system'] : inMuscleOrder(p.primary_muscles || c.primaries || [])
    const sm = inMuscleOrder((p.secondary_muscles || c.secondaries || []).filter(m => !prim.includes(m)))
    // The target is the primary named first, or the one it had while that is still a primary.
    c.tg = first && prim.includes(first) ? first : prim.includes(c.tg) ? c.tg : (prim[0] || '')
    c.primaries = prim
    c.secondaries = sm
    c.sm = sm
    c.muscleGroups = [...prim, ...sm]
  }
}

// The form's own check: no two exercises under one name, the person's or the library's.
const nameTaken = (S, name, selfId) => allExercises(S).find(e => e.n.toLowerCase() === name.toLowerCase() && e.id !== selfId)

export const createCustomExercise = {
  name: 'create_custom_exercise',
  description: 'Make the person\'s own exercise, as the app\'s "Create your own exercise" does, when the library has nothing that fits (check search_exercises first): a name, a body part, its equipment, and optionally its muscles, a description and other names. It then works like any other exercise.',
  schema: { ...customFields, name: z.string().trim().min(1).max(80), body_part: z.enum(BODYPARTS), equipment: z.enum(ALL_EQUIPMENT) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let id = null
    return changeProfile({ tool: 'create_custom_exercise', env, fetchImpl }, S => {
      const dup = nameTaken(S, params.name)
      if (dup) return nothing(`"${dup.n}" already exists (id ${dup.id})`)
      id = id || 'c' + uid()
      const c = { id, n: params.name, bp: params.body_part, desc: '', tg: '', sm: [], muscleGroups: [], primaries: [], secondaries: [], eq: params.equipment, custom: true, aliases: [] }
      applyCustom(c, params)
      S.customEx = Array.isArray(S.customEx) ? S.customEx : []
      S.customEx.push(c)
      return { result: { created: true, exercise: row(S, c) }, trail: `custom exercise ${id} created` }
    })
  },
}

export const editCustomExercise = {
  name: 'edit_custom_exercise',
  description: 'Change one of the person\'s own exercises, as its edit form does: name, body part, equipment, muscles, description, other names. Library exercises cannot be changed; use set_exercise_note or set_alias on them.',
  schema: { exercise_id: z.string().min(1), ...customFields },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'edit_custom_exercise', env, fetchImpl }, S => {
      const c = customsOf(S).find(x => x.id === params.exercise_id)
      if (!c) return nothing(`no exercise of the person's own with id ${params.exercise_id}`)
      if (params.name && params.name.toLowerCase() !== String(c.n || '').trim().toLowerCase()) {
        const dup = nameTaken(S, params.name, c.id)
        if (dup) return nothing(`"${dup.n}" already exists (id ${dup.id})`)
      }
      const before = JSON.stringify(c)
      applyCustom(c, params)
      if (JSON.stringify(c) === before) return { save: false, result: { updated: false, message: 'The exercise already is that way; nothing changed.' } }
      return { result: { updated: true, exercise: row(S, c) }, trail: `custom exercise ${c.id} edited` }
    })
  },
}

export const deleteCustomExercise = {
  name: 'delete_custom_exercise',
  description: 'Delete one of the person\'s own exercises, as the app does: it leaves every routine; logged workouts keep their sets under its name. Confirm with the person first.',
  schema: { exercise_id: z.string().min(1) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'delete_custom_exercise', env, fetchImpl }, S => {
      const ex = customsOf(S).find(x => x.id === params.exercise_id)
      if (!ex) return nothing(`no exercise of the person's own with id ${params.exercise_id}`)
      if (S.active?.entries?.some(e => e.id === ex.id)) return nothing('a workout running on a device has this exercise; it can be deleted once that workout is finished')
      // sheets.jsx deleteCustomEx: history keeps the name and muscles, everything else lets go.
      const snapshot = exerciseMuscleSnapshot(ex)
      for (const w of S.workouts || []) for (const e of w.entries || []) {
        if (e.id !== ex.id) continue
        e.n = ex.n
        if (!e.muscleSnapshot || !Object.keys(e.muscleSnapshot).length) e.muscleSnapshot = snapshot
      }
      S.customEx = (S.customEx || []).filter(x => x?.id !== ex.id)
      const inRoutines = (S.routines || []).filter(r => (r.ex || []).some(e => e.id === ex.id)).map(r => r.name)
      for (const r of S.routines || []) { r.ex = (r.ex || []).filter(e => e.id !== ex.id); cleanupSg(r.ex) }
      if (S.exWeights) delete S.exWeights[ex.id]
      S.favEx = (S.favEx || []).filter(id => id !== ex.id)
      return { result: { deleted: true, exercise: ex.n, ...(inRoutines.length ? { removed_from_routines: inRoutines } : {}) }, trail: `custom exercise ${ex.id} deleted` }
    })
  },
}

export const setExerciseNote = {
  name: 'set_exercise_note',
  description: 'A standing note on an exercise, shown every time it comes up in a workout, as the app\'s "Always show" note: machine settings ("seat 4, pin 7"), cues. "" removes it.',
  schema: { exercise: z.string().min(1), note: z.string().max(NOTE_MAX) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'set_exercise_note', env, fetchImpl }, S => {
      const got = findExercise(S, params.exercise)
      if (got.problem) return problemOf(got)
      const note = params.note.trim().slice(0, NOTE_MAX)
      S.exNotes = S.exNotes && typeof S.exNotes === 'object' ? S.exNotes : {}
      if ((S.exNotes[got.ex.id] || '') === note) return { save: false, result: { updated: false, message: 'The note already says that; nothing changed.' } }
      if (note) S.exNotes[got.ex.id] = note
      else delete S.exNotes[got.ex.id]
      return { result: { updated: true, exercise: got.ex.n, note: note || null }, trail: `note on ${got.ex.id}` }
    })
  },
}

export const setAlias = {
  name: 'set_alias',
  description: 'The other names an exercise goes by for this person ("RDL", the name their gym uses), which search then finds, as the app\'s "Other names" does. The list replaces the ones it had; [] removes them.',
  schema: { exercise: z.string().min(1), names: z.array(z.string().max(80)).max(20) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'set_alias', env, fetchImpl }, S => {
      const got = findExercise(S, params.exercise)
      if (got.problem) return problemOf(got)
      const names = normalizeAliases(params.names)
      // components/ExerciseAliases.jsx: on the person's own exercise, in the library's map otherwise.
      const own = customsOf(S).find(c => c.id === got.ex.id)
      if (JSON.stringify(exerciseAliases(own || got.ex, S.exAliases || {})) === JSON.stringify(names)) return { save: false, result: { updated: false, message: 'It already has those names; nothing changed.' } }
      if (own) own.aliases = names
      else S.exAliases = { ...(S.exAliases || {}), [got.ex.id]: names }
      return { result: { updated: true, exercise: got.ex.n, other_names: names }, trail: `other names for ${got.ex.id}` }
    })
  },
}

export const favouriteExercise = {
  name: 'favourite_exercise',
  description: 'Mark an exercise as a favourite, or not, as the star in the app does. Favourites come first in the picker, the library and search.',
  schema: { exercise: z.string().min(1), favourite: z.boolean() },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'favourite_exercise', env, fetchImpl }, S => {
      const got = findExercise(S, params.exercise)
      if (got.problem) return problemOf(got)
      if (isFav(S, got.ex.id) === params.favourite) return { save: false, result: { updated: false, message: `It already ${params.favourite ? 'is' : 'is not'} a favourite; nothing changed.` } }
      toggleFav(S, got.ex.id)
      return { result: { updated: true, exercise: got.ex.n, favourite: params.favourite }, trail: `favourite ${got.ex.id} ${params.favourite}` }
    })
  },
}

export const setBarWeight = {
  name: 'set_bar_weight',
  description: 'The bar one barbell exercise is loaded on, in the profile\'s unit, as the app\'s bar picker sets it: a lighter bar (15), 0 for no bar (a counterbalanced Smith machine), or null to follow the bar type\'s weight. Plate maths and drop sets start from it.',
  schema: { exercise: z.string().min(1), weight: z.number().min(0).max(100).nullable() },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'set_bar_weight', env, fetchImpl }, S => {
      const got = findExercise(S, params.exercise)
      if (got.problem) return problemOf(got)
      if (!usesBar(got.ex)) return nothing(`${got.ex.n} is not done on a bar`)
      const before = JSON.stringify(S.barWeights?.[got.ex.id] ?? null)
      S.barWeights = S.barWeights && typeof S.barWeights === 'object' ? S.barWeights : {}
      // A stored 0 is "no bar"; no key at all follows the bar type (lib/bar.js isNoBar).
      if (params.weight == null) delete S.barWeights[got.ex.id]
      else S.barWeights[got.ex.id] = Math.round(params.weight * 100) / 100
      if (JSON.stringify(S.barWeights[got.ex.id] ?? null) === before) return { save: false, result: { updated: false, message: 'The bar already is that; nothing changed.' } }
      return { result: { updated: true, exercise: got.ex.n, bar: barWeightFor(S, got.ex), unit: S.unit === 'lb' ? 'lb' : 'kg' }, trail: `bar for ${got.ex.id}` }
    })
  },
}

export const EXERCISE_TOOLS = [searchExercisesTool, similarExercisesTool, createCustomExercise, editCustomExercise, deleteCustomExercise, setExerciseNote, setAlias, favouriteExercise, setBarWeight]
