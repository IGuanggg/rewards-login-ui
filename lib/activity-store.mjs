import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const TASKS = {
    'DAILY-SET': '每日任务', 'MORE-PROMOTIONS': '更多活动', 'APP-PROMOTIONS': '应用活动',
    'DAILY-CHECK-IN': '每日签到', 'READ-TO-EARN': '阅读赚积分', 'SEARCH-BING': 'Bing 搜索',
    'SEARCH-BONUS': '额外搜索', PUNCHCARD: '集章任务', 'CLAIM-BONUS-POINTS': '奖励积分',
    'CLAIM-REWARD': '领取奖励', 'URL-REWARD': '浏览任务', 'SEARCH-ON-BING': '主题搜索',
    'VISUAL-SEARCH': '图片搜索', 'APP-REWARD': '应用奖励', 'EDGE-BROWSING': 'Edge 浏览'
}
const POINT_SUMMARIES = new Set(['SEARCH-BING', 'SEARCH-BONUS', 'READ-TO-EARN', 'DAILY-CHECK-IN', 'CLAIM-BONUS-POINTS', 'VISUAL-SEARCH'])
const DAY_MS = 86400000

export function activityFile(configFile) {
    return process.env.PANEL_ACTIVITY_DB ? path.resolve(process.env.PANEL_ACTIVITY_DB) : path.join(path.dirname(configFile), 'activity.db')
}

export function dayAt(timestamp, timezone = 'Asia/Shanghai') {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp))
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
}

export function validDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
}

export function redactLog(value, secrets = []) {
    let text = String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '')
    for (const secret of secrets) if (String(secret).length >= 4) text = text.split(String(secret)).join('[已隐藏]')
    return text
        .replace(/\b(authorization|cookie)['"]?\s*[:=]\s*[^|\r\n]+/gi, '$1=[已隐藏]')
        .replace(/\b(password|passwd|totpSecret|access_token|refresh_token|id_token)['"]?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s|]+)/gi, '$1=[已隐藏]')
        .replace(/([?&](?:token|code|key|secret|access_token|refresh_token|id_token)=)[^\s&#]+/gi, '$1[已隐藏]')
        .slice(0, 8000)
}

export function classifyTask(entry) {
    const title = entry.title
    if (!TASKS[title]) return null
    const message = String(entry.message || '')
    let status = null
    if (entry.level === 'error' || /^Failed\b|^Error\b|^Background .*failed|^Unexpected .*failure/i.test(message)) status = 'failed'
    else if (/already (?:been )?complete|already complete/i.test(message)) status = 'already_done'
    else if (/^Skipping\b|^Skip\b|^No actionable|^Nothing claimed|\bskipping\b|not available for this account/i.test(message)) status = 'skipped'
    else if (/^Finished background/.test(message) && /serverComplete=false/.test(message)) status = 'partial'
    else if (/^Completed\b|^Daily Check-In completed|^Daily visual search done|search quota complete|^Reward claimed|^Quest .* COMPLETE\b/i.test(message)) status = 'completed'
    else if (/^Finished processing|^Finished background/i.test(message)) status = 'processed'
    else if (/^Starting\b|^Started\b|^Solving\b/.test(message)) status = 'running'
    const points = POINT_SUMMARIES.has(title) && /^(Completed\b|Daily Check-In completed|Daily visual search done|Nothing claimed)/.test(message)
        ? Number(/(?:^| \| )pointsGained=(-?\d+)(?: \| |$)/.exec(message)?.[1] ?? NaN) : NaN
    return { key: title, label: TASKS[title], status, points: Number.isFinite(points) ? points : null }
}

function publicSnapshot(snapshot, secrets) {
    return {
        collected: Number.isFinite(snapshot?.collected) ? snapshot.collected : null,
        finished: Boolean(snapshot?.finished),
        currentAccount: snapshot?.live?.currentAccount || null,
        accounts: (snapshot?.accounts || []).map(account => ({
            email: account.email, success: account.success ?? null,
            initialPoints: account.initialPoints ?? null, finalPoints: account.finalPoints ?? null,
            collectedPoints: account.collectedPoints ?? account.live?.gained ?? null,
            error: account.error ? redactLog(account.error, secrets) : null
        }))
    }
}

export class ActivityStore {
    constructor(file, { timezone = process.env.TZ || 'Asia/Shanghai', secrets = [], maxEvents = 20000 } = {}) {
        this.timezone = timezone
        dayAt(Date.now(), timezone)
        this.secrets = secrets
        this.maxEvents = maxEvents
        this.writes = 0
        this.prunedDay = ''
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
        this.db = new DatabaseSync(file)
        if (file !== ':memory:') { try { fs.chmodSync(file, 0o600) } catch {} }
        this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            PRAGMA foreign_keys=ON; PRAGMA cache_size=-1024; PRAGMA journal_size_limit=4194304;
            CREATE TABLE IF NOT EXISTS activity_runs (
                id TEXT PRIMARY KEY, day TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
                state TEXT NOT NULL, exit_code INTEGER, points INTEGER, snapshot TEXT NOT NULL DEFAULT '{}',
                last_event_id INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS activity_runs_day ON activity_runs(day, started_at);
            CREATE TABLE IF NOT EXISTS activity_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES activity_runs(id) ON DELETE CASCADE,
                at INTEGER NOT NULL, account TEXT NOT NULL, platform TEXT NOT NULL, level TEXT NOT NULL,
                title TEXT NOT NULL, message TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS activity_events_run ON activity_events(run_id, id);
            CREATE TABLE IF NOT EXISTS activity_tasks (
                run_id TEXT NOT NULL REFERENCES activity_runs(id) ON DELETE CASCADE,
                account TEXT NOT NULL, platform TEXT NOT NULL, category TEXT NOT NULL, label TEXT NOT NULL,
                state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                points INTEGER, errors INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL,
                PRIMARY KEY(run_id, account, platform, category));`)
    }

    begin(now = Date.now()) {
        this.prune(now)
        const id = randomUUID()
        this.db.prepare('INSERT INTO activity_runs(id,day,started_at,state,updated_at) VALUES(?,?,?,?,?)')
            .run(id, dayAt(now, this.timezone), now, 'running', now)
        return id
    }

    append(id, entry, snapshot = null, now = Date.now()) {
        const account = String(entry.account || entry.user || '')
        const platform = ['MAIN', 'MOBILE', 'DESKTOP'].includes(entry.platform) ? entry.platform : 'MAIN'
        const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
        const message = redactLog(entry.message, this.secrets)
        const title = String(entry.title || '').slice(0, 100)
        const task = classifyTask({ ...entry, message })
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const result = this.db.prepare('INSERT INTO activity_events(run_id,at,account,platform,level,title,message) VALUES(?,?,?,?,?,?,?)')
                .run(id, now, account, platform, level, title, message)
            this.db.prepare('UPDATE activity_runs SET last_event_id=?,updated_at=? WHERE id=?').run(Number(result.lastInsertRowid), now, id)
            if (task) {
                const old = this.db.prepare('SELECT * FROM activity_tasks WHERE run_id=? AND account=? AND platform=? AND category=?').get(id, account, platform, task.key)
                const errors = (old?.errors || 0) + (task.status === 'failed' ? 1 : 0)
                let state = task.status || old?.state || 'running'
                if (errors && ['completed', 'processed'].includes(state)) state = 'partial'
                this.db.prepare(`INSERT INTO activity_tasks(run_id,account,platform,category,label,state,started_at,updated_at,points,errors,message)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,account,platform,category) DO UPDATE SET
                    state=excluded.state,updated_at=excluded.updated_at,points=excluded.points,errors=excluded.errors,message=excluded.message`)
                    .run(id, account, platform, task.key, task.label, state, old?.started_at ?? now, now, task.points ?? old?.points ?? null, errors, message)
            }
            if (snapshot) {
                const safe = publicSnapshot(snapshot, this.secrets)
                const points = safe.accounts.length || snapshot.totals ? safe.collected : null
                this.db.prepare('UPDATE activity_runs SET points=?,snapshot=? WHERE id=?').run(points, JSON.stringify(safe), id)
            }
            this.db.exec('COMMIT')
        } catch (error) { this.db.exec('ROLLBACK'); throw error }
        if (++this.writes % 100 === 0) this.db.prepare('DELETE FROM activity_events WHERE run_id=? AND id NOT IN (SELECT id FROM activity_events WHERE run_id=? ORDER BY id DESC LIMIT ?)').run(id, id, this.maxEvents)
    }

    touch(id) { this.db.prepare("UPDATE activity_runs SET updated_at=? WHERE id=? AND state='running'").run(Date.now(), id) }

    finish(id, code, snapshot, { cancelled = false, now = Date.now() } = {}) {
        const safe = publicSnapshot(snapshot, this.secrets)
        const issues = this.db.prepare("SELECT count(*) AS n FROM activity_tasks WHERE run_id=? AND state IN ('running','failed','partial','incomplete')").get(id).n
        const state = cancelled ? 'cancelled' : code !== 0 ? 'failed'
            : !safe.finished || issues || safe.accounts.some(account => account.success !== true) ? 'partial' : 'completed'
        this.db.prepare('UPDATE activity_runs SET ended_at=?,updated_at=?,state=?,exit_code=?,points=?,snapshot=? WHERE id=?')
            .run(now, now, state, code, safe.accounts.length || snapshot?.totals ? safe.collected : null, JSON.stringify(safe), id)
        this.db.prepare("UPDATE activity_tasks SET state=?,updated_at=? WHERE run_id=? AND state='running'")
            .run(cancelled ? 'cancelled' : 'incomplete', now, id)
    }

    interruptRunning() {
        const now = Date.now()
        this.db.prepare("UPDATE activity_tasks SET state='incomplete',updated_at=? WHERE run_id IN (SELECT id FROM activity_runs WHERE state='running') AND state='running'").run(now)
        this.db.prepare("UPDATE activity_runs SET state='interrupted',ended_at=?,updated_at=? WHERE state='running'").run(now, now)
    }

    expireStale() {
        const now = Date.now()
        const cutoff = now - 90000
        this.db.prepare("UPDATE activity_tasks SET state='incomplete',updated_at=? WHERE run_id IN (SELECT id FROM activity_runs WHERE state='running' AND updated_at<?) AND state='running'").run(now, cutoff)
        this.db.prepare("UPDATE activity_runs SET state='interrupted',ended_at=?,updated_at=? WHERE state='running' AND updated_at<?").run(now, now, cutoff)
    }

    prune(now = Date.now()) {
        this.db.prepare('DELETE FROM activity_runs WHERE day < ?').run(dayAt(now - 29 * DAY_MS, this.timezone))
        this.prunedDay = dayAt(now, this.timezone)
    }

    runView(row) {
        if (!row) return null
        return { id: row.id, day: row.day, startedAt: row.started_at, endedAt: row.ended_at,
            state: row.state, exitCode: row.exit_code, points: row.points, updatedAt: row.updated_at,
            revision: row.last_event_id, ...JSON.parse(row.snapshot) }
    }

    day(day = dayAt(Date.now(), this.timezone)) {
        if (!validDay(day)) throw Object.assign(new Error('日期格式不正确'), { status: 422 })
        if (this.prunedDay !== dayAt(Date.now(), this.timezone)) this.prune()
        this.expireStale()
        const totals = this.db.prepare(`SELECT count(*) AS runs, sum(points) AS points, count(points) AS reportedRuns,
            sum(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running,
            sum(CASE WHEN state IN ('failed','partial','interrupted') AND NOT EXISTS
                (SELECT 1 FROM activity_tasks t WHERE t.run_id=activity_runs.id AND t.state IN ('failed','partial','incomplete'))
                THEN 1 ELSE 0 END) AS failedRuns FROM activity_runs WHERE day=?`).get(day)
        const tasks = this.db.prepare(`SELECT count(*) AS tasks,
            sum(CASE WHEN t.state IN ('failed','partial','incomplete') THEN 1 ELSE 0 END) AS attention,
            sum(CASE WHEN t.state IN ('skipped','already_done') THEN 1 ELSE 0 END) AS skipped
            FROM activity_tasks t JOIN activity_runs r ON r.id=t.run_id WHERE r.day=?`).get(day)
        return { day, today: dayAt(Date.now(), this.timezone), timezone: this.timezone, retentionDays: 30,
            summary: { ...totals, ...tasks },
            runs: this.db.prepare('SELECT * FROM activity_runs WHERE day=? ORDER BY started_at DESC LIMIT 100').all(day).map(row => this.runView(row)) }
    }

    latest() {
        this.expireStale()
        const row = this.db.prepare('SELECT id FROM activity_runs ORDER BY started_at DESC LIMIT 1').get()
        return row ? this.detail(row.id) : null
    }

    overview(now = Date.now()) {
        this.expireStale()
        const today = dayAt(now, this.timezone)
        const days = Array.from({ length: 14 }, (_, i) => dayAt(now - (13 - i) * DAY_MS, this.timezone))
        const rows = this.db.prepare('SELECT * FROM activity_runs ORDER BY started_at DESC').all()
        const trend = days.map(day => {
            const selected = rows.filter(row => row.day === day)
            const reported = selected.filter(row => row.points != null)
            return { day, runs: selected.length, points: reported.length ? reported.reduce((n, row) => n + row.points, 0) : null }
        })
        const byAccount = new Map()
        for (const row of rows) {
            for (const account of JSON.parse(row.snapshot).accounts || []) {
                if (!account.email) continue
                const key = account.email.toLowerCase()
                const view = byAccount.get(key) || { email: account.email, todayPoints: null, balance: null, balanceAt: null, lastState: row.state }
                if (view.balance == null && Number.isFinite(account.finalPoints)) { view.balance = account.finalPoints; view.balanceAt = row.ended_at || row.updated_at }
                if (row.day === today && Number.isFinite(account.collectedPoints)) view.todayPoints = (view.todayPoints ?? 0) + account.collectedPoints
                byAccount.set(key, view)
            }
        }
        return { today, timezone: this.timezone, trend, accounts: [...byAccount.values()],
            todayPoints: trend.at(-1).points, todayRuns: trend.at(-1).runs,
            attention: this.day(today).summary.attention || 0,
            latest: rows.length ? this.runView(rows[0]) : null }
    }

    progress(id) {
        const last = this.db.prepare('SELECT at,title,message FROM activity_events WHERE run_id=? ORDER BY id DESC LIMIT 1').get(id)
        if (!last) return null
        const wait = this.db.prepare("SELECT message FROM activity_events WHERE run_id=? AND title='PANEL-WAIT' ORDER BY id DESC LIMIT 1").get(id)
        try {
            const value = JSON.parse(wait?.message || 'null')
            if (value && value.sinceTs + value.seconds * 1000 > Date.now()) last.wait = value
        } catch {}
        return last
    }

    detail(id) {
        const run = this.runView(this.db.prepare('SELECT * FROM activity_runs WHERE id=?').get(id))
        if (!run) throw Object.assign(new Error('未找到这轮签到记录'), { status: 404 })
        const tasks = this.db.prepare('SELECT * FROM activity_tasks WHERE run_id=? ORDER BY started_at,account,platform LIMIT 1000').all(id)
            .map(row => ({ account: row.account, platform: row.platform, category: row.category, label: row.label,
                state: row.state, startedAt: row.started_at, updatedAt: row.updated_at, points: row.points, message: row.message }))
        return { run, tasks }
    }

    logs(id, { before = Number.MAX_SAFE_INTEGER, level = 'all' } = {}) {
        this.detail(id)
        const rows = this.db.prepare(`SELECT id,at,account,platform,level,title,message FROM activity_events
            WHERE run_id=? AND id<? AND (?='all' OR level=?) ORDER BY id DESC LIMIT 201`).all(id, before, level, level)
        const more = rows.length > 200
        const logs = rows.slice(0, 200).reverse()
        return { logs, nextBefore: more ? logs[0].id : null }
    }

    close() { this.db.close() }
}
