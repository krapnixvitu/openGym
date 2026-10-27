/* Settings: the profile's own training settings, read and changed one by one the way their
   switches in Settings change them. An allow-list: the unit (a switch that converts every stored
   weight), sign-in and account, reminders (scheduled on each device) and how this one device looks
   are left to the app. */
import { z } from 'zod'
import { getState } from './state.js'
import { changeProfile } from './write-tools.js'
import { effortOf } from '../../frontend/src/lib/history.js'
import { weekStartOf } from '../../frontend/src/lib/format.js'
import { speedUnitOf } from '../../frontend/src/lib/speed.js'

// lib/duration.js REST_MAX, REST_PAUSE_MIN and REST_PAUSE_MAX (it imports the React i18n, so the
// numbers are copied rather than imported).
const REST_MAX = 15 * 60
const REST_PAUSE_MIN = 5
const REST_PAUSE_MAX = 5 * 60

// Each setting: its name for the model, what it means, the values it takes, how the profile holds
// it (read, with the app's own reading of an unset value), and how Settings writes it (write).
const SETTINGS = {
  rest_sec: {
    about: 'The rest timer after a set, in seconds; 0 is no timer. An exercise\'s own rest overrides it.',
    schema: z.number().int().min(0).max(REST_MAX),
    read: S => S.restSec ?? 90, write: (S, v) => { S.restSec = v },
  },
  rest_pause_sec: {
    about: 'The short rest inside a rest-pause set, in seconds.',
    schema: z.number().int().min(REST_PAUSE_MIN).max(REST_PAUSE_MAX),
    read: S => S.restPauseSec || 15, write: (S, v) => { S.restPauseSec = v },
  },
  effort: {
    about: 'How effort is logged per set: none, rir (reps in reserve) or rpe.',
    schema: z.enum(['none', 'rir', 'rpe']),
    // Settings drops the older showRir switch this replaced when it writes the choice.
    read: S => effortOf(S), write: (S, v) => { S.effort = v; delete S.showRir },
  },
  week_start: {
    about: 'The first day of the week: monday or sunday.',
    schema: z.enum(['monday', 'sunday']),
    read: S => (weekStartOf(S) === 0 ? 'sunday' : 'monday'), write: (S, v) => { S.weekStart = v === 'sunday' ? 0 : 1 },
  },
  weight_decimals: {
    about: 'Decimals shown on weights: 1, or 2 for microplates.',
    schema: z.union([z.literal(1), z.literal(2)]),
    read: S => (S.wdec === 2 ? 2 : 1), write: (S, v) => { S.wdec = v },
  },
  speed_unit: {
    about: 'Cardio speed shown in kmh or mph (stored in km/h either way).',
    schema: z.enum(['kmh', 'mph']),
    read: S => speedUnitOf(S), write: (S, v) => { S.speedUnit = v },
  },
  warmups_in_volume: {
    about: 'Whether warm-up sets count towards volume.',
    schema: z.boolean(),
    read: S => S.volumeWarmups === true, write: (S, v) => { S.volumeWarmups = v },
  },
  start_from: {
    about: 'Where a planned session\'s reps come from: plan (the routine\'s sets x reps, progression decides the weight) or last (carried over from the last session).',
    schema: z.enum(['plan', 'last']),
    read: S => (S.startFrom === 'last' ? 'last' : 'plan'), write: (S, v) => { S.startFrom = v },
  },
  last_time_from: {
    about: 'What "last time" means for an exercise: routine (its last session in this routine) or any (its newest session anywhere).',
    schema: z.enum(['routine', 'any']),
    read: S => (S.lastFrom === 'any' ? 'any' : 'routine'), write: (S, v) => { S.lastFrom = v },
  },
  workout_layout: {
    about: 'How the workout screen is laid out: cards (one exercise at a time), list, or compact.',
    schema: z.enum(['cards', 'list', 'compact']),
    read: S => S.workoutView || 'cards', write: (S, v) => { S.workoutView = v },
  },
  collapse_completed: {
    about: 'In the list and compact layouts, fold a finished exercise into one line.',
    schema: z.boolean(),
    read: S => S.collapseCompleted === true, write: (S, v) => { S.collapseCompleted = v },
  },
  weigh_in_before_workout: {
    about: 'Whether Start asks for the body weight first.',
    schema: z.boolean(),
    read: S => S.weighIn !== false, write: (S, v) => { S.weighIn = v },
  },
  weight_card_on_home: {
    about: 'Whether Home shows the body-weight card.',
    schema: z.boolean(),
    read: S => S.showWeightCard !== false, write: (S, v) => { S.showWeightCard = v },
  },
}

const current = S => Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.read(S)]))

export const getSettings = {
  name: 'get_settings',
  read: true,
  description: 'The profile\'s training settings and what each means: rest timer, effort scale, week start, how sessions are planned and laid out, and the weight unit (read only).',
  schema: {},
  handler: () => {
    const S = getState()
    if (!S) return { error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile' }
    return {
      unit: S.unit === 'lb' ? 'lb' : 'kg',
      settings: current(S),
      about: Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.about])),
      not_here: 'The unit (switching converts every stored weight), reminders, sign-in and how the app looks are changed in the app.',
    }
  },
}

export const updateSettings = {
  name: 'update_settings',
  description: 'Change one or more training settings, as their switches in Settings do; get_settings lists them and what each means. The weight unit, reminders and sign-in are not changed here.',
  schema: Object.fromEntries(Object.entries(SETTINGS).map(([k, s]) => [k, s.schema.optional().describe(s.about)])),
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const given = Object.entries(params).filter(([k, v]) => SETTINGS[k] && v !== undefined)
    if (!given.length) return { updated: false, problem: `name a setting: ${Object.keys(SETTINGS).join(', ')}` }
    return changeProfile({ tool: 'update_settings', env, fetchImpl }, S => {
      const changed = given.filter(([k, v]) => SETTINGS[k].read(S) !== v)
      if (!changed.length) return { save: false, result: { updated: false, message: 'Those settings already are that way; nothing changed.' } }
      for (const [k, v] of changed) SETTINGS[k].write(S, v)
      return { result: { updated: true, changed: Object.fromEntries(changed) }, trail: `settings ${changed.map(([k]) => k).join(', ')}` }
    })
  },
}

export const SETTINGS_TOOLS = [getSettings, updateSettings]
