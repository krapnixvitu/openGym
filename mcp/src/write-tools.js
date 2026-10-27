/* The write tools. log_workout files a session the user describes ("dumbbell curls, 12 kg,
   12/12/10, last set to failure") into their history, through their own openGym server
   (api-client.js), as if it had been logged on the phone: every device shows it within the
   half minute they poll the revision.

   The language is the LLM's job and the arithmetic is the lib's (frontend/src/lib/log-workout.js):
   the client turns what was said into exercises and sets, and this builds, checks and files them.
   What the lib will not guess at — a name the library spells twice, an exercise the user has not
   made yet — comes back as `problems` with candidates, for the LLM to put to the user. */
import { z } from 'zod'
import { isoDate, entryView, withCustomsIndexed } from './tools.js'
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'
import { buildLoggedWorkout, appendLoggedWorkout, findDuplicate, resolveExercise, BODY_PARTS, LOG_LIMITS } from '../../frontend/src/lib/log-workout.js'
import { editCompletedSession, saveWorkoutEdit, deleteEditedWorkout } from '../../frontend/src/lib/session-edit.js'
import { friendlyDuration } from './labels.js'
import { modeOf } from '../../frontend/src/lib/history.js'
import { moveWorkout, setWorkoutDuration, startTimeOf, durationMinOf, endsInFuture, MAX_DURATION_MIN } from '../../frontend/src/lib/workout-date.js'
import { setSessionNoProg, setEntryNoProg } from '../../frontend/src/lib/session-noprog.js'

export const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
// Two writers racing the same profile resolve in a round or two; past that something keeps
// writing, and the user is better told than retried at.
const MAX_ATTEMPTS = 3
// Saves per hour, per MCP process. Logging a week someone forgot is a handful; a client looping on
// the tool is not, and each save is a full profile write on the server that every device pulls.
export const WRITE_LIMIT = 20
const WINDOW_MS = 60 * 60000
let saves = []
export const _resetWriteWindow = () => { saves = [] }

export function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// The tool's snake_case parameters as the lib's description.
const inputOf = p => ({
  date: p.date,
  start: p.start,
  durationMin: p.duration_min,
  name: p.name,
  note: p.note,
  unit: p.unit,
  exercises: (p.exercises || []).map(ex => ({
    exercise: ex.exercise,
    createCustom: ex.create_custom,
    bodyPart: ex.body_part,
    note: ex.note,
    sets: (ex.sets || []).map(s => ({ reps: s.reps, seconds: s.seconds, weight: s.weight, warmup: s.warmup, failure: s.failure, rir: s.rir, rpe: s.rpe })),
  })),
})

// What was (or would be) saved, read back the way get_workout reads a session, so the user can
// check it in the words the app uses ("12 × 12 kg", "1:00").
function viewOf(w, S, resolved) {
  const withCustoms = { ...S, customEx: [...(S.customEx || []), ...resolved.customEx] }
  return {
    workout_id: w.id,
    date: w.d,
    start: hhmm(w.start),
    duration: w.end > w.start ? friendlyDuration(w.end - w.start) : null,
    name: w.name,
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    volume: w.vol,
    ...(w.note ? { note: w.note } : {}),
    prs: (w.prs || []).map(id => resolved.resolved.find(r => r.id === id)?.name || id),
    exercises: w.entries.map(e => {
      const v = entryView(e, withCustoms)
      const r = resolved.resolved.find(x => x.id === e.id)
      return {
        id: e.id,
        name: v.name,
        ...(r?.input !== undefined && r.input !== v.name ? { you_said: r.input } : {}),
        ...(r?.created ? { new_custom_exercise: true } : {}),
        ...(r?.weightMeans ? { weight_means: r.weightMeans === 'each' ? 'per dumbbell' : 'both dumbbells together' } : {}),
        // The numbers spelled out next to the app's own label ("12×10 F": 12 kg, 10 reps, to
        // failure), so reading it back to the user cannot swap the weight and the reps.
        sets: e.sets.map((row, i) => ({
          label: v.sets[i].label,
          weight: Number(row.w) || 0,
          ...(row.sec != null ? { seconds: row.sec } : { reps: row.r }),
          ...(row.phase === 'warmup' ? { warmup: true } : {}),
          ...(row.failure ? { failure: true } : {}),
          ...(row.rir != null ? { rir: row.rir } : {}),
          ...(row.rpe != null ? { rpe: row.rpe } : {}),
        })),
        ...(e.note ? { note: e.note } : {}),
      }
    }),
  }
}

/**
 * One change to the profile, saved the way a device saves it: GET /api/data, `change` edits a copy,
 * PUT it with the revision it was read at, and on a 409 run `change` again on the document the
 * server sent back, so another device's write in between is kept. Every write tool goes through
 * here; none writes the state file.
 *
 * `change(S)` edits S in place and returns { result, trail } (trail: the operator's stderr line),
 * or { save: false, result } to answer without writing (a dry run, a problem to put to the user).
 * Resolves `result` plus the revision it landed at, or the no-save result as it is.
 */
export async function changeProfile({ tool, env = process.env, fetchImpl, now = Date.now(), dryRun = false }, change) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}
  saves = saves.filter(t => now - t < WINDOW_MS)
  if (!dryRun && saves.length >= WRITE_LIMIT) {
    throw fail('ERATE', `the openGym tools already saved ${WRITE_LIMIT} changes in the last hour, the most they take in one go; nothing was saved. Wait a bit, or make the rest in the app.`)
  }

  const me = await apiFetch(cfg, '/api/me', opts)
  const uid = me.body?.user?.id
  // A guard that cannot read whose token this is refuses rather than steps aside.
  if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'the openGym server did not say which profile OPENGYM_TOKEN belongs to (GET /api/me); nothing was saved')
  const local = localUid()
  if (local && local !== uid) {
    // The ids go to the operator on stderr, not into the model's context (state.js ambiguousUid).
    console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
    throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads: pair again from the right profile, or set OPENGYM_UID to match (the ids are on the server\'s stderr)')
  }

  let got = await apiFetch(cfg, '/api/data', opts)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const doc = got.body?.state
    if (!doc || typeof doc !== 'object') {
      throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
    }
    // The document exactly as the server sent it, plus the change: anything else in the PUT (a
    // default filled in here) would be stamped as an edit made now and land on every device.
    const S = structuredClone(doc)
    const out = change(S)
    if (out.save === false) return out.result
    const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
    if (put.status !== 409) {
      invalidate()
      saves.push(now)
      // The operator's trail: what changed and at which revision. Never the token, and nothing
      // the model sees.
      console.error(`[opengym-mcp] ${tool} ${out.trail}, rev ${put.body?.rev ?? '?'}`)
      return { ...out.result, revision: put.body?.rev ?? null }
    }
    // A 409 without the current document (a proxy's page) is not something to build on.
    if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
      throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
    }
    got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
  }
  throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was saved, try again in a moment`)
}

const setSchema = z.object({
  reps: z.number().int().min(1).max(LOG_LIMITS.maxReps).optional().describe('Reps done. Give reps for a rep exercise, or seconds for a hold, never both in one exercise.'),
  seconds: z.number().min(1).max(LOG_LIMITS.maxSec).optional().describe('Seconds held, for a timed exercise (plank, hang, wall sit).'),
  weight: z.number().min(0).optional().describe('Load in `unit`. Omit or 0 for bodyweight. On an assistance machine it is the help (less is better). For dumbbells: as the profile logs that exercise (see weight_means in the reply).'),
  warmup: z.boolean().optional().describe('A warm-up set: kept out of volume, PRs and the next suggested weight.'),
  failure: z.boolean().optional().describe('Taken to failure.'),
  rir: z.number().min(0).max(10).optional().describe('Reps in reserve, if the user said it. Not with rpe.'),
  rpe: z.number().min(6).max(10).optional().describe('RPE, if the user said it. Not with rir.'),
})

export const logWorkout = {
  name: 'log_workout',
  description: [
    'Log a workout the user describes into their openGym history (it syncs to all their devices). Turn what they said into exercises and one entry per set:',
    '"curls, 12 kg, 12/12/10" is three sets of {reps, weight: 12}; "3 sets of 12, except the last was 10" is 12, 12, 10.',
    'Ask instead of assuming when the weight, the number of sets or the reps are unclear.',
    'Exercises are matched against the user\'s library by name or id. A common name resolves to the library\'s default variant ("shoulder press" is the barbell one): when the reply\'s `name` differs from `you_said` and the variant matters (dumbbell vs barbell, machine vs cable), confirm with the user, or pass an id. If a name matches several exercises, or none, nothing is saved and `problems` lists candidates: ask the user which one, then call again with its id.',
    'Only set create_custom for an exercise the user confirms is not in the library.',
    'Call with dry_run: true first when you had to interpret anything, show the user the preview, and log it once they agree.',
    'Calling again with the same description does not log it twice. Cardio (time and speed) and supersets are not supported here.',
  ].join(' '),
  schema: {
    date: isoDate().optional().describe('YYYY-MM-DD the session was done; defaults to today. Not in the future.'),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 h').optional().describe('Start time HH:MM, if the user said it. Without it a session logged today ends now; one in the past starts at 18:00.'),
    duration_min: z.number().min(1).max(LOG_LIMITS.maxDurationMin).optional().describe('How long the session took, in minutes, if known.'),
    name: z.string().max(80).optional().describe('A name for the session, e.g. "Arms" or "Push day". Defaults to "Workout".'),
    note: z.string().max(500).optional().describe('A note on the whole session.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave weights in; defaults to the profile\'s. Converted when it differs.'),
    exercises: z.array(z.object({
      exercise: z.string().min(1).max(120).describe('Exercise name as the user said it ("dumbbell curl"), or an exercise id from an earlier answer.'),
      create_custom: z.boolean().optional().describe('Create this as the user\'s own exercise when the library has nothing matching. Only after the user confirms.'),
      body_part: z.enum(BODY_PARTS).optional().describe('Body part of a new custom exercise, when its name does not say.'),
      note: z.string().max(280).optional().describe('A note on this exercise today.'),
      sets: z.array(setSchema).min(1).max(LOG_LIMITS.maxSets),
    })).min(1).max(LOG_LIMITS.maxExercises),
    dry_run: z.boolean().optional().describe('Build and return the preview without saving anything.'),
    allow_duplicate: z.boolean().optional().describe('Log it even though the same sets are already logged that day (a genuine second session). Give it a different start or name too.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    // One clock for every attempt: a retry after a conflict files the same workout, not a later one.
    const now = Date.now()
    const input = inputOf({ ...params, date: params.date || localIso(new Date(now)) })
    // A description without a unit is in the profile's, as the profile was when first read: a
    // retry after another device switched kg <-> lb reads the same numbers the same way.
    let unit = null, meanings = null
    return changeProfile({ tool: 'log_workout', env, fetchImpl, now, dryRun: !!params.dry_run }, S => {
      unit = unit || (S.unit === 'lb' ? 'lb' : 'kg')
      // The profile's own exercises indexed for the build, as the app has them: a custom one-arm
      // dumbbell press counts one bell, a custom assisted machine folds towards less help.
      const built = withCustomsIndexed(S, () => buildLoggedWorkout(S, input, { now, unit, meanings }))
      if (built.problems) {
        return { save: false, result: { logged: false, problems: built.problems, next: 'Nothing was saved. Settle these with the user (pick a candidate id, fix a set) and call again.' } }
      }
      // What each dumbbell weight meant on the first read stays what it means on a retry.
      meanings = meanings || Object.fromEntries(built.workout.entries.map(e => [e.id, e.target?.dbLoad || 'as']))
      if (params.dry_run) {
        const dup = findDuplicate(S, built.workout)
        return { save: false, result: { logged: false, dry_run: true, would_log: viewOf(built.workout, S, built), ...(dup && (dup.sameRequest || !params.allow_duplicate) ? { duplicate_of: dup.workout.id } : {}) } }
      }
      const added = withCustomsIndexed({ customEx: [...(S.customEx || []), ...built.customEx] }, () =>
        appendLoggedWorkout(S, built, { now, allowDuplicate: params.allow_duplicate === true }))
      if (!added.added) {
        return { save: false, result: { logged: false, duplicate: true, workout_id: added.workout.id, date: added.workout.d, message: 'This session is already in the history; nothing was added. If it really was a second session, call again with allow_duplicate: true and a different start or name.' } }
      }
      const sets = added.workout.entries.reduce((n, e) => n + e.sets.length, 0)
      return {
        result: { logged: true, ...viewOf(added.workout, S, built) },
        trail: `saved ${added.workout.id} for ${added.workout.d} (${added.workout.entries.length} exercises, ${sets} sets)`,
      }
    })
  },
}

// The app's own editor run on the profile (frontend/src/lib/session-edit.js), so a correction
// lands as an edit made in History does: the volume, the PR badges of the sessions around it and a
// kept working weight that came from it are worked out again, and the record is stamped so the
// sync keeps the newest edit. editCompletedSession opens a copy as S.active, and S.active is also
// where a phone keeps a session it is running: that one is set aside meanwhile and put back.
function inEditor(S, workoutId, fn) {
  const had = Object.hasOwn(S, 'active'), running = S.active
  S.active = null
  try {
    try { editCompletedSession(S, workoutId) } catch { throw fail('ENOENT', `no workout with id ${workoutId} (list_workouts gives the ids)`) }
    return fn(S.active)
  } finally {
    if (had) S.active = running
    else delete S.active
  }
}

const editSchema = z.object({
  exercise: z.number().int().min(1).describe('Which exercise: its position in get_workout\'s `entries`, from 1.'),
  set: z.number().int().min(1).describe('Which set of that exercise, from 1, as get_workout lists them.'),
  remove: z.boolean().optional().describe('Take this set out. Nothing else may be given with it.'),
  weight: z.number().min(0).max(LOG_LIMITS.maxKg).optional().describe('The load, in the profile\'s unit (get_workout\'s `unit`), as get_workout shows it (`w`).'),
  reps: z.number().int().min(1).max(LOG_LIMITS.maxReps).optional(),
  seconds: z.number().min(1).max(LOG_LIMITS.maxSec).optional().describe('For a timed set only.'),
  warmup: z.boolean().optional(),
  failure: z.boolean().optional(),
})

// One set as get_workout reads it back, with the numbers spelled out.
const setView = row => ({
  weight: Number(row.w) || 0,
  ...(row.sec != null ? { seconds: row.sec } : { reps: Number(row.r) || 0 }),
  ...(row.phase === 'warmup' ? { warmup: true } : {}),
  ...(row.failure ? { failure: true } : {}),
})

// Applies the edits to the editor's copy; a string is the problem to put to the user.
function applyEdits(active, edits) {
  const entries = active.entries || []
  for (const ed of edits) {
    const entry = entries[ed.exercise - 1]
    if (!entry) return `exercise ${ed.exercise}: the workout has ${entries.length}`
    const row = (entry.sets || [])[ed.set - 1]
    if (!row) return `exercise ${ed.exercise}, set ${ed.set}: that exercise has ${(entry.sets || []).length} sets`
    if (row.sides) return `exercise ${ed.exercise}, set ${ed.set}: a set logged per side is edited in the app`
    if (ed.remove) {
      if (Object.keys(ed).some(k => !['exercise', 'set', 'remove'].includes(k))) return `exercise ${ed.exercise}, set ${ed.set}: remove takes nothing else`
      continue
    }
    if (ed.weight != null) row.w = ed.weight
    if (ed.reps != null) { if (row.sec != null) return `exercise ${ed.exercise}, set ${ed.set}: a timed set takes seconds, not reps`; row.r = ed.reps }
    if (ed.seconds != null) { if (row.sec == null) return `exercise ${ed.exercise}, set ${ed.set}: a rep set takes reps, not seconds`; row.sec = ed.seconds }
    if (ed.warmup === true) row.phase = 'warmup'
    if (ed.warmup === false && row.phase === 'warmup') delete row.phase
    if (ed.failure != null) { if (ed.failure) row.failure = true; else delete row.failure }
    if (row.phase === 'warmup' && row.failure) return `exercise ${ed.exercise}, set ${ed.set}: a warm-up set is not taken to failure`
  }
  // Removals last, by position as given, so the numbers in one call all mean the sets as listed.
  const gone = new Set(edits.filter(e => e.remove).map(e => `${e.exercise}:${e.set}`))
  entries.forEach((entry, i) => { entry.sets = (entry.sets || []).filter((_, j) => !gone.has(`${i + 1}:${j + 1}`)) })
  return null
}

export const updateWorkout = {
  name: 'update_workout',
  description: [
    'Correct a workout already in the user\'s history: change a set\'s weight, reps or seconds, mark it warm-up or to failure, take sets out, or change the session note.',
    'Call get_workout first: exercises and sets are numbered as it lists them, from 1, and weights are in its `unit`.',
    'Volume, PR badges and the next suggested weight are worked out again, as an edit in the app does. Taking out every set is not an edit: use delete_workout.',
    'Call with dry_run: true first, show the user the result, and save once they agree.',
  ].join(' '),
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
    sets: z.array(editSchema).max(LOG_LIMITS.maxSets).optional(),
    note: z.string().max(500).optional().describe('The session note; an empty string clears it.'),
    dry_run: z.boolean().optional().describe('Work out the result and return it without saving.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    if (!params.sets?.length && params.note === undefined) throw fail('EINVAL', 'nothing to change: give sets, a note, or both')
    return changeProfile({ tool: 'update_workout', env, fetchImpl, dryRun: !!params.dry_run }, S => {
      let problem = null, saved = null
      inEditor(S, params.workout_id, active => {
        problem = applyEdits(active, params.sets || [])
        if (problem) return
        if (params.note !== undefined) active.note = params.note
        if (!active.entries.some(e => e.sets.length)) { problem = 'that takes out every set: delete the workout instead (delete_workout)'; return }
        saved = saveWorkoutEdit(S)
      })
      if (problem) return { save: false, result: { updated: false, problem, next: 'Nothing was saved. Check get_workout and call again.' } }
      const view = { workout_id: saved.id, date: saved.d, volume: saved.vol, ...(saved.note ? { note: saved.note } : {}), exercises: saved.entries.map(e => ({ id: e.id, sets: e.sets.map(setView) })) }
      if (params.dry_run) return { save: false, result: { updated: false, dry_run: true, would_save: view } }
      return { result: { updated: true, ...view }, trail: `updated ${saved.id} of ${saved.d}` }
    })
  },
}

export const deleteWorkout = {
  name: 'delete_workout',
  description: 'Delete a workout from the user\'s history, on every device, as History\'s Delete does (a duplicate, a session logged by mistake). It cannot be undone from here: confirm with the user which one first, naming its date and exercises from get_workout.',
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'delete_workout', env, fetchImpl }, S => {
      let gone = null
      inEditor(S, params.workout_id, active => {
        gone = { id: active.editingWorkoutId, d: active.d }
        deleteEditedWorkout(S)
      })
      return { result: { deleted: true, workout_id: gone.id, date: gone.d }, trail: `deleted ${gone.id} of ${gone.d}` }
    })
  },
}

export const swapExercise = {
  name: 'swap_exercise',
  description: [
    'Change which exercise one entry of a logged workout was, keeping its sets: "that was the dumbbell shoulder press, not the barbell one".',
    'Call get_workout first: `exercise` is the entry\'s position in its `entries`, from 1. `to` is a name or an exercise id, matched as log_workout matches them; several or no matches come back as candidates to put to the user.',
    'PR badges and next weights are worked out again for both exercises. A timed exercise only swaps with another timed one, a rep exercise with a rep one.',
    'Call with dry_run: true first when the match is not exactly what the user said.',
  ].join(' '),
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
    exercise: z.number().int().min(1).describe('Which entry: its position in get_workout\'s `entries`, from 1.'),
    to: z.string().min(1).max(120).describe('The exercise it really was: a name, or an exercise id from an earlier answer.'),
    dry_run: z.boolean().optional().describe('Show the match and the result without saving.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'swap_exercise', env, fetchImpl, dryRun: !!params.dry_run }, S => {
      let problem = null, saved = null, from = null, to = null
      withCustomsIndexed(S, () => inEditor(S, params.workout_id, active => {
        const entry = (active.entries || [])[params.exercise - 1]
        if (!entry) { problem = { problem: `exercise ${params.exercise}: the workout has ${(active.entries || []).length}` }; return }
        const match = resolveExercise(S, params.to)
        if (match.problem) { problem = match; return }
        from = { id: entry.id, name: entryView(entry, S).name }
        to = { id: match.id, name: match.name }
        if (match.id === entry.id) { problem = { problem: `exercise ${params.exercise} already is ${match.name}` }; return }
        // Reps or seconds is the entry's own setting (its target), and stays with it. Cardio
        // (time and speed) is the exercise's, and its sets mean something else entirely.
        const wasCardio = modeOf({ ...(entry.target || {}), id: entry.id }) === 'cardio'
        if (wasCardio !== (modeOf({ id: match.id }) === 'cardio')) {
          problem = { problem: `${from.name} and ${match.name} are not logged the same way (one is cardio): fix it in the app instead` }
          return
        }
        entry.id = match.id
        // What belonged to the old exercise: the muscles it worked and what its routine planned.
        delete entry.muscleSnapshot
        delete entry.planned
        saved = saveWorkoutEdit(S)
      }))
      if (problem) return { save: false, result: { swapped: false, ...problem, next: 'Nothing was saved. Settle this with the user and call again.' } }
      const view = { workout_id: saved.id, date: saved.d, exercise: params.exercise, from, to, sets: saved.entries[params.exercise - 1]?.sets.map(setView) }
      if (params.dry_run) return { save: false, result: { swapped: false, dry_run: true, would_save: view } }
      return { result: { swapped: true, ...view }, trail: `swapped exercise ${params.exercise} of ${saved.id} to ${to.id}` }
    })
  },
}

export const addToWorkout = {
  name: 'add_to_workout',
  description: [
    'Add to a workout already in the history: sets the user forgot to an exercise in it, or an exercise they forgot entirely.',
    'Call get_workout first. To add sets to an exercise that is there, give `exercise` as its position in get_workout\'s `entries` (from 1); to add an exercise, give `name` (matched as log_workout matches it).',
    'Sets are described as for log_workout, in `unit` (default the profile\'s). Volume, PR badges and next weights are worked out again.',
    'Call with dry_run: true first when you had to interpret anything.',
  ].join(' '),
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
    add: z.array(z.object({
      exercise: z.number().int().min(1).optional().describe('Add sets to this entry: its position in get_workout\'s `entries`, from 1.'),
      name: z.string().min(1).max(120).optional().describe('Or add an exercise not in the workout: a name or an exercise id.'),
      create_custom: z.boolean().optional().describe('Create `name` as the user\'s own exercise when the library has nothing matching. Only after the user confirms.'),
      body_part: z.enum(BODY_PARTS).optional(),
      sets: z.array(setSchema).min(1).max(LOG_LIMITS.maxSets),
    })).min(1).max(LOG_LIMITS.maxExercises),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave weights in; defaults to the profile\'s. Converted when it differs.'),
    dry_run: z.boolean().optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const now = Date.now()
    let unit = null
    return changeProfile({ tool: 'add_to_workout', env, fetchImpl, now, dryRun: !!params.dry_run }, S => {
      unit = unit || params.unit || (S.unit === 'lb' ? 'lb' : 'kg')
      const w = (S.workouts || []).find(x => x?.id === params.workout_id)
      if (!w) throw fail('ENOENT', `no workout with id ${params.workout_id} (list_workouts gives the ids)`)
      const bad = params.add.findIndex(a => (a.exercise == null) === (a.name == null))
      if (bad >= 0) return { save: false, result: { updated: false, problem: `add ${bad + 1}: give either exercise (an entry's position) or name, not both`, next: 'Nothing was saved.' } }
      const missing = params.add.find(a => a.exercise != null && !w.entries?.[a.exercise - 1])
      if (missing) return { save: false, result: { updated: false, problem: `exercise ${missing.exercise}: the workout has ${(w.entries || []).length}`, next: 'Nothing was saved.' } }
      // The rows are built the way log_workout builds them (matching, units, dumbbell meaning,
      // limits), as a workout of their own on that day, then moved into the record.
      const meanings = Object.fromEntries((w.entries || []).map(e => [e.id, e.target?.dbLoad || 'as']))
      const input = {
        date: w.d,
        exercises: params.add.map(a => ({
          exercise: a.exercise != null ? w.entries[a.exercise - 1].id : a.name,
          createCustom: a.create_custom, bodyPart: a.body_part,
          sets: a.sets.map(x => ({ reps: x.reps, seconds: x.seconds, weight: x.weight, warmup: x.warmup, failure: x.failure, rir: x.rir, rpe: x.rpe })),
        })),
      }
      const built = withCustomsIndexed(S, () => buildLoggedWorkout(S, input, { now, unit, meanings }))
      if (built.problems) return { save: false, result: { updated: false, problems: built.problems.filter(p => p.field !== 'start' && p.field !== 'durationMin'), next: 'Nothing was saved. Settle these with the user and call again.' } }
      let saved = null
      withCustomsIndexed({ customEx: [...(S.customEx || []), ...built.customEx] }, () => inEditor(S, params.workout_id, active => {
        params.add.forEach((a, i) => {
          const entry = built.workout.entries[i]
          if (a.exercise != null) active.entries[a.exercise - 1].sets.push(...entry.sets)
          else active.entries.push(entry)
        })
        if (built.customEx.length) {
          const known = new Set((S.customEx || []).map(c => c?.id))
          S.customEx = [...(S.customEx || []), ...built.customEx.filter(c => !known.has(c.id))]
        }
        saved = saveWorkoutEdit(S, now)
      }))
      const view = { workout_id: saved.id, date: saved.d, volume: saved.vol, exercises: saved.entries.map(e => ({ id: e.id, name: entryView(e, S).name, sets: e.sets.map(setView) })) }
      if (params.dry_run) return { save: false, result: { updated: false, dry_run: true, would_save: view } }
      return { result: { updated: true, ...view }, trail: `added to ${saved.id} of ${saved.d}` }
    })
  },
}

export const moveWorkoutTool = {
  name: 'move_workout',
  description: [
    'Change when a workout in the history happened: its date, its start time, or how long it took (the session nobody ended until they got home).',
    'A new date or start keeps its length, and PR badges are worked out again in the new order. It cannot end later than now.',
    'Times are the MCP server\'s local time, as get_workout and log_workout report them.',
  ].join(' '),
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
    date: isoDate().optional().describe('The day it really was, YYYY-MM-DD, up to today.'),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 h').optional().describe('The start time, HH:MM.'),
    duration_min: z.number().int().min(1).max(MAX_DURATION_MIN).optional().describe('How long it took, in minutes.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    if (params.date == null && params.start == null && params.duration_min == null) throw fail('EINVAL', 'nothing to change: give date, start, duration_min, or several')
    const now = Date.now()
    return changeProfile({ tool: 'move_workout', env, fetchImpl, now }, S => {
      const w = (S.workouts || []).find(x => x?.id === params.workout_id)
      if (!w) throw fail('ENOENT', `no workout with id ${params.workout_id} (list_workouts gives the ids)`)
      const date = params.date ?? w.d, time = params.start ?? startTimeOf(w), minutes = params.duration_min ?? durationMinOf(w)
      const refuse = problem => ({ save: false, result: { moved: false, problem, next: 'Nothing was saved.' } })
      if (date > localIso(new Date(now))) return refuse('that day is in the future: pick a day up to today')
      if (endsInFuture(date, time, minutes, now)) return refuse('the session would still be going on now: pick an earlier start or a shorter duration')
      let workouts = S.workouts
      if (date !== w.d || time !== startTimeOf(w)) workouts = moveWorkout(workouts, w, date, time, now) || workouts
      if (params.duration_min != null) {
        const cur = workouts.find(x => x?.id === params.workout_id)
        workouts = setWorkoutDuration(workouts, cur, minutes, now) || workouts
      }
      if (workouts === S.workouts) return { save: false, result: { moved: false, message: 'It already is on that day, at that time, that long; nothing changed.' } }
      S.workouts = workouts
      const after = workouts.find(x => x?.id === params.workout_id)
      return {
        result: { moved: true, workout_id: after.id, date: after.d, start: startTimeOf(after), duration: friendlyDuration(after.end - after.start) },
        trail: `moved ${after.id} to ${after.d} ${startTimeOf(after)}, ${durationMinOf(after)} min`,
      }
    })
  },
}

export const excludeFromProgression = {
  name: 'exclude_from_progression',
  description: [
    'Keep a workout in the history out of progression, or count it again: an injury day or a deload whose light weights should not set the next session\'s targets.',
    'The workout still counts in history, stats and the muscle map. Without `exercise` it applies to the whole session; with it, to that one entry (its position in get_workout\'s `entries`, from 1).',
    'A deload or rehab routine keeps its own exercises out whatever this says.',
  ].join(' '),
  schema: {
    workout_id: z.string().min(1).describe('The id from list_workouts or get_workout.'),
    exclude: z.boolean().describe('true keeps it out, false counts it again.'),
    exercise: z.number().int().min(1).optional().describe('Only this entry, by position from 1.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'exclude_from_progression', env, fetchImpl }, S => {
      // As the workout screen decides it (Workout.jsx routineKeepsOut): the routine's own setting.
      const routineOwns = e => !!e?.rid && (S.routines || []).some(r => r?.id === e.rid && r.excludeFromProgression === true)
      let problem = null, saved = null, unchanged = false
      inEditor(S, params.workout_id, active => {
        if (params.exercise != null) {
          if (!active.entries[params.exercise - 1]) { problem = `exercise ${params.exercise}: the workout has ${active.entries.length}`; return }
          setEntryNoProg(active, params.exercise - 1, params.exclude)
        } else setSessionNoProg(active, params.exclude, routineOwns)
        // Compared on the flags themselves: a save would also tidy fields an import left out, and
        // stamp the record for nothing.
        const flags = entries => (entries || []).map(e => e?.noProg === true)
        const before = (S.workouts || []).find(x => x?.id === params.workout_id)
        if (JSON.stringify(flags(before.entries)) === JSON.stringify(flags(active.entries))) { unchanged = true; return }
        saved = saveWorkoutEdit(S)
      })
      if (problem) return { save: false, result: { updated: false, problem, next: 'Nothing was saved.' } }
      if (unchanged) return { save: false, result: { updated: false, message: 'It already was that way; nothing changed.' } }
      const out = saved.entries.map((e, i) => ({ exercise: i + 1, id: e.id, counts_for_progression: e.noProg !== true }))
      return { result: { updated: true, workout_id: saved.id, date: saved.d, entries: out }, trail: `${params.exclude ? 'excluded' : 'counted'} ${params.exercise != null ? 'exercise ' + params.exercise + ' of ' : ''}${saved.id}` }
    })
  },
}

export const WRITE_TOOLS = [logWorkout, updateWorkout, deleteWorkout, swapExercise, addToWorkout, moveWorkoutTool, excludeFromProgression]
