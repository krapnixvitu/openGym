/* The two schedules besides the weekday plan: the app's own rotation (a loop of routines, with
   rest days, run one pass at a time, lib/rotation.js), set the way Plan's rotation editor and the
   "How you train" switch set it, and a planner's week queue (lib/queue.js), the floating list of
   sessions an API client writes for a coaching week. Reading either back is get_week_plan. */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { changeProfile, localIso } from './write-tools.js'
import { saveRotation, startNewPass, chooseRotation, chooseFixedWeek, stopPass, scheduleModeOf, REST } from '../../frontend/src/lib/rotation.js'
import { queueOf, queueView } from '../../frontend/src/lib/queue.js'

const unknownIds = (S, ids) => ids.filter(id => id !== REST && !(S.routines || []).some(r => r?.id === id))
const nothing = text => ({ save: false, result: { updated: false, problem: text, next: 'Nothing was saved.' } })
// Whose the live queue is: the app's rotation pass marks itself with the rotation's id.
const ownPass = S => { const q = queueOf(S); return !!q && !!S.rotation && q.rotationId === S.rotation.id }

/** What the schedule now is, the way Home's progress row reads it. */
function scheduleView(S, today) {
  const view = queueView(S, today)
  return {
    mode: scheduleModeOf(S) === 'rotation' ? 'rotation' : 'weekly plan',
    ...(S.rotation ? { rotation: (S.rotation.sequence || []).map(id => id === REST ? 'rest' : (S.routines || []).find(r => r.id === id)?.name || id) } : {}),
    ...(view ? { current_pass: { label: view.label || null, sessions: view.items.map(i => ({ name: i.name, state: i.state, ...(i.on ? { on: i.on } : {}) })), starts_on: view.startsOn } } : {}),
  }
}

export const setRotation = {
  name: 'set_rotation',
  description: [
    'Train in a rotation instead of on fixed weekdays, as Plan > How you train > Rotation does: a loop of routines run in order, whatever the day, with "rest" for a day off (A, B, rest, C).',
    'sequence saves the loop (the pass in progress keeps what is already done); start_over begins it again from the first routine today; use: "weekly plan" goes back to the weekday plan and keeps the loop for later, use: "rotation" switches to it again.',
  ].join(' '),
  schema: {
    sequence: z.array(z.string().min(1)).max(30).optional().describe('Routine ids from list_routines, in order, and "rest" for a day off. A routine may come twice.'),
    label: z.string().max(40).optional().describe('A name for the loop.'),
    start_over: z.boolean().optional(),
    use: z.enum(['rotation', 'weekly plan']).optional(),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const { sequence, label, start_over: startOver, use } = params
    if (!sequence && !startOver && !use && label == null) return { updated: false, problem: 'give a sequence, start_over, use, or a label' }
    if (use === 'weekly plan' && (sequence || startOver)) return { updated: false, problem: 'use: "weekly plan" leaves the rotation; save or restart it in another call' }
    const now = Date.now()
    const today = localIso(new Date(now))
    return changeProfile({ tool: 'set_rotation', env, fetchImpl, now }, S => {
      const before = JSON.stringify([S.rotation, S.queue, S.scheduleMode, S.dayPlan])
      if (sequence) {
        const unknown = unknownIds(S, sequence)
        if (unknown.length) return nothing(`no routine with id ${unknown.join(', ')} (list_routines gives the ids)`)
        if (!sequence.some(id => id !== REST)) return nothing('a rotation needs at least one routine')
        if (queueOf(S) && !ownPass(S)) return nothing('a planner\'s week queue is running (get_week_plan shows it); clear it with plan_week first, or ask the person')
        // Plan's editor: the loop is saved, and Rotation is what the person now trains by.
        saveRotation(S, sequence, label ?? S.rotation?.label ?? '', today, now)
        S.scheduleMode = 'rotation'
      } else if (label != null && S.rotation) {
        S.rotation = { ...S.rotation, label }
        if (ownPass(S)) S.queue = { ...S.queue, label }
      }
      if (use === 'rotation' && !sequence) {
        if (!S.rotation) return nothing('there is no rotation saved yet; give its sequence')
        chooseRotation(S, today, now)
      }
      if (startOver) {
        if (!S.rotation) return nothing('there is no rotation saved yet; give its sequence')
        startNewPass(S, today, now)
        S.scheduleMode = 'rotation'
      }
      if (use === 'weekly plan') chooseFixedWeek(S, today)
      if (JSON.stringify([S.rotation, S.queue, S.scheduleMode, S.dayPlan]) === before) return { save: false, result: { updated: false, message: 'The schedule already is that way; nothing changed.' } }
      return { result: { updated: true, ...scheduleView(S, today) }, trail: `rotation ${sequence ? 'saved' : startOver ? 'restarted' : use || 'renamed'}` }
    })
  },
}

export const planWeek = {
  name: 'plan_week',
  description: [
    'Plan a coaching week as a queue: an ordered list of sessions, done in that order on whatever days the person trains, the way an outside planner writes one. Home shows it as the week\'s progress row; a session counts as done once a workout of that routine is finished after the plan starts.',
    'The person\'s own weekday plan still shows beside it. routine_ids [] clears the queue. To pin a session to a date, use override_day with its routine.',
  ].join(' '),
  schema: {
    routine_ids: z.array(z.string().min(1)).max(14).describe('The week\'s sessions in order, routine ids from list_routines; [] clears it.'),
    label: z.string().max(40).optional().describe('The progress row\'s title, e.g. "Week 3".'),
    starts_on: isoDate().optional().describe('The first day it is active, YYYY-MM-DD; leave out for today.'),
    replace_rotation: z.boolean().optional().describe('Needed when the person trains by the app\'s rotation: the queue takes its place until cleared.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const ids = [...new Set(params.routine_ids)]
    const now = Date.now()
    const today = localIso(new Date(now))
    return changeProfile({ tool: 'plan_week', env, fetchImpl, now }, S => {
      if (!ids.length) {
        if (!queueOf(S)) return { save: false, result: { updated: false, message: 'There is no week queue; nothing changed.' } }
        if (ownPass(S)) return nothing('the running queue is the app\'s rotation; set_rotation with use: "weekly plan" stops it')
        stopPass(S, today)
        return { result: { updated: true, cleared: true, ...scheduleView(S, today) }, trail: 'week queue cleared' }
      }
      const unknown = unknownIds(S, ids).concat(ids.filter(id => id === REST))
      if (unknown.length) return nothing(`no routine with id ${unknown.join(', ')} (list_routines gives the ids; a queue has no rest days)`)
      if (ownPass(S) && !params.replace_rotation) return nothing('the person trains by the app\'s rotation; a week queue would take its place. Ask them, then pass replace_rotation: true')
      // A planner's queue: no rotationId, so the app never refills or rewrites it (queue.js).
      S.queue = { ids, since: now, startsOn: params.starts_on || today, label: params.label || '' }
      return { result: { updated: true, ...scheduleView(S, today) }, trail: `week queue of ${ids.length}` }
    })
  },
}

export const ROTATION_TOOLS = [setRotation, planWeek]
