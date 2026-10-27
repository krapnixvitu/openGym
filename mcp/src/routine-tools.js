/* Routines: made, edited, copied and deleted as the Plan screen and the routine editor do
   (views/Plan.jsx, views/RoutineEdit.jsx, the exercise config sheet in sheets.jsx), with the app's
   own helpers (lib/routines.js, lib/history.js, lib/pyramid.js, lib/rep-range.js), through
   changeProfile like every write tool. Reading a routine back is get_routine; what it will open
   at is preview_session. */
import { z } from 'zod'
import { changeProfile } from './write-tools.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { copyRoutine, deleteRoutine, routineSnapshot, restoreRoutine, replaceSlotExercise } from '../../frontend/src/lib/routines.js'
import { pickedExerciseConfig, defaultConfig, modeOf, cleanupSg, pairAdjacent, unpairSuperset, exLine, MAX_PLANNED_WARMUPS, NOTE_MAX } from '../../frontend/src/lib/history.js'
import { normalizePyramid, PYRAMID_MAX, MAX_PYRAMID_SETS } from '../../frontend/src/lib/pyramid.js'
import { setSupersetMeta, SG_NAME_MAX } from '../../frontend/src/lib/superset-meta.js'
import { normalizeRepRange } from '../../frontend/src/lib/rep-range.js'
import { POLICIES, POLICIES_FOR, MAX_TRIPLE_SETS } from '../../frontend/src/lib/progression.js'
import { uid } from '../../frontend/src/lib/format.js'

// lib/glyphs.js DEFAULT_GLYPH, which a new routine gets on the Plan screen (glyphs.js imports the
// icon component, so the name is copied rather than imported).
const DEFAULT_GLYPH = 'figureStrength'
// The coach's own ceiling for one routine (api/coach/core/validate.js MAX_EX_PER_ROUTINE).
const MAX_EXERCISES = 20
const MAX_SETS = 10
const MAX_WEIGHT = { kg: 1000, lb: 2200 }

// What each routine looked like before this server last changed or deleted it, newest last, for
// restore_routine. Kept in memory: it covers changes made through these tools since the server
// started, which is what "undo that" means in a conversation.
const UNDO_MAX = 10
const undo = new Map()
const remember = (id, snap) => { if (snap) undo.set(id, [...(undo.get(id) || []), snap].slice(-UNDO_MAX)) }
export const _resetUndo = () => undo.clear()

// A routine without its sync stamps: what the user sees of it.
const bare = ({ _ts, _f, ...r }) => JSON.stringify(r)
const findRoutine = (S, id) => (S.routines || []).find(r => r?.id === id)
const noRoutine = id => ({ save: false, result: { updated: false, problem: `no routine with id ${id} (list_routines gives the ids)`, next: 'Nothing was saved.' } })
const problem = (text, extra = {}) => ({ save: false, result: { updated: false, problem: text, ...extra, next: 'Nothing was saved.' } })
const nameOf = (S, id) => resolveExercise(S, id).name || id

/** The routine the way the reply shows it: one line per exercise, in the app's own wording. */
function routineView(S, r) {
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  return {
    id: r.id,
    name: r.name,
    ...(r.prog ? { progression: r.prog } : {}),
    ...(r.excludeFromProgression === true ? { exclude_from_progression: true } : {}),
    exercises: (r.ex || []).map((e, i) => ({
      slot: i + 1,
      id: e.id,
      name: nameOf(S, e.id),
      plan: exLine(e, unit),
      ...(e.sg ? { superset: e.sg } : {}),
      ...(e.prog ? { progression: e.prog } : {}),
      ...(e.note ? { note: e.note } : {}),
    })),
  }
}

// The fields one exercise slot can be given, as the exercise config sheet offers them.
const slotFields = {
  sets: z.number().int().min(1).max(MAX_SETS).optional(),
  reps: z.number().int().min(1).max(100).optional().describe('Reps per set; the top of the range with reps_min.'),
  reps_min: z.number().int().min(1).max(100).nullable().optional().describe('Bottom of a rep range for double progression (8 with reps 12 is 8-12); null removes the range.'),
  sets_max: z.number().int().min(1).max(MAX_TRIPLE_SETS).nullable().optional().describe('Most sets for triple progression; null removes it.'),
  seconds: z.number().int().min(5).max(3600).optional().describe('Seconds per set, for a timed exercise (a plank).'),
  minutes: z.number().min(1).max(600).optional().describe('Minutes, for cardio.'),
  speed: z.number().min(0).max(50).optional().describe('Speed, for cardio, in the profile\'s speed unit.'),
  weight: z.number().min(0).optional().describe('Planned weight in the profile\'s unit (added weight for a bodyweight exercise).'),
  rest_sec: z.number().int().min(0).max(3600).nullable().optional().describe('This exercise\'s own rest: seconds, 0 for no timer, null to follow the app\'s rest timer.'),
  warmup_sets: z.number().int().min(0).max(MAX_PLANNED_WARMUPS).optional(),
  per_side: z.boolean().optional().describe('One arm or leg at a time: reps count both sides together (20 is 10 a side).'),
  progression: z.enum(POLICIES).nullable().optional().describe('This exercise\'s own progression rule; null follows the routine\'s.'),
  increment: z.number().positive().max(100).nullable().optional().describe('Its own weight step for progression; null uses the default.'),
  pyramid: z.array(z.union([z.number().int().min(1).max(100), z.literal(PYRAMID_MAX)])).max(MAX_PYRAMID_SETS).optional()
    .describe('A rep target per set, in order, "max" for as many as possible ([12, 10, 8, "max"]); [] goes back to sets x reps. A pyramid is never progressed.'),
  note: z.string().max(NOTE_MAX).optional().describe('A note shown with the exercise; "" removes it.'),
}

/**
 * `p`'s fields onto slot `e` (a routine exercise), in place, cleaned the way the config sheet
 * cleans them. A string when a field does not fit the slot's mode, and nothing is changed then.
 */
function applySlot(e, p, unit) {
  const mode = modeOf(e)
  const wrong = (field, want) => `${field} is for ${want}; this exercise is ${mode === 'reps' ? 'sets of reps' : mode === 'time' ? 'timed' : 'cardio'}`
  if (mode !== 'reps' && (p.reps != null || p.reps_min != null || p.sets_max != null || p.pyramid)) return wrong('reps', 'an exercise done in reps')
  if (mode !== 'time' && p.seconds != null) return wrong('seconds', 'a timed exercise')
  if (mode !== 'cardio' && (p.minutes != null || p.speed != null)) return wrong('minutes and speed', 'cardio')
  if (mode === 'cardio' && (p.weight != null || p.per_side != null || p.warmup_sets != null)) return 'weight, per_side and warm-ups are not for cardio'
  if (p.progression && !POLICIES_FOR[mode].includes(p.progression)) return `${p.progression} progression does not fit this exercise; it takes ${POLICIES_FOR[mode].join(', ')}`
  if (p.weight != null && p.weight > MAX_WEIGHT[unit]) return `weight over ${MAX_WEIGHT[unit]} ${unit}`

  if (p.sets != null) e.sets = p.sets
  if (p.seconds != null) e.sec = p.seconds
  if (p.minutes != null) e.min = p.minutes
  if (p.speed != null) e.speed = p.speed
  if (p.weight != null) e.weight = Math.round(p.weight * 100) / 100
  if (p.per_side != null) { if (p.per_side) e.side = true; else delete e.side }
  if (p.reps != null) e.reps = p.reps
  if (p.reps_min === null) delete e.repsMin
  else if (p.reps_min != null) e.repsMin = p.reps_min
  // A per-side target is stored even, and a range keeps its bottom under its top (the sheet).
  const stride = e.side ? 2 : 1
  if (mode === 'reps' && e.repsMin != null) Object.assign(e, normalizeRepRange(e.reps, e.repsMin, stride))
  else if (mode === 'reps' && e.reps != null && stride === 2) e.reps = Math.max(2, Math.ceil(e.reps / 2) * 2)
  if (p.sets_max === null) delete e.setsMax
  else if (p.sets_max != null) e.setsMax = Math.max(e.sets || 1, p.sets_max)
  if (p.pyramid) {
    const list = normalizePyramid(p.pyramid, stride)
    if (list.length) { e.pyramid = list; e.sets = list.length }
    else { delete e.pyramid; delete e.pyramidRest; delete e.pyramidWeight }
  }
  if (p.rest_sec === null) { delete e.restSec; delete e.restOff }
  else if (p.rest_sec === 0) { delete e.restSec; e.restOff = true }
  else if (p.rest_sec != null) { e.restSec = p.rest_sec; delete e.restOff }
  if (p.warmup_sets === 0) delete e.warmupSets
  else if (p.warmup_sets != null) e.warmupSets = p.warmup_sets
  if (p.progression === null) delete e.prog
  else if (p.progression) e.prog = p.progression
  if (p.increment === null) delete e.inc
  else if (p.increment != null) e.inc = p.increment
  if (p.note != null) { const n = p.note.trim(); if (n) e.note = n; else delete e.note }
  return null
}

/** A new slot for exercise reference `p.exercise`, or { problem, candidates }. */
function newSlot(S, p) {
  const match = resolveExercise(S, p.exercise)
  if (!match.id) return { problem: `${JSON.stringify(p.exercise)}: ${match.problem}`, candidates: match.candidates }
  // What an exercise picked in the routine editor starts with (RoutineEdit's quick add).
  const e = { id: match.id, ...(p.mode ? defaultConfig(match.id, p.mode) : pickedExerciseConfig(match.id)) }
  if (modeOf(e) === 'cardio') delete e.weight
  const bad = applySlot(e, p, S.unit === 'lb' ? 'lb' : 'kg')
  return bad ? { problem: `${match.name}: ${bad}` } : { slot: e }
}

const exerciseSchema = z.object({
  exercise: z.string().min(1).describe('A name ("dumbbell curl") or an id, from the library or the user\'s own exercises.'),
  mode: z.enum(['reps', 'time', 'cardio']).optional().describe('How it is logged; leave out for what the library says.'),
  ...slotFields,
})

export const createRoutine = {
  name: 'create_routine',
  description: [
    'Make a new routine, as Plan > New routine and the routine editor do: a name and its exercises in order, each with sets, reps (or seconds, or minutes for cardio), weight and the rest the config sheet offers.',
    'An exercise left without numbers starts as the app starts it (3 x 10). Put it on a weekday with assign_weekday. Call with dry_run: true first and show the user the routine.',
  ].join(' '),
  schema: {
    name: z.string().trim().min(1).max(60),
    progression: z.enum(POLICIES).optional().describe('The routine\'s progression rule; leave out for the app\'s default.'),
    exclude_from_progression: z.boolean().optional().describe('A rehab or mobility routine: its sessions never move the weights.'),
    exercises: z.array(exerciseSchema).max(MAX_EXERCISES).describe('In the order they are trained; [] makes an empty routine to fill later.'),
    supersets: z.array(z.array(z.number().int().min(1)).min(2)).optional().describe('Groups of adjacent exercise positions (1-based) done as supersets: [[2, 3]].'),
    dry_run: z.boolean().optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let made = null
    return changeProfile({ tool: 'create_routine', env, fetchImpl, dryRun: !!params.dry_run }, S => {
      if (!Array.isArray(S.routines)) S.routines = []
      const ex = []
      for (const p of params.exercises) {
        const got = newSlot(S, p)
        if (got.problem) return problem(got.problem, got.candidates ? { candidates: got.candidates } : {})
        ex.push(got.slot)
      }
      const bad = linkSupersets(ex, params.supersets || [])
      if (bad) return problem(bad)
      // Made once, so a retry after another device's write saves the same routine under the same id.
      made = made || uid()
      const r = { id: made, name: params.name, emoji: DEFAULT_GLYPH, ...(params.progression ? { prog: params.progression } : {}), ...(params.exclude_from_progression ? { excludeFromProgression: true } : {}), ex }
      if (params.dry_run) return { save: false, result: { created: false, dry_run: true, would_create: routineView(S, r) } }
      S.routines.push(r)
      return { result: { created: true, routine: routineView(S, r), next: 'Not on any weekday yet: assign_weekday puts it in the week.' }, trail: `routine ${r.id} created, ${ex.length} exercises` }
    })
  },
}

// Superset groups by 1-based position onto `ex`, in place. A string when one cannot be made.
function linkSupersets(ex, groups) {
  for (const g of groups) {
    const idx = [...new Set(g)].sort((a, b) => a - b).map(n => n - 1)
    if (idx.some(i => !ex[i])) return `superset ${JSON.stringify(g)} names a position the routine does not have`
    if (idx.some((i, k) => k && i !== idx[k - 1] + 1)) return `superset ${JSON.stringify(g)} must be next to each other`
    if (idx.some(i => modeOf(ex[i]) === 'cardio')) return 'cardio is not done in a superset'
    let next = ex
    for (let k = 1; k < idx.length; k++) next = pairAdjacent(next, idx[k - 1], idx[k])
    ex.splice(0, ex.length, ...next)
  }
  return null
}

const changeSchema = z.object({
  action: z.enum(['add', 'update', 'remove', 'replace', 'move', 'superset', 'unsuperset']),
  slot: z.number().int().min(1).optional().describe('The exercise\'s position (1-based), as get_routine numbers them. Not for add.'),
  exercise: z.string().min(1).optional().describe('add, replace: a name or id.'),
  mode: z.enum(['reps', 'time', 'cardio']).optional().describe('add: how it is logged, when not what the library says.'),
  position: z.number().int().min(1).optional().describe('add: where it goes (1-based); leave out for the end.'),
  to: z.number().int().min(1).optional().describe('move: the new position.'),
  superset_name: z.string().max(SG_NAME_MAX).optional().describe('superset: a name for the group.'),
  superset_rest_sec: z.number().int().min(0).max(3600).optional().describe('superset: rest after each round.'),
  ...slotFields,
})

/** One change from edit_routine onto routine `r`, in place. A string when it cannot be made. */
function applyChange(S, r, c) {
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const at = c.slot != null ? c.slot - 1 : null
  if (c.action !== 'add' && (at == null || !r.ex[at])) return `${c.action}: slot ${c.slot ?? '(missing)'} is not in the routine, which has ${r.ex.length}`
  switch (c.action) {
    case 'add': {
      if (!c.exercise) return 'add: name the exercise'
      if (r.ex.length >= MAX_EXERCISES) return `a routine holds at most ${MAX_EXERCISES} exercises`
      const got = newSlot(S, c)
      if (got.problem) return got
      r.ex.splice(c.position != null ? Math.min(c.position - 1, r.ex.length) : r.ex.length, 0, got.slot)
      cleanupSg(r.ex)
      return null
    }
    case 'update': {
      const e = { ...r.ex[at] }
      const bad = applySlot(e, c, unit)
      if (bad) return `slot ${c.slot}: ${bad}`
      r.ex[at] = e
      return null
    }
    case 'remove':
      r.ex.splice(at, 1)
      cleanupSg(r.ex)
      return null
    case 'replace': {
      if (!c.exercise) return 'replace: name the exercise to put in'
      const match = resolveExercise(S, c.exercise)
      if (!match.id) return { problem: `${JSON.stringify(c.exercise)}: ${match.problem}`, candidates: match.candidates }
      // The routine editor's Replace: sets, reps, rest and the rest of the slot stay (#110).
      const e = replaceSlotExercise(r.ex[at], match.id, S, r.id)
      const bad = applySlot(e, c, unit)
      if (bad) return `slot ${c.slot}: ${bad}`
      r.ex[at] = e
      cleanupSg(r.ex)
      return null
    }
    case 'move': {
      if (c.to == null) return 'move: give the new position, to'
      const [e] = r.ex.splice(at, 1)
      r.ex.splice(Math.min(c.to - 1, r.ex.length), 0, e)
      cleanupSg(r.ex)
      return null
    }
    case 'superset': {
      if (!r.ex[at + 1]) return `superset: slot ${c.slot} is the last one; it pairs with the exercise after it`
      if (modeOf(r.ex[at]) === 'cardio' || modeOf(r.ex[at + 1]) === 'cardio') return 'cardio is not done in a superset'
      r.ex = pairAdjacent(r.ex, at, at + 1)
      const sg = r.ex[at].sg
      if (c.superset_name != null || c.superset_rest_sec != null) setSupersetMeta(r.ex, sg, { name: c.superset_name ?? r.ex[at].sgName, rest: c.superset_rest_sec ?? r.ex[at].sgRest })
      cleanupSg(r.ex)
      return null
    }
    case 'unsuperset':
      if (!r.ex[at].sg) return `slot ${c.slot} is not in a superset`
      r.ex = unpairSuperset(r.ex, at)
      cleanupSg(r.ex)
      return null
  }
  return `unknown action ${c.action}`
}

export const editRoutine = {
  name: 'edit_routine',
  description: [
    'Change a routine, as the routine editor does: rename it, set its progression rule, and a list of changes made in order, each against the routine as the one before left it.',
    'add (an exercise, at a position), update (a slot\'s sets, reps, weight, rest, warm-ups, rep range, pyramid, note, progression), remove, replace (another exercise in the slot, keeping its sets, reps and rest), move (to another position), superset (a slot with the one after it), unsuperset.',
    'Slots are positions from get_routine, 1-based. Logged workouts are never changed. Call with dry_run: true first and show the user the result.',
    'A weight set here is where a new exercise starts, and where an exercise opens when its sets or reps change too; otherwise the progression rule and the last session decide. preview_session shows what the next session opens at.',
  ].join(' '),
  schema: {
    routine_id: z.string().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    progression: z.enum(POLICIES).nullable().optional().describe('The routine\'s progression rule; null for the app\'s default.'),
    exclude_from_progression: z.boolean().optional(),
    changes: z.array(changeSchema).max(25).optional(),
    dry_run: z.boolean().optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let before = null
    const out = await changeProfile({ tool: 'edit_routine', env, fetchImpl, dryRun: !!params.dry_run }, S => {
      const r = findRoutine(S, params.routine_id)
      if (!r) return noRoutine(params.routine_id)
      before = routineSnapshot(S, r.id)
      const was = JSON.stringify(r)
      const next = structuredClone(r)
      next.ex = Array.isArray(next.ex) ? next.ex : []
      if (params.name) next.name = params.name
      if (params.progression === null) delete next.prog
      else if (params.progression) next.prog = params.progression
      if (params.exclude_from_progression === true) next.excludeFromProgression = true
      else if (params.exclude_from_progression === false) delete next.excludeFromProgression
      for (const [i, c] of (params.changes || []).entries()) {
        const bad = applyChange(S, next, c)
        if (bad) return problem(`change ${i + 1}: ${typeof bad === 'string' ? bad : bad.problem}`, bad.candidates ? { candidates: bad.candidates } : {})
      }
      if (JSON.stringify(next) === was) return { save: false, result: { updated: false, message: 'That is how the routine already is; nothing changed.' } }
      if (params.dry_run) return { save: false, result: { updated: false, dry_run: true, would_be: routineView(S, next) } }
      Object.keys(r).forEach(k => delete r[k])
      Object.assign(r, next)
      return { result: { updated: true, routine: routineView(S, r), undo: 'restore_routine puts the routine back as it was.' }, trail: `routine ${r.id} edited` }
    })
    if (out.updated) remember(params.routine_id, before)
    return out
  },
}

export const deleteRoutineTool = {
  name: 'delete_routine',
  description: [
    'Delete a routine, as Plan does: it comes off every weekday and every rescheduled date that names it. Logged workouts stay.',
    'restore_routine puts it back, in its place and on its days. Confirm with the user first.',
  ].join(' '),
  schema: { routine_id: z.string().min(1) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let snap = null
    const out = await changeProfile({ tool: 'delete_routine', env, fetchImpl }, S => {
      if (!findRoutine(S, params.routine_id)) return noRoutine(params.routine_id)
      snap = routineSnapshot(S, params.routine_id)
      deleteRoutine(S, params.routine_id)
      return { result: { deleted: true, routine: snap.routine.name, undo: 'restore_routine puts it back.' }, trail: `routine ${params.routine_id} deleted` }
    })
    if (out.deleted) remember(params.routine_id, snap)
    return out
  },
}

export const duplicateRoutine = {
  name: 'duplicate_routine',
  description: 'Copy a routine, as Plan\'s Duplicate does: every exercise and its settings, under a new id, right after the original. The copy is on no weekday until assign_weekday puts it there.',
  schema: {
    routine_id: z.string().min(1),
    name: z.string().trim().min(1).max(60).optional().describe('The copy\'s name; leave out for "<name> (Copy)".'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let id = null
    return changeProfile({ tool: 'duplicate_routine', env, fetchImpl }, S => {
      const at = (S.routines || []).findIndex(r => r?.id === params.routine_id)
      if (at < 0) return noRoutine(params.routine_id)
      const copy = copyRoutine(S.routines[at])
      id = id || copy.id
      copy.id = id
      if (params.name) copy.name = params.name
      // The copy is a routine of its own: the original's sync stamps are not its history.
      delete copy._ts; delete copy._f
      S.routines.splice(at + 1, 0, copy)
      return { result: { created: true, routine: routineView(S, copy) }, trail: `routine ${params.routine_id} copied to ${id}` }
    })
  },
}

export const restoreRoutineTool = {
  name: 'restore_routine',
  description: 'Undo the last change these tools made to a routine: a deleted routine comes back in its place and on its days, an edited one goes back to how it was. It covers changes made through edit_routine and delete_routine since this server started, one step per call.',
  schema: { routine_id: z.string().min(1) },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const snap = (undo.get(params.routine_id) || []).at(-1)
    if (!snap) return { restored: false, problem: 'there is no change to that routine to undo since this server started', next: 'Nothing was saved. get_routine shows how it is now.' }
    const out = await changeProfile({ tool: 'restore_routine', env, fetchImpl }, S => {
      const r = findRoutine(S, params.routine_id)
      if (!r) {
        if (!restoreRoutine(S, snap)) return problem('the routine could not be put back')
      } else {
        if (bare(r) === bare(snap.routine)) return { save: false, result: { restored: false, message: 'The routine already is as it was; nothing changed.' } }
        // The content as it was, under the stamps it has now: sent back with its old stamps, the
        // server would read the fields as a copy from before the edit and keep the edit.
        const stamps = { _ts: r._ts, _f: r._f }
        Object.keys(r).forEach(k => delete r[k])
        Object.assign(r, structuredClone(snap.routine))
        for (const [k, v] of Object.entries(stamps)) { if (v === undefined) delete r[k]; else r[k] = v }
      }
      return { result: { restored: true, routine: routineView(S, findRoutine(S, params.routine_id)) }, trail: `routine ${params.routine_id} restored` }
    })
    if (out.restored) undo.get(params.routine_id).pop()
    return out
  },
}

export const ROUTINE_TOOLS = [createRoutine, editRoutine, deleteRoutineTool, duplicateRoutine, restoreRoutineTool]
