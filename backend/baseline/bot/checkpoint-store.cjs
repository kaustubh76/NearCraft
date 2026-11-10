'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')

async function readCheckpoint (file) {
  try {
    const data = await fs.readFile(file, 'utf8')
    if (Buffer.byteLength(data) > 262144) throw new Error('CHECKPOINT_TOO_LARGE')
    return JSON.parse(data)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeCheckpoint (file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    if (handle) await handle.close()
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

async function acquireLocalLease (binding) {
  // shortcut: this OS lock fences one host only; use game-side distributed leases before multiple worker hosts.
  const port = 30000 + crypto.createHash('sha256').update(binding).digest().readUInt32BE(0) % 20000
  const server = net.createServer(socket => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

module.exports = { readCheckpoint, writeCheckpoint, acquireLocalLease }
