import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, writeFile, chmod, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const local = join(root, '.local')
const pidFile = join(local, 'dev-lan.json')
const logFile = join(local, 'dev-lan.log')
const lock = join(local, 'dev-lan.lock')
const command = process.argv[2]
const port = Number(process.env.PORT ?? 3000)

async function writeState(state) {
  const temporary = `${pidFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, pidFile)
  } finally { await rm(temporary, { force: true }) }
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(pidFile, 'utf8'))
    if (!Number.isSafeInteger(state.pid) || state.pid < 2 || !Number.isSafeInteger(state.port)
      || state.port < 1 || state.port > 65535 || !/^chatpop-dev-lan-[a-f0-9-]{36}$/.test(state.title)) {
      throw new Error('Invalid development PID record; no process was signalled.')
    }
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Cannot read the development PID record; no process was signalled.')
  }
}

function ownsProcess(state) {
  try {
    // A nonce prevents a stale PID file from targeting a recycled, unrelated PID.
    return execFileSync('/bin/ps', ['-p', String(state.pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === state.title
  } catch { return false }
}

function ownsListener(state) {
  try {
    const result = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(state.pid),
      `-iTCP:${state.port}`, '-sTCP:LISTEN', '-Fn'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return result.split('\n').includes(`n*:${state.port}`)
  } catch { return false }
}

async function ready(state) {
  if (!ownsProcess(state) || !ownsListener(state)) return false
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/ready`, { signal: AbortSignal.timeout(1500) })
    return response.ok && (await response.json()).status === 'ready'
  } catch { return false }
}

async function assertPortAvailable() {
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`Port ${port} is unavailable. Stop its existing listener or choose a different PORT; no process was stopped.`)))
    probe.listen(port, '0.0.0.0', () => probe.close(resolve))
  })
}

async function stop(state) {
  if (!ownsProcess(state)) {
    await rm(pidFile, { force: true })
    console.log('No managed development server is running. Removed stale PID record; no process was signalled.')
    return
  }
  process.kill(state.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!ownsProcess(state)) {
      await rm(pidFile, { force: true })
      console.log('ChatPop LAN development server stopped.')
      return
    }
    await delay(100)
  }
  throw new Error('Development server has not stopped yet. PID record retained; retry status before stopping again.')
}

async function main() {
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
    throw new Error('The LAN development service requires NODE_ENV=development.')
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.')
  if (command === 'run') {
    if (!/^chatpop-dev-lan-[a-f0-9-]{36}$/.test(process.argv[3] ?? '')) throw new Error('Invalid managed process identity.')
    process.title = process.argv[3]
    await import('./dev-lan.mjs')
    return
  }
  if (!['start', 'stop', 'status'].includes(command)) throw new Error('Use start, status, or stop.')
  await mkdir(local, { recursive: true, mode: 0o700 })
  const state = await readState()
  if (command === 'status') {
    if (!state || !ownsProcess(state)) throw new Error('ChatPop LAN development server is not running.')
    if (!await ready(state)) throw new Error(`Managed development process ${state.pid} is not ready. Check PostgreSQL and ${logFile}.`)
    console.log(`ChatPop API and PostgreSQL ready: 0.0.0.0:${state.port} (PID ${state.pid}). Log: ${logFile}`)
    return
  }
  try { await mkdir(lock, { mode: 0o700 }) }
  catch { throw new Error('Another development start/stop is in progress. If interrupted, remove .local/dev-lan.lock only after checking no controller is running.') }
  try {
    const current = await readState()
    if (command === 'stop') {
      if (current) await stop(current)
      else console.log('No managed development server is running.')
      return
    }
    if (current && ownsProcess(current)) {
      if (!await ready(current)) throw new Error(`Existing development server is not ready. Check PostgreSQL and ${logFile}.`)
      console.log(`ChatPop development server already ready on 0.0.0.0:${current.port} (PID ${current.pid}).`)
      return
    }
    await assertPortAvailable()
    const log = await open(logFile, 'a', 0o600)
    const title = `chatpop-dev-lan-${randomUUID()}`
    let child
    let started
    let recorded = false
    try {
      try {
        await chmod(logFile, 0o600)
        child = spawn(process.execPath, [`--title=${title}`, '--env-file-if-exists=.env', '--import', 'tsx',
          'scripts/dev-lan-service.mjs', 'run', title], {
          cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, NODE_ENV: 'development' },
        })
        if (child.pid) started = { pid: child.pid, port, title }
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        child.unref()
      } finally { await log.close() }
      await writeState(started)
      recorded = true
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await ready(started)) {
          console.log(`ChatPop API and PostgreSQL ready: 0.0.0.0:${port} (PID ${child.pid}). Log: ${logFile}`)
          console.log('This development server stays running after the terminal closes. Stop it with npm run dev:lan:stop.')
          return
        }
        await delay(250)
      }
      throw new Error(`Development startup failed. Check PostgreSQL, environment configuration, and ${logFile}.`)
    } catch (error) {
      if (started) {
        // Even log/PID-file failures after spawn must not leave an unmanaged API.
        for (let attempt = 0; attempt < 50 && !ownsProcess(started)
          && child.exitCode === null && child.signalCode === null; attempt++) await delay(100)
        try {
          if (ownsProcess(started)) await stop(started)
          else if (child.exitCode === null && child.signalCode === null) {
            throw new Error('Child identity could not be verified; no signal was sent.')
          } else if (recorded) await rm(pidFile, { force: true })
        } catch {
          // Preserve recovery information when a verified shutdown cannot finish.
          try { await writeState(started) }
          catch {
            throw new Error(`Development startup and cleanup failed for PID ${started.pid} (${title}); PID record could not be saved. Inspect this exact process before signalling it.`)
          }
          throw new Error(`Development startup cleanup could not finish for PID ${started.pid}. PID record retained; check status before retrying stop.`)
        }
      }
      throw error
    }
  } finally { await rm(lock, { recursive: true, force: true }) }
}

try { await main() }
catch (error) { console.error(error instanceof Error ? error.message : 'Development service command failed.'); process.exitCode = 1 }
