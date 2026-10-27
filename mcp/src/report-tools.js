/* More reads, each the answer one of the app's screens gives, from the same lib/ code: an
   exercise's history sheet (lib/exercise-history.js), the training report (lib/report.js),
   muscle recovery on Stats (lib/recovery.js, lib/recovery-view.js), Structural Balance
   (lib/structuralBalance.js) and the plate line under a set (lib/plates.js). */
import { z } from 'zod'
import { getState } from './state.js'
import { isoDate, withCustomsIndexed } from './tools.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'
import { exerciseHistory } from '../../frontend/src/lib/exercise-history.js'
import { reportData } from '../../frontend/src/lib/report.js'
import { fatigueOf, strengthOf } from '../../frontend/src/lib/recovery.js'
import { fatigueStateOf, fatigueRecoveryMs } from '../../frontend/src/lib/recovery-view.js'
import { MUSCLES, MUSCLE_NAME } from '../../frontend/src/lib/muscles.js'
import { computeBalance, bodyweightKgOf } from '../../frontend/src/lib/structuralBalance.js'
import { TEMPLATES, DEFAULT_TEMPLATE_ID } from '../../frontend/src/lib/structuralBalanceTemplates.js'
import { rowLoad, loadKindFor, baseWeightFor, inventoryFor } from '../../frontend/src/lib/plates.js'
import { setLabel } from '../../frontend/src/lib/history.js'
import { exOr } from '../../frontend/src/lib/exercises.js'

const noState = () => ({ error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile' })
const unitOf = S => (S.unit === 'lb' ? 'lb' : 'kg')
const nameOf = (S, id) => (S.customEx || []).find(c => c?.id === id)?.n || exOr(id).n
const hours = ms => (ms == null ? null : Math.round(ms / 360000) / 10)

export const exerciseHistoryTool = {
  name: 'exercise_history',
  read: true,
  description: 'One exercise\'s past, as its history sheet in the app shows it: the best ever, every session\'s sets newest first with its best value, estimated 1RM and volume, which were PRs, and the trend (heaviest set per session; best reps for a bodyweight exercise, longest hold, or minutes for cardio).',
  schema: {
    exercise: z.string().min(1).describe('A name or id.'),
    limit: z.number().int().min(1).max(50).optional().describe('How many sessions in full, 10 if left out.'),
  },
  handler: ({ exercise, limit = 10 }) => {
    const S = getState()
    if (!S) return noState()
    const hit = resolveExercise(S, exercise)
    if (!hit.id) return { problem: `${JSON.stringify(exercise)}: ${hit.problem}`, ...(hit.candidates ? { candidates: hit.candidates } : {}) }
    return withCustomsIndexed(S, () => {
      const h = exerciseHistory(S, hit.id, { limit })
      return {
        exercise: hit.name, id: hit.id, unit: unitOf(S), mode: h.mode,
        trend_of: h.metric, best: h.best, sessions_logged: h.total,
        sessions: h.sessions.map(s => ({
          date: s.d, workout_id: s.id,
          sets: s.sets.map(x => setLabel(hit.id, { ...x, done: undefined }, { ...(s.target || {}), id: hit.id })),
          best: s.value, ...(s.e1rm ? { e1rm: s.e1rm } : {}), ...(s.volume ? { volume: s.volume } : {}), ...(s.pr ? { pr: true } : {}),
        })),
        trend: h.points.map(p => ({ date: p.d, value: p.y, ...(p.e1rm ? { e1rm: p.e1rm } : {}) })),
      }
    })
  },
}

export const trainingReport = {
  name: 'training_report',
  read: true,
  description: 'The app\'s training report for a stretch of time: workouts, volume, sets, time and PRs against the stretch just before, sessions per week, per-week totals, muscles worked, the main lifts\' progress, the PRs, body weight change and streaks. range: 7d, 4w (default), 3m, or from and to.',
  schema: {
    range: z.enum(['7d', '4w', '3m']).optional(),
    from: isoDate().optional(),
    to: isoDate().optional(),
  },
  handler: ({ range, from, to }) => {
    const S = getState()
    if (!S) return noState()
    return withCustomsIndexed(S, () => {
      const r = reportData(S, from || to ? { range: 'custom', from, to } : { range: range || '4w' })
      const totals = t => ({ workouts: t.workouts, volume: Math.round(t.volume), work_sets: t.sets, minutes: Math.round(t.ms / 60000), prs: t.prs, ...(t.bwChange != null ? { body_weight_change: t.bwChange } : {}) })
      return {
        from: r.range.from, to: r.range.to, days: r.range.days, unit: unitOf(S),
        totals: totals(r.totals), before: totals(r.prev), workouts_per_week: r.perWeek,
        per_week: r.buckets.buckets.map(b => ({ week_of: b.key, workouts: b.workouts, work_sets: b.sets, volume: Math.round(b.volume) })),
        muscles_worked: (r.muscles.worked || []).map(m => ({ muscle: m.name, sets: Math.round(m.sets * 10) / 10 })),
        ...(r.muscles.missed?.length ? { muscles_not_worked: r.muscles.missed.map(m => m.name || m) } : {}),
        main_lifts: r.lifts.map(l => ({ exercise: nameOf(S, l.id), best_e1rm: l.best?.y, best_set: l.best ? `${l.best.w} x ${l.best.r}` : null, change: l.change })),
        prs: r.prs.map(p => ({ exercise: nameOf(S, p.id), date: p.d, e1rm: p.best?.est, set: p.best ? `${p.best.w} x ${p.best.r}` : null })),
        streak: { weeks: r.streak.weeks, longest_weeks: r.streak.longestWeeks, active_days: r.streak.activeDays, rest_days: r.streak.restDays },
      }
    })
  },
}

export const recovery = {
  name: 'recovery',
  read: true,
  description: 'Which muscles are ready, recovering or fatigued right now, as the recovery map on Stats reads the log, with the hours until each is ready again, and how much strength each has kept since it was last trained (1 is all of it). Use it to suggest what to train today.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    return withCustomsIndexed(S, () => {
      const now = Date.now()
      const opts = { bodyweightKg: bodyweightKgOf(S), unit: S.unit }
      const fatigue = fatigueOf(S.workouts || [], now, opts)
      const strength = strengthOf(S.workouts || [], now, opts)
      const muscles = MUSCLES.map(slug => {
        const v = fatigue[slug]
        const state = fatigueStateOf(v)
        const left = fatigueRecoveryMs(v, slug)
        return { muscle: MUSCLE_NAME[slug], state, ...(left.toReadyMs != null ? { ready_in_hours: hours(left.toReadyMs) } : {}), strength_kept: Math.round(strength[slug] * 100) / 100 }
      })
      return { ready: muscles.filter(m => m.state === 'ready').map(m => m.muscle), muscles }
    })
  },
}

export const strengthBalance = {
  name: 'strength_balance',
  read: true,
  description: 'Structural Balance, as the app\'s screen computes it: each lift\'s estimated strength as a percentage of its anchor lift against the template\'s target (Poliquin by default), and whether it is balanced, borderline, weak or strong. Lifts without data say what is missing.',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return noState()
    const id = Object.prototype.hasOwnProperty.call(TEMPLATES, S.balanceTemplate) ? S.balanceTemplate : DEFAULT_TEMPLATE_ID
    const template = TEMPLATES[id]
    return withCustomsIndexed(S, () => ({
      template: template.label,
      lifts: computeBalance(S, template).map(r => {
        const role = template.roles.find(x => x.id === r.roleId)
        return {
          lift: role?.label || r.roleId,
          exercise: r.mappedExerciseId ? nameOf(S, r.mappedExerciseId) : null,
          target_pct: r.targetPct,
          ...(r.actualPct != null ? { actual_pct: Math.round(r.actualPct) } : {}),
          status: r.status,
          ...(r.needsBodyweight ? { missing: 'a body weight' } : r.needsAnchor ? { missing: 'data for the anchor lift' } : {}),
        }
      }),
    }))
  },
}

export const plateMath = {
  name: 'plate_math',
  read: true,
  description: 'Which plates to load for a weight, as the plate line under a set shows it: from the person\'s own bar and plate inventory, per side for a barbell, and what is missing when their plates cannot make it exactly.',
  schema: {
    weight: z.number().positive().max(1000).describe('The total weight, in the profile\'s unit.'),
    exercise: z.string().min(1).optional().describe('The exercise, for its bar and how it is loaded; leave out for a standard barbell.'),
  },
  handler: ({ weight, exercise }) => {
    const S = getState()
    if (!S) return noState()
    let id = '0025'
    if (exercise) {
      const hit = resolveExercise(S, exercise)
      if (!hit.id) return { problem: `${JSON.stringify(exercise)}: ${hit.problem}`, ...(hit.candidates ? { candidates: hit.candidates } : {}) }
      id = hit.id
    }
    return withCustomsIndexed(S, () => {
      const kind = loadKindFor(S, id)
      const base = baseWeightFor(S, id)
      const load = rowLoad(kind, weight, base, inventoryFor(S))
      const unit = unitOf(S)
      if (!load) return { exercise: nameOf(S, id), weight, unit, plates: null, note: 'This exercise is not loaded with plates.' }
      if (load.barOnly) return { exercise: nameOf(S, id), weight, unit, bar: base, plates: [], note: 'The bar alone, or less.' }
      return {
        exercise: nameOf(S, id), weight, unit, ...(base ? { bar: base } : {}),
        [kind === 'pairs' ? 'per_side' : 'on_the_stack']: load.perSide,
        plates: load.plates, ...(load.missing ? { missing: load.missing, note: 'The plates on record cannot make it exactly; this is the closest below.' } : {}),
      }
    })
  },
}

export const REPORT_TOOLS = [exerciseHistoryTool, trainingReport, recovery, strengthBalance, plateMath]
