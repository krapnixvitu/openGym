/* Progression rules: the rule a routine follows, and an exercise's own rule, weight step and
   deload factor, set the way the routine editor and the exercise config sheet set them, for one
   routine or for every routine that has the exercise. Which rule is in force is
   lib/progression.js policyFor, the same reading the app makes; what the next session opens at
   is preview_session. */
import { z } from 'zod'
import { changeProfile } from './write-tools.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { modeOf } from '../../frontend/src/lib/history.js'
import { isPyramid } from '../../frontend/src/lib/pyramid.js'
import { POLICIES, POLICIES_FOR, POLICY_NAME, policyFor, DELOAD_FACTOR_MIN, DELOAD_FACTOR_MAX } from '../../frontend/src/lib/progression.js'

const problem = text => ({ save: false, result: { updated: false, problem: text, next: 'Nothing was saved.' } })

export const setProgression = {
  name: 'set_progression',
  description: [
    'Set how weights and reps move from session to session: a routine\'s rule (every exercise without its own follows it), or one exercise\'s own rule, weight step and deload factor, in one routine or in every routine that has it.',
    'Rules: off (targets stay), linear (all reps: weight up), greyskull, double (climb a rep range, then weight up; needs a range, reps_min in edit_routine), triple (reps, then sets, then weight), time (holds get longer). null goes back to following the routine, or for a routine to the app\'s default (linear).',
    'This decides future sessions only; preview_session shows what the next one opens at.',
  ].join(' '),
  schema: {
    routine_id: z.string().min(1).optional().describe('The routine; leave out with exercise to change it in every routine.'),
    exercise: z.string().min(1).optional().describe('An exercise name or id; leave out to set the routine\'s own rule.'),
    rule: z.enum(POLICIES).nullable().optional(),
    increment: z.number().positive().max(100).nullable().optional().describe('The exercise\'s weight step in the profile\'s unit (seconds for a timed one); null for the default.'),
    deload_factor: z.number().min(DELOAD_FACTOR_MIN).max(DELOAD_FACTOR_MAX).nullable().optional().describe('How far a deload takes the estimated max, 0.9 being 90 %; null for the default.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const { routine_id: rid, exercise, rule, increment, deload_factor: factor } = params
    if (rule === undefined && increment === undefined && factor === undefined) return { updated: false, problem: 'give a rule, an increment or a deload_factor' }
    if (!rid && !exercise) return { updated: false, problem: 'name a routine_id, an exercise, or both' }
    if (!exercise && (increment !== undefined || factor !== undefined)) return { updated: false, problem: 'increment and deload_factor belong to an exercise; name it' }
    return changeProfile({ tool: 'set_progression', env, fetchImpl }, S => {
      const routines = (S.routines || []).filter(r => r && (!rid || r.id === rid))
      if (rid && !routines.length) return problem(`no routine with id ${rid} (list_routines gives the ids)`)
      const before = JSON.stringify(routines)

      if (!exercise) {
        const r = routines[0]
        if (rule === null) delete r.prog
        else r.prog = rule
        if (JSON.stringify(routines) === before) return { save: false, result: { updated: false, message: 'The routine already follows that rule; nothing changed.' } }
        return { result: { updated: true, routine: r.name, rule: r.prog || null, rule_name: POLICY_NAME[policyFor(null, r, 'reps')], note: 'Exercises with their own rule keep it.' }, trail: `routine ${r.id} rule ${r.prog || 'default'}` }
      }

      const match = resolveExercise(S, exercise)
      if (!match.id) return { save: false, result: { updated: false, problem: `${JSON.stringify(exercise)}: ${match.problem}`, candidates: match.candidates, next: 'Nothing was saved.' } }
      const slots = []
      for (const r of routines) (r.ex || []).forEach((e, i) => { if (e?.id === match.id) slots.push({ r, e, i }) })
      if (!slots.length) return problem(`${match.name} is in ${rid ? 'that routine' : 'no routine'}`)
      const skipped = []
      for (const { r, e, i } of slots) {
        const mode = modeOf(e)
        // A pyramid is never progressed (policyFor); its rule would sit there doing nothing.
        if (rule && rule !== 'off' && isPyramid(e)) { skipped.push({ routine: r.name, slot: i + 1, why: 'pyramid sets are never progressed' }); continue }
        if (rule && !POLICIES_FOR[mode].includes(rule)) return problem(`${rule} does not fit ${match.name} in ${r.name}, which takes ${POLICIES_FOR[mode].join(', ')}`)
        if (rule === null) delete e.prog
        else if (rule) e.prog = rule
        if (increment === null) delete e.inc
        else if (increment != null) e.inc = increment
        // The sheet leaves the default out of a saved config (0.9), so a plan file keeps its shape.
        if (factor === null || factor === 0.9) delete e.deloadFactor
        else if (factor != null) e.deloadFactor = factor
      }
      if (JSON.stringify(routines) === before) return { save: false, result: { updated: false, message: 'That is how it already is; nothing changed.', ...(skipped.length ? { skipped } : {}) } }
      const now = slots.filter(s => !skipped.some(k => k.routine === s.r.name && k.slot === s.i + 1)).map(({ r, e, i }) => ({
        routine: r.name, slot: i + 1, rule: policyFor(e, r), rule_name: POLICY_NAME[policyFor(e, r)],
        ...(e.inc ? { increment: e.inc } : {}), ...(e.deloadFactor ? { deload_factor: e.deloadFactor } : {}),
      }))
      return { result: { updated: true, exercise: match.name, slots: now, ...(skipped.length ? { skipped } : {}) }, trail: `${match.id} progression in ${now.length} slot(s)` }
    })
  },
}

export const PROGRESSION_TOOLS = [setProgression]
