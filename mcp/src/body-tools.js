/* Body weight: weigh-ins, the goal weight and the weekly-rate range, written the way the app's
   weigh-in, goal and rate sheets write them (sheets.jsx BwSheet and GoalSheet,
   components/WeightRate.jsx), through changeProfile like every write tool. Weights are kept in the
   profile's unit to a tenth (lib/units.js convertBodyWeight); the server stamps the changes for
   the sync, as it does for any api client. */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { changeProfile, fail, localIso } from './write-tools.js'
import { convertBodyWeight } from '../../frontend/src/lib/units.js'
import { rateCorridor } from '../../frontend/src/lib/bodyweight.js'

// Past any person, as the app refuses it (sheets.jsx bwMax): 9999 typed is a slip, not a weight.
const BW_MAX = { kg: 700, lb: 1500 }
const unitOf = S => (S.unit === 'lb' ? 'lb' : 'kg')
// A weight the user gave, in the profile's unit, to the tenth the weigh-in sheet keeps.
const inProfile = (value, given, S) => Math.round(Number(convertBodyWeight(value, given || unitOf(S), unitOf(S))) * 10) / 10
const tooHeavy = (n, S) => n > BW_MAX[unitOf(S)] ? `that is more than ${BW_MAX[unitOf(S)]} ${unitOf(S)}, which no weigh-in is` : null

export const addBodyweight = {
  name: 'add_bodyweight',
  description: [
    'Log a weigh-in, as the app\'s weigh-in sheet does: one per day, today by default.',
    'A second weigh-in today replaces the first (a correction). An earlier day that already has one is only replaced with replace: true, after the user confirms.',
  ].join(' '),
  schema: {
    weight: z.number().positive().describe('The body weight, in `unit`.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave it in; defaults to the profile\'s. Converted when it differs.'),
    date: isoDate().optional().describe('YYYY-MM-DD, up to today; defaults to today.'),
    replace: z.boolean().optional().describe('Replace the weigh-in an earlier day already has.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const now = Date.now()
    return changeProfile({ tool: 'add_bodyweight', env, fetchImpl, now }, S => {
      const today = localIso(new Date(now))
      const date = params.date || today
      const refuse = problem => ({ save: false, result: { logged: false, problem, next: 'Nothing was saved.' } })
      if (date > today) return refuse('that day is in the future')
      const n = inProfile(params.weight, params.unit, S)
      if (!(n > 0)) return refuse('the weight has to be more than 0')
      const heavy = tooHeavy(n, S)
      if (heavy) return refuse(heavy)
      S.bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : []
      const had = S.bodyweight.find(b => b?.d === date)
      if (had && date !== today && !params.replace) {
        return refuse(`${date} already has a weigh-in (${had.w} ${unitOf(S)}): ask the user, and call again with replace: true to correct it`)
      }
      if (had) { had.w = n; had.t = now; delete had.src } else S.bodyweight.push({ d: date, w: n, t: now })
      S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
      return { result: { logged: true, date, weight: n, unit: unitOf(S), ...(had ? { replaced: true } : {}) }, trail: `weigh-in ${date}` }
    })
  },
}

export const deleteBodyweight = {
  name: 'delete_bodyweight',
  description: 'Delete the weigh-in of one day, on every device. Confirm the day and the weight with the user first (get_bodyweight lists them).',
  schema: {
    date: isoDate().describe('The day of the weigh-in, YYYY-MM-DD.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'delete_bodyweight', env, fetchImpl }, S => {
      const had = (S.bodyweight || []).find(b => b?.d === params.date)
      if (!had) throw fail('ENOENT', `no weigh-in on ${params.date}`)
      S.bodyweight = S.bodyweight.filter(b => b?.d !== params.date)
      return { result: { deleted: true, date: params.date, weight: had.w, unit: unitOf(S) }, trail: `deleted weigh-in ${params.date}` }
    })
  },
}

export const setGoalWeight = {
  name: 'set_goal_weight',
  description: 'Set the target body weight drawn on the weight charts, or remove it with weight: null.',
  schema: {
    weight: z.number().positive().nullable().describe('The goal, in `unit`; null removes it.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave it in; defaults to the profile\'s.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'set_goal_weight', env, fetchImpl }, S => {
      const n = params.weight == null ? null : inProfile(params.weight, params.unit, S)
      if (n != null) {
        const heavy = tooHeavy(n, S)
        if (heavy) return { save: false, result: { updated: false, problem: heavy, next: 'Nothing was saved.' } }
      }
      if ((S.targetW ?? null) === n) return { save: false, result: { updated: false, message: 'The goal already is that; nothing changed.' } }
      S.targetW = n
      return { result: { updated: true, goal: n, unit: unitOf(S) }, trail: n == null ? 'removed the goal weight' : 'set the goal weight' }
    })
  },
}

export const setWeeklyRateGoal = {
  name: 'set_weekly_rate_goal',
  description: [
    'Set the range the weekly body-weight trend should stay in, as the app\'s weekly-rate card does: lose, gain or hold, between `low` and `high` a week, in percent of body weight or in the profile\'s unit.',
    '"Lose 0.5 to 1 % a week" is { direction: "lose", by: "%", low: 0.5, high: 1 }. Hold keeps within plus or minus `high`. clear: true removes it.',
  ].join(' '),
  schema: {
    direction: z.enum(['lose', 'gain', 'hold']).optional(),
    by: z.enum(['%', 'weight']).optional().describe('Percent of body weight a week, or the profile\'s unit a week. Defaults to %.'),
    low: z.number().min(0).max(100).optional().describe('The slow end of the range (not used for hold).'),
    high: z.number().positive().max(100).optional().describe('The fast end of the range.'),
    clear: z.boolean().optional().describe('Remove the range.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let goal = null
    if (!params.clear) {
      if (!params.direction || params.high == null) throw fail('EINVAL', 'give direction and high (and low unless holding), or clear: true')
      const by = params.by === 'weight' ? 'w' : '%'
      goal = params.direction === 'hold' ? { dir: 'hold', by, lo: 0, hi: params.high } : { dir: params.direction, by, lo: params.low ?? 0, hi: params.high }
      if (!rateCorridor(goal)) throw fail('EINVAL', 'that range is empty')
    }
    return changeProfile({ tool: 'set_weekly_rate_goal', env, fetchImpl }, S => {
      if (JSON.stringify(S.rateGoal ?? null) === JSON.stringify(goal)) return { save: false, result: { updated: false, message: 'It already is that; nothing changed.' } }
      S.rateGoal = goal
      const c = rateCorridor(goal)
      return { result: { updated: true, ...(c ? { range: { direction: c.dir, by: c.by === 'w' ? unitOf(S) : '%', per_week_min: c.min, per_week_max: c.max } } : { range: null }) }, trail: goal ? 'set the weekly rate range' : 'removed the weekly rate range' }
    })
  },
}

export const BODY_TOOLS = [addBodyweight, deleteBodyweight, setGoalWeight, setWeeklyRateGoal]
