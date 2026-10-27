/* The schedule: which routines a weekday holds, a single day changed from that, and a note on a
   day off, written as the Plan screen's sheets write them (sheets.jsx DayAssign, the day sheet's
   override, DayNote with lib/day-notes.js), through changeProfile like every write tool. Reading
   it back is get_week_plan, which goes through the same lib/history.js the app plans with. */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { changeProfile, fail, localIso } from './write-tools.js'
import { DAY_NOTE_TAGS, withDayNote, dayNoteOf, canNoteDay } from '../../frontend/src/lib/day-notes.js'
import { effectiveRoutineIds } from '../../frontend/src/lib/history.js'

// `S.week` is keyed by getDay(): 0 is Sunday.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const routineNames = (S, ids) => ids.map(id => (S.routines || []).find(r => r?.id === id)?.name || id)
// Routine ids the profile does not have, from a list the model sent.
const unknownIds = (S, ids) => ids.filter(id => !(S.routines || []).some(r => r?.id === id))

export const assignWeekday = {
  name: 'assign_weekday',
  description: [
    'Set which routines a weekday holds in the weekly plan, as Plan > Schedule does: one routine, several (trained together as a combined day, in the order given), or none for a rest day.',
    'Routine ids come from list_routines. This changes every week; to change one date only, use override_day.',
  ].join(' '),
  schema: {
    weekday: z.enum(WEEKDAYS),
    routine_ids: z.array(z.string().min(1)).max(10).describe('The routines, in the order the session runs them; [] makes it a rest day.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const ids = [...new Set(params.routine_ids)]
    return changeProfile({ tool: 'assign_weekday', env, fetchImpl }, S => {
      const unknown = unknownIds(S, ids)
      if (unknown.length) return { save: false, result: { updated: false, problem: `no routine with id ${unknown.join(', ')} (list_routines gives the ids)`, next: 'Nothing was saved.' } }
      const wd = WEEKDAYS.indexOf(params.weekday)
      S.week = S.week && typeof S.week === 'object' && !Array.isArray(S.week) ? S.week : {}
      const before = [].concat(S.week[wd] || [])
      if (JSON.stringify(before) === JSON.stringify(ids)) return { save: false, result: { updated: false, message: 'That day already holds exactly that; nothing changed.' } }
      // The weekday never stores [] (DayAssign): the key goes instead.
      if (ids.length) S.week[wd] = ids
      else delete S.week[wd]
      return { result: { updated: true, weekday: params.weekday, routines: ids.length ? routineNames(S, ids) : 'rest' }, trail: `${params.weekday}: ${ids.length ? ids.join('+') : 'rest'}` }
    })
  },
}

export const overrideDay = {
  name: 'override_day',
  description: [
    'Change what is planned on one date without touching the weekly plan, as the Plan screen\'s day sheet does: a different routine, a rest day ("rest"), or back to the weekly plan (null).',
    'Use it to move a session ("do Monday\'s legs on Tuesday": Tuesday gets the routine, Monday "rest"). Check get_week_plan first for what each day holds.',
  ].join(' '),
  schema: {
    date: isoDate().describe('The date, YYYY-MM-DD.'),
    routine_id: z.string().min(1).nullable().describe('A routine id from list_routines, "rest", or null to follow the weekly plan again.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'override_day', env, fetchImpl }, S => {
      const v = params.routine_id
      if (v != null && v !== 'rest' && unknownIds(S, [v]).length) {
        return { save: false, result: { updated: false, problem: `no routine with id ${v} (list_routines gives the ids)`, next: 'Nothing was saved.' } }
      }
      S.dayPlan = S.dayPlan && typeof S.dayPlan === 'object' && !Array.isArray(S.dayPlan) ? S.dayPlan : {}
      if ((S.dayPlan[params.date] ?? null) === (v ?? null)) return { save: false, result: { updated: false, message: 'That date already is that way; nothing changed.' } }
      if (v == null) delete S.dayPlan[params.date]
      else S.dayPlan[params.date] = v
      // What the day now holds, read the way the app reads it.
      const planned = effectiveRoutineIds({ week: {}, dayPlan: {}, routines: [], ...S }, params.date, localIso(new Date()))
      return {
        result: { updated: true, date: params.date, planned: planned.length ? routineNames(S, planned) : 'rest', ...(v == null ? { follows: 'the weekly plan' } : {}) },
        trail: `${params.date}: ${v ?? 'weekly plan'}`,
      }
    })
  },
}

export const setDayNote = {
  name: 'set_day_note',
  description: [
    'Note why a day had no training, today or earlier, as the app\'s day note does: sick, travel, rest or injured, and/or a short text. A noted day is excused: the missed-workout reminder skips it.',
    'clear: true removes the note.',
  ].join(' '),
  schema: {
    date: isoDate().describe('The date, YYYY-MM-DD, up to today.'),
    tag: z.enum(DAY_NOTE_TAGS).optional(),
    text: z.string().max(200).optional(),
    clear: z.boolean().optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    if (!params.clear && !params.tag && !(params.text || '').trim()) throw fail('EINVAL', 'give a tag, a text, or clear: true')
    const now = Date.now()
    return changeProfile({ tool: 'set_day_note', env, fetchImpl, now }, S => {
      if (!canNoteDay(params.date, localIso(new Date(now)))) return { save: false, result: { updated: false, problem: 'a day note is for today or an earlier day', next: 'Nothing was saved.' } }
      const had = dayNoteOf(S, params.date)
      if (params.clear && !had) return { save: false, result: { updated: false, message: 'That day has no note; nothing changed.' } }
      // A cleared note is written as an empty, stamped entry, so the removal syncs (withDayNote).
      S.dayNotes = withDayNote(S.dayNotes, params.date, params.clear ? null : { tag: params.tag || null, text: params.text || '' }, now)
      const note = dayNoteOf(S, params.date)
      return { result: { updated: true, date: params.date, note: note || null }, trail: `day note ${params.date}${note ? '' : ' cleared'}` }
    })
  },
}

export const SCHEDULE_TOOLS = [assignWeekday, overrideDay, setDayNote]
