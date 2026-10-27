/* Body measurements: one check-in per day of circumferences, body fat and the person's own fields,
   read and written the way views/Measurements.jsx does with lib/measurements.js. Values go in and
   come out in what the screen shows: cm or in by the profile for the built-in circumferences,
   percent for body fat, and each custom field in its own unit. */
import { z } from 'zod'
import { isoDate } from './tools.js'
import { getState } from './state.js'
import { changeProfile, localIso } from './write-tools.js'
import {
  MEASUREMENT_FIELDS, CUSTOM_MEASUREMENT_UNITS, DEFAULT_MEASUREMENT_KEYS, measurementUnit, toMeasurementDisplay,
  fromMeasurementDisplay, emptyMeasurement, normalizeMeasurementEntry, measurementValue, enabledMeasurementFields,
  measurementEntryHasValues, zeroIsReading, measurementUnitLabel,
} from '../../frontend/src/lib/measurements.js'
import { uid } from '../../frontend/src/lib/format.js'

const noState = () => ({ error: 'no synced state yet: sign in at least once from a device so the openGym api can save a state file for this profile' })
const nothing = text => ({ save: false, result: { updated: false, problem: text, next: 'Nothing was saved.' } })
const customsOf = S => (Array.isArray(S.customMeasurements) ? S.customMeasurements : []).filter(c => c && c.id)
const entriesOf = S => (Array.isArray(S.measurements) ? S.measurements : []).filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.d || ''))

/** Every field the person can log, as { key, name, unit, field }: built-ins, then their own. */
function fieldsOf(S) {
  const builtin = MEASUREMENT_FIELDS.map(f => ({ key: f.key, name: f.label, field: f }))
  const own = customsOf(S).map(c => ({ key: 'other:' + c.id, name: c.name, field: { key: 'other:' + c.id, custom: true, ...(c.unit ? { unit: c.unit } : {}) } }))
  return [...builtin, ...own].map(x => ({ ...x, unit: measurementUnit(S.unit, x.field) }))
}

/** The field a name from the model means: a built-in key or label, or a custom field's name or id. */
function fieldNamed(S, name) {
  const k = String(name).trim().toLowerCase()
  return fieldsOf(S).find(f => f.key.toLowerCase() === k || f.name.toLowerCase() === k || f.key.toLowerCase() === 'other:' + k)
}

/** One check-in as the history shows it: each reading in its shown unit. */
function entryView(S, e, keys) {
  const values = {}
  for (const f of fieldsOf(S)) {
    if (keys && !keys.has(f.key)) continue
    const v = measurementValue(e, f.key)
    if (v != null) values[f.name] = `${toMeasurementDisplay(v, S.unit, f.field)}${measurementUnitLabel(f.unit) ? ' ' + measurementUnitLabel(f.unit) : ''}`
  }
  return { date: e.d, values }
}

export const getMeasurements = {
  name: 'get_measurements',
  read: true,
  description: 'Body measurements: the check-ins (one per day) with each reading in the unit the app shows it, newest first, and the fields the person tracks. Name a field for its history alone.',
  schema: {
    field: z.string().min(1).optional().describe('A field ("waist", "Body fat", or one of their own by name).'),
    limit: z.number().int().min(1).max(200).optional().describe('How many check-ins, 10 if left out.'),
  },
  handler: ({ field, limit = 10 }) => {
    const S = getState()
    if (!S) return noState()
    const f = field ? fieldNamed(S, field) : null
    if (field && !f) return { problem: `no measurement field called ${JSON.stringify(field)}`, fields: fieldsOf(S).map(x => x.name) }
    const keys = f ? new Set([f.key]) : null
    const entries = entriesOf(S).slice().sort((a, b) => b.d.localeCompare(a.d))
      .map(e => entryView(S, e, keys)).filter(e => Object.keys(e.values).length).slice(0, limit)
    return {
      check_ins: entries,
      tracked: enabledMeasurementFields(S).map(x => ({ name: x.label, unit: measurementUnitLabel(measurementUnit(S.unit, x)) || 'none' })),
      ...(f ? {} : { other_fields: fieldsOf(S).filter(x => !enabledMeasurementFields(S).some(e => e.key === x.key)).map(x => x.name) }),
    }
  },
}

export const addMeasurements = {
  name: 'add_measurements',
  description: [
    'Log body measurements for a day, as the app\'s check-in does: one check-in per day, so readings for a day that has one are added to it (a field given again is corrected).',
    'Values are in the unit get_measurements shows for each field (cm or in for circumferences by the profile, percent for body fat, a custom field\'s own unit); null clears a reading.',
  ].join(' '),
  schema: {
    date: isoDate().optional().describe('YYYY-MM-DD, up to today; leave out for today.'),
    values: z.record(z.string(), z.number().nullable()).describe('Field name to reading, e.g. { "waist": 82.5, "Left upper arm": 34 }.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    const now = Date.now()
    const today = localIso(new Date(now))
    const date = params.date || today
    if (date > today) return { updated: false, problem: 'measurements are for today or an earlier day' }
    if (!Object.keys(params.values).length) return { updated: false, problem: 'give at least one reading' }
    return changeProfile({ tool: 'add_measurements', env, fetchImpl, now }, S => {
      const custom = customsOf(S)
      const had = entriesOf(S).find(e => e.d === date)
      const base = had ? normalizeMeasurementEntry(had, custom) : emptyMeasurement(date, custom)
      const enable = []
      for (const [name, raw] of Object.entries(params.values)) {
        const f = fieldNamed(S, name)
        if (!f) return nothing(`no measurement field called ${JSON.stringify(name)}; get_measurements lists them, add_measurement_field makes one`)
        // The form's reading of a typed number: rounded to a tenth, a 0 empty unless 0 means something.
        const shown = raw == null || (raw === 0 && !zeroIsReading(f.unit)) ? null : Math.round(raw * 10) / 10
        const value = shown == null ? null : f.key === 'bodyFat' ? shown : fromMeasurementDisplay(shown, S.unit, f.field)
        if (shown != null && (value == null || (f.unit === '%' && (shown < 0 || shown > 100)))) return nothing(`${f.name}: ${raw} ${f.unit} is not a reading it takes`)
        if (f.field.custom) {
          const item = base.other.find(o => o.id === f.key.slice(6))
          item.value = value
          if (f.field.unit) item.unit = f.field.unit
        } else base[f.key] = value
        if (!f.field.custom && value != null && !(S.measurementEnabled || DEFAULT_MEASUREMENT_KEYS).includes(f.key)) enable.push(f.key)
      }
      if (had && JSON.stringify(normalizeMeasurementEntry(had, custom)) === JSON.stringify(base)) return { save: false, result: { updated: false, message: 'That day already has those readings; nothing changed.' } }
      S.measurements = entriesOf(S).filter(e => e.d !== date)
      if (measurementEntryHasValues(base)) {
        // The newer check-in of a day wins a sync merge, as a weigh-in does (Measurements.jsx).
        base.t = now
        S.measurements.push(base)
        S.measurements.sort((a, b) => a.d.localeCompare(b.d))
      }
      // A built-in the person had switched off would be logged and never shown: switched on.
      if (enable.length) S.measurementEnabled = [...new Set([...(S.measurementEnabled || DEFAULT_MEASUREMENT_KEYS), ...enable])]
      const kept = S.measurements.find(e => e.d === date)
      return {
        result: { updated: true, ...(kept ? entryView(S, kept) : { date, values: {}, removed: 'the day had no readings left' }), ...(enable.length ? { now_tracked: enable.map(k => MEASUREMENT_FIELDS.find(f => f.key === k).label) } : {}) },
        trail: `measurements ${date}`,
      }
    })
  },
}

export const deleteMeasurements = {
  name: 'delete_measurements',
  description: 'Delete a day\'s measurement check-in, as the app\'s Delete does. Confirm with the person first.',
  schema: { date: isoDate() },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    return changeProfile({ tool: 'delete_measurements', env, fetchImpl }, S => {
      if (!entriesOf(S).some(e => e.d === params.date)) return nothing(`there are no measurements on ${params.date}`)
      S.measurements = (S.measurements || []).filter(e => e?.d !== params.date)
      return { result: { deleted: true, date: params.date }, trail: `measurements ${params.date} deleted` }
    })
  },
}

export const addMeasurementField = {
  name: 'add_measurement_field',
  description: 'Add a measurement of the person\'s own to track ("Muscle ratio" in %, a grip test in kg, a score with no unit), as Choose measurements > Add does. Built-in circumferences need no field: add_measurements logs them.',
  schema: {
    name: z.string().trim().min(1).max(60),
    unit: z.enum(CUSTOM_MEASUREMENT_UNITS).optional().describe('cm, in, %, kg, lb or none; leave out for the profile\'s length unit.'),
  },
  handler: async (params, { env = process.env, fetchImpl } = {}) => {
    let id = null
    return changeProfile({ tool: 'add_measurement_field', env, fetchImpl }, S => {
      const clean = params.name.trim()
      if (customsOf(S).some(c => c.name.toLowerCase() === clean.toLowerCase()) || MEASUREMENT_FIELDS.some(f => f.label.toLowerCase() === clean.toLowerCase())) {
        return nothing(`a measurement called ${clean} already exists`)
      }
      id = id || uid()
      const unit = params.unit || measurementUnit(S.unit)
      S.customMeasurements = Array.isArray(S.customMeasurements) ? S.customMeasurements : []
      S.customMeasurements.push({ id, name: clean.slice(0, 60), enabled: true, unit })
      return { result: { created: true, name: clean, unit }, trail: `measurement field ${id}` }
    })
  },
}

export const MEASUREMENT_TOOLS = [getMeasurements, addMeasurements, deleteMeasurements, addMeasurementField]
