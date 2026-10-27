// The map of openGym the server sends at connection: it reaches a real client through the
// handshake, it names only tools that exist, and it keeps the house style for text the model reads.
import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { INSTRUCTIONS } from '../src/instructions.js'
import { TOOLS } from '../src/tools.js'
import { WRITE_TOOLS } from '../src/write-tools.js'

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js')

describe('server instructions', () => {
  test('a client gets them in the handshake', async () => {
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [INDEX], env: { ...process.env, OPENGYM_DATA: '/nonexistent-opengym-data' }, stderr: 'ignore' }))
    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS)
    } finally { await client.close() }
  }, 20000)

  test('every tool they name exists', () => {
    const names = new Set([...TOOLS, ...WRITE_TOOLS].map(t => t.name))
    const named = INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g).filter(w => w !== 'dry_run')
    expect(named.length).toBeGreaterThan(0)
    for (const n of named) expect(names, n).toContain(n)
  })

  test('no em dashes, and short enough to sit in every session', () => {
    expect(INSTRUCTIONS).not.toMatch(/—/)
    expect(INSTRUCTIONS.length).toBeLessThan(3000)
  })
})
