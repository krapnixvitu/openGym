#!/usr/bin/env node
/* The stdio server behind a Unix socket, for a host where each person's Claude connects to a
   running container instead of starting the server itself (`socat STDIO UNIX-CONNECT:<path>` as
   the MCP command). Every connection gets its own index.js, which ends when the connection
   closes; its stderr stays this process's log. The socket is made with umask 077: only the user
   this runs as can connect, so run one container per person, as that person's uid. */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOCKET = process.env.MCP_SOCKET || '/run/mcp/mcp.sock'
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')

try { fs.unlinkSync(SOCKET) } catch { /* not there yet */ }
process.umask(0o077)

const server = net.createServer(conn => {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
  conn.pipe(child.stdin)
  child.stdout.pipe(conn)
  conn.on('error', () => child.stdin.end())
  child.stdin.on('error', () => {})
  child.on('exit', () => conn.end())
})
server.listen(SOCKET, () => console.error(`[opengym-mcp] listening on ${SOCKET}`))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
