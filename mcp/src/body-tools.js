/* Body weight: weigh-ins, the goal weight and the weekly-rate range, written the way the app's
   weigh-in, goal and rate sheets write them (sheets.jsx BwSheet and GoalSheet,
   components/WeightRate.jsx), through changeProfile like every write tool. A day can hold several
   weigh-ins, each with its time (#859): they are added and removed with lib/weigh-ins.js. Weights are kept in the
   profile's unit to a tenth (lib/units.js convertBodyWeight); the server stamps the changes for
   the sync, as it does for any api client. */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { changeProfile, fail, localIso } from './write-tools.js'
import { convertBodyWeight } from '../../frontend/src/lib/units.js'
import { rateCorridor } from '../../frontend/src/lib/bodyweight.js'
import { addWeighIn, removeWeighIn, readingsOf, defaultTimeFor, timeOf } from '../../frontend/src/lib/weigh-ins.js'

// Past any person, as the app refuses it (sheets.jsx bwMax): 9999 typed is a slip, not a weight.
const BW_MAX = { kg: 700, lb: 1500 }
const unitOf = S => (S.unit === 'lb' ? 'lb' : 'kg')
// A weight the user gave, in the profile's unit, to the tenth the weigh-in sheet keeps.
const inProfile = (value, given, S) => Math.round(Number(convertBodyWeight(value, given || unitOf(S), unitOf(S))) * 10) / 10
const tooHeavy = (n, S) => n > BW_MAX[unitOf(S)] ? `that is more than ${BW_MAX[unitOf(S)]} ${unitOf(S)}, which no weigh-in is` : null

// A time of day as the weigh-in sheet takes it.
const hhmm = () => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour')
const readingList = (S, day) => readingsOf(day).map(r => ({ time: r.at || null, weight: r.w, unit: unitOf(S) }))

export const addBodyweight = {
  name: 'add_bodyweight',
  description: [
    'Log a weigh-in, as the app\'s weigh-in sheet does: today at the current time by default, or another day and time.',
    'A day can hold several weigh-ins; the day\'s weight is the one the profile\'s daily-value setting picks (morning, average or last). A weigh-in at the same time on the same day corrects that one.',
  ].join(' '),
  schema: {
    weight: z.number().positive().describe('The body weight, in `unit`.'),
    unit: z.enum(['kg', 'lb']).optional().describe('The unit the user gave it in; defaults to the profile\'s. Converted when it differs.'),
    date: isoDate().optional().describe('YYYY-MM-DD, up to today; defaults to today.'),
    time: hhmm().optional().describe('Local time of day, HH:MM. Defaults to now for today, and for an earlier day to the time of its first weigh-in, or 08:00.'),
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
      const at = params.time || defaultTimeFor(S, date, today, now)
      if (date === today && at > timeOf(now)) return refuse(`${at} today is still to come`)
      const before = readingsOf((S.bodyweight || []).find(b => b?.d === date)).length
      if (!addWeighIn(S, { d: date, at, w: n, t: now })) return refuse('that is no weight')
      const day = S.bodyweight.find(b => b?.d === date)
      const corrected = readingsOf(day).length === before && before > 0
      return {
        result: { logged: true, date, time: at, weight: n, unit: unitOf(S), ...(corrected ? { corrected: true } : {}), day_weight: day.w, readings: readingList(S, day) },
        trail: `weigh-in ${date} ${at}`,
      }
    })
  },
}

export const deleteBodyweight = {
  name: 'delete_bodyweight',
  description: 'Delete a weigh-in, on every device. On a day with several, say which by its time; all: true deletes the whole day. Confirm the day, time and weight with the user first (get_bodyweight lists them).',
  schema: {
    date: isoDate().describe('The day of the weigh-in, YYYY-MM-DD.'),
    time: hhmm().optional().describe('The time of the weigh-in, HH:MM, as get_bodyweight lists it. Needed when the day has more than one.'),
    all: z.boolean().optional().describe('Delete every weigh-in of the day.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const now = Date.now()
    return changeProfile({ tool: 'delete_bodyweight', env, fetchImpl, now }, S => {
      const day = (S.bodyweight || []).find(b => b?.d === params.date)
      if (!day) throw fail('ENOENT', `no weigh-in on ${params.date}`)
      const rs = readingsOf(day)
      const unsure = problem => ({ save: false, result: { deleted: false, problem, readings: readingList(S, day), next: 'Nothing was deleted.' } })
      if (params.all) {
        S.bodyweight = S.bodyweight.filter(b => b?.d !== params.date)
        return { result: { deleted: true, date: params.date, readings: rs.length, weight: day.w, unit: unitOf(S) }, trail: `deleted weigh-ins ${params.date}` }
      }
      const pick = params.time ? rs.filter(r => r.at === params.time) : rs
      if (!pick.length) return unsure(`no weigh-in at ${params.time} on ${params.date}`)
      if (pick.length > 1) return unsure(params.time ? `more than one weigh-in at ${params.time}; pass all: true to delete the day` : `${params.date} has ${rs.length} weigh-ins: say which by its time, or all: true`)
      removeWeighIn(S, params.date, pick[0].id, now)
      const left = S.bodyweight.find(b => b?.d === params.date)
      return {
        result: { deleted: true, date: params.date, time: pick[0].at || null, weight: pick[0].w, unit: unitOf(S), ...(left ? { day_weight: left.w, readings_left: readingList(S, left) } : {}) },
        trail: `deleted weigh-in ${params.date} ${pick[0].at || ''}`.trim(),
      }
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
