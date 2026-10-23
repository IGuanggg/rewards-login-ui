import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'

export const LOCK_FILE = '/tmp/rewards-browser.lock'

export function lowMemoryConfig(config, sessionPath) {
    return {
        ...config,
        ...(sessionPath ? { sessionPath } : {}),
        headless: true,
        clusters: 1,
        searchSettings: { ...config.searchSettings, parallelSearching: false, clusterSearch: false }
    }
}

export function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4) + '\n', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
}

export function start(command, args, options = {}) {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true, ...options })
    child.done = new Promise(resolve => {
        child.once('error', error => {
            console.error(`[runtime] ${command}: ${error.message}`)
            resolve(1)
        })
        child.once('exit', code => resolve(code ?? 1))
    })
    return child
}

export function signalTree(child, signal = 'SIGTERM') {
    if (!child?.pid) return
    try { process.kill(-child.pid, signal) } catch {}
}

export async function stopAll(children, graceMs = 6000) {
    for (const child of children) signalTree(child)
    let timer
    await Promise.race([
        Promise.all(children.map(child => child.done)),
        new Promise(resolve => { timer = setTimeout(resolve, graceMs) })
    ])
    clearTimeout(timer)
    // Clean descendants even if the group leader exited first.
    for (const child of children) signalTree(child, 'SIGKILL')
}

export async function waitForPort(port, child, timeoutMs = 12000) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
        if (child.exitCode !== null || child.signalCode) throw new Error(`Service on ${port} exited before readiness`)
        const ready = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port })
            socket.setTimeout(200)
            socket.once('connect', () => { socket.destroy(); resolve(true) })
            socket.once('error', () => resolve(false))
            socket.once('timeout', () => { socket.destroy(); resolve(false) })
        })
        if (ready) return
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Service on ${port} did not become ready`)
}
