// The map of openGym the server sends at connection: it reaches a real client through the
// handshake, it names only tools the server lists, and it keeps the house style for text the model reads.
import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { INSTRUCTIONS } from '../src/instructions.js'

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js')

describe('server instructions', () => {
  // The tool list comes from the same handshake, so it is every group index.js registers.
  test('a client gets them in the handshake, and every tool they name is one it lists', async () => {
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [INDEX], env: { ...process.env, OPENGYM_DATA: '/nonexistent-opengym-data' }, stderr: 'ignore' }))
    try {
      expect(client.getInstructions()).toBe(INSTRUCTIONS)
      const names = new Set((await client.listTools()).tools.map(t => t.name))
      const named = INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g).filter(w => w !== 'dry_run')
      expect(named.length).toBeGreaterThan(0)
      for (const n of named) expect(names, n).toContain(n)
    } finally { await client.close() }
  }, 20000)

  test('no em dashes, and short enough to sit in every session', () => {
    expect(INSTRUCTIONS).not.toMatch(/—/)
    expect(INSTRUCTIONS.length).toBeLessThan(3000)
  })
})
