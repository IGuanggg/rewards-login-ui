import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { ActivityStore, activityFile } from './activity-store.mjs'
import { detectRuntimeSessionInvalidations } from './session-health.mjs'

async function loadLogParser(root) {
    const v5Dir = path.join(root, 'dist', 'control-api', 'logs')
    if (fs.existsSync(path.join(v5Dir, 'parse.js'))) {
        const [parseMod, stateMod, applyMod] = await Promise.all([
            import(pathToFileURL(path.join(v5Dir, 'parse.js')).href),
            import(pathToFileURL(path.join(v5Dir, 'state.js')).href),
            import(pathToFileURL(path.join(v5Dir, 'apply.js')).href)
        ])
        return {
            parseLogLine: parseMod.parseLogLine,
            createRunState: stateMod.createRunState,
            summarizeRunState: stateMod.summarizeRunState,
            applyLogToRunState: applyMod.applyLogToRunState
        }
    }
    return import(pathToFileURL(path.join(root, 'scripts/api/logParser.js')).href)
}

export async function createRunRecorder(root, configFile) {
    const parser = await loadLogParser(root)
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
        let parsed = parser.parseLogLine(line, source)
        if (line.startsWith('__PANEL_WAIT__')) {
            try {
                const wait = JSON.parse(line.slice('__PANEL_WAIT__'.length))
                if (Number.isFinite(wait.seconds) && Number.isFinite(wait.sinceTs)) parsed = { title: 'PANEL-WAIT', level: 'info', platform: 'MAIN', message: JSON.stringify(wait) }
            } catch {}
        }
        const entry = { ...parsed, receivedAt: new Date().toISOString() }
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
            const run = guarded(() => {
                const detail = store.detail(id)
                const tasks = detail.tasks || []
                const completed = tasks.filter(t => ['completed', 'processed'].includes(t.state)).length
                const skipped = tasks.filter(t => ['skipped', 'already_done'].includes(t.state)).length
                const attention = tasks.filter(t => ['failed', 'partial', 'incomplete'].includes(t.state)).length
                const warnEvents = store.db.prepare("SELECT account,platform,level,title,message FROM activity_events WHERE run_id=? AND level IN ('warn','error') ORDER BY id").all(id)
                const sessionAlerts = detectRuntimeSessionInvalidations(detail.run, warnEvents)
                return { ...detail.run, taskSummary: { total: tasks.length, completed, skipped, attention }, sessionAlerts }
            })
            store.close()
            return run
        }
    }
}
