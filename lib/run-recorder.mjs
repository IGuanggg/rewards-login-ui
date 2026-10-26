import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { ActivityStore, activityFile } from './activity-store.mjs'

export async function createRunRecorder(root, configFile) {
    const parser = await import(pathToFileURL(path.join(root, 'scripts/api/logParser.js')).href)
    const secrets = Object.entries(process.env).filter(([key]) => /PASSWORD|TOKEN|SECRET/i.test(key)).map(([, value]) => value)
    const store = new ActivityStore(activityFile(configFile), { secrets })
    const id = store.begin()
    const state = parser.createRunState()
    let warned = false
    const guarded = action => {
        try { return action() } catch (error) {
            if (!warned) { warned = true; console.error(`[activity] 记录写入失败：${error.message}`) }
        }
    }
    const ingest = (line, source) => guarded(() => {
        if (!line.trim()) return
        const entry = { ...parser.parseLogLine(line, source), receivedAt: new Date().toISOString() }
        const changed = parser.applyLogToRunState(state, entry)
        entry.account = (entry.user && state.userToEmail[entry.user]) || state.currentEmail || entry.user || ''
        store.append(id, entry, changed ? parser.summarizeRunState(state) : null)
    })
    const heartbeat = setInterval(() => guarded(() => store.touch(id)), 10000)
    heartbeat.unref()
    return {
        attach(child) {
            for (const source of ['stdout', 'stderr']) {
                const decoder = new StringDecoder('utf8')
                let pending = ''
                const consume = text => {
                    pending += text
                    let newline
                    while ((newline = pending.indexOf('\n')) !== -1) {
                        ingest(pending.slice(0, newline).replace(/\r$/, ''), source)
                        pending = pending.slice(newline + 1)
                    }
                    if (pending.length > 64000) { ingest(pending.slice(0, 8000), source); pending = '' }
                }
                child[source].on('data', chunk => { process[source].write(chunk); consume(decoder.write(chunk)) })
                child[source].on('end', () => { consume(decoder.end()); if (pending) ingest(pending, source) })
            }
        },
        finish(code, cancelled) {
            clearInterval(heartbeat)
            guarded(() => store.finish(id, code, parser.summarizeRunState(state), { cancelled }))
            store.close()
        }
    }
}
