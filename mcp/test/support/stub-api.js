// A stand-in for api/server.js for the write tools' tests: a node:http server that answers
// /api/me and /api/data the way the real one does, keeps the document and its revision, and
// records every PUT. `s.conflictOnce` makes the next PUT lose to another device's write (a
// weigh-in), as a phone saving in between would. What the real server does with a write is
// log-workout.e2e.test.js.
import http from 'node:http'

export const TOKEN = 'tok.secret-value'

export function stubApi(doc) {
  const s = { doc: structuredClone(doc), rev: 7, puts: [], conflictOnce: false }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    if (req.url === '/api/me') return send(200, { user: { id: 'u1', name: 'Matt' } })
    if (req.url === '/api/data' && req.method === 'GET') return send(200, { state: s.doc, rev: s.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      let raw = ''
      for await (const c of req) raw += c
      const body = JSON.parse(raw)
      s.puts.push(body)
      if (s.conflictOnce) {
        s.conflictOnce = false
        s.doc = { ...s.doc, restSec: 75 }
        s.rev++
        return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}
