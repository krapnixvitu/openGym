// The report tools against the real api: through OPENGYM_URL and OPENGYM_TOKEN they read the
// profile the server holds, as index.js runs them (refresh, then the handler).
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { buildDemoState } from '../../frontend/src/lib/demoSeed.js'
import { HAVE_API, realApi } from './support/real-api.js'

let api

beforeAll(async () => {
  if (!HAVE_API) return
  const doc = buildDemoState()
  doc.unit = 'kg'
  api = await realApi(doc)
}, 30000)
afterAll(() => { vi.unstubAllEnvs(); api?.stop() })

test.skipIf(!HAVE_API)('exercise history and plate math read the profile the server holds', async () => {
  vi.resetModules()
  for (const [k, v] of Object.entries({ OPENGYM_DATA: '', OPENGYM_UID: '', ...api.env })) vi.stubEnv(k, v)
  const { refresh } = await import('../src/state.js')
  const { REPORT_TOOLS } = await import('../src/report-tools.js')
  const call = (name, params = {}) => REPORT_TOOLS.find(t => t.name === name).handler(params)
  await refresh()
  const logged = api.stored().workouts.filter(w => (w.entries || []).some(e => e.id === '0025')).length
  const h = call('exercise_history', { exercise: '0025' })
  expect(h.sessions_logged).toBeGreaterThan(0)
  expect(h.sessions_logged).toBeLessThanOrEqual(logged)
  expect(call('plate_math', { weight: 60 }).per_side).toBe(20)
  expect(call('training_report').totals.workouts).toBeGreaterThan(0)
})
