import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lowMemoryConfig, writeJson, start, stopAll, waitForPort } from './runtime.mjs'
import { createRunRecorder } from '../lib/run-recorder.mjs'
import { notifyRun, notifySessionAlerts } from '../lib/notifications.mjs'
import { recordSessionHealth } from '../lib/session-health.mjs'
import { readQueryMode } from '../lib/task-settings.mjs'

const root = process.env.BOT_DIR || '/opt/rewards'
const mode = process.argv[2]
const children = []
let stopping = false
let result = 1
let timeout
let cleanup
let recorder
let browserClosed
let cancelled = false

function stop(code) {
    if (stopping) return cleanup
    stopping = true
    result = code
    clearTimeout(timeout)
    cleanup = stopAll([...children].reverse())
    return cleanup
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cancelled = true; void stop(143) })

function startQuiet(command, args, options = {}) {
    const child = start(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    child._tail = ''
    const collect = chunk => {
        child._tail = (child._tail + chunk.toString('utf8')).slice(-2048)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    return child
}

try {
    if (!['login', 'bot'].includes(mode)) throw new Error('Worker mode must be login or bot')
    const env = { ...process.env }
    if (mode === 'login') {
        const minutes = Number(process.env.LOGIN_TIMEOUT_MINUTES || 15)
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('LOGIN_TIMEOUT_MINUTES must be between 1 and 60')
        timeout = setTimeout(() => {
            console.error('[ERROR] 授权超时，正在关闭远程浏览器并释放资源。')
            void stop(124)
        }, minutes * 60000)
        env.DISPLAY = ':99'
        const display = startQuiet('Xvfb', [':99', '-screen', '0', '1366x900x24', '-nolisten', 'tcp', '-ac'])
        children.push(display)
        const until = Date.now() + 12000
        while (!fs.existsSync('/tmp/.X11-unix/X99')) {
            if (stopping || display.exitCode !== null || Date.now() > until) {
                if (!stopping && display._tail.trim()) console.error(display._tail.trim())
                throw new Error('虚拟显示器未能启动')
            }
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (stopping) throw new Error('授权已取消')
        const vnc = startQuiet('x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-nopw', '-forever', '-shared', '-noxdamage', '-quiet'])
        children.push(vnc)
        try { await waitForPort(5900, vnc) } catch (err) {
            if (!stopping && vnc._tail.trim()) console.error(vnc._tail.trim())
            throw err
        }
        if (stopping) throw new Error('授权已取消')
        const web = startQuiet('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900'])
        children.push(web)
        try { await waitForPort(6080, web) } catch (err) {
            if (!stopping && web._tail.trim()) console.error(web._tail.trim())
            throw err
        }
        if (stopping) throw new Error('授权已取消')
        console.log('__PANEL_DESKTOP_READY__ 在面板点击“打开远程浏览器”完成登录。')
    } else {
        const file = path.join(root, 'config.json')
        const config = lowMemoryConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
        const panelFile = process.env.PANEL_CONFIG || '/data/panel.json'
        env.PANEL_QUERY_MODE = readQueryMode(panelFile, config) || 'existing'
        writeJson(file, config)
        delete env.DISPLAY
        env.FORCE_HEADLESS = '1'
    }
    if (stopping) throw new Error('Worker stopped')
    const script = path.join(root, mode === 'login' ? 'scripts/main/manualLogin.js' : 'dist/index.js')
    if (mode === 'bot') {
        try { recorder = await createRunRecorder(root, process.env.PANEL_CONFIG || '/data/panel.json') }
        catch (error) { console.error(`[activity] 无法创建运行记录：${error.message}`) }
    }
    if (stopping) throw new Error('Worker stopped')
    const browser = start(process.execPath, [script, ...process.argv.slice(3)], {
        cwd: root, env, ...(recorder ? { stdio: ['ignore', 'pipe', 'pipe'] } : {})
    })
    browserClosed = new Promise(resolve => browser.once('close', resolve))
    recorder?.attach(browser)
    children.push(browser)
    // A failed display/proxy must also end the browser, not leave a hidden task.
    const first = await Promise.race([
        browser.done.then(code => ({ code })),
        ...children.filter(child => child !== browser).map(child => child.done.then(() => {
            if (!stopping && child._tail?.trim()) console.error(child._tail.trim())
            return { code: 1 }
        }))
    ])
    if (!stopping) await stop(first.code)
} catch (error) {
    console.error(`[ERROR] ${error.message}`)
    if (!stopping) await stop(1)
} finally {
    await stop(result)
    if (browserClosed) await browserClosed
    const run = recorder?.finish(result, cancelled)
    if (run) {
        const panelFile = process.env.PANEL_CONFIG || '/data/panel.json'
        if (Array.isArray(run.sessionAlerts) && run.sessionAlerts.length) {
            try {
                const sessionTimestamps = new Map()
                try {
                    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'))
                    const dbPath = path.resolve(root, cfg.sessionPath || 'sessions', 'sessions.db')
                    if (fs.existsSync(dbPath)) {
                        const sdb = new DatabaseSync(dbPath, { readOnly: true })
                        try {
                            for (const row of sdb.prepare('SELECT email, platform, updated_at FROM sessions').all()) {
                                sessionTimestamps.set(`${String(row.email).toLowerCase()}|${row.platform}`, Number(row.updated_at) || null)
                            }
                        } finally { sdb.close() }
                    }
                } catch {}
                recordSessionHealth(panelFile, run.sessionAlerts.map(item => ({
                    ...item,
                    sessionUpdatedAt: sessionTimestamps.get(`${item.email.toLowerCase()}|${item.platform}`) ?? null,
                    checkedAt: Date.now()
                })))
            } catch (error) {
                console.error(`[session-health] 写入会话失效状态失败：${error.message}`)
            }
        }
        let runNotified = false
        try {
            const sent = await notifyRun(panelFile, run)
            runNotified = Boolean(sent?.sent)
        } catch {
            console.error('[notification] 通知发送失败；签到结果已保存，请检查通知渠道设置。')
        }
        if (Array.isArray(run.sessionAlerts) && run.sessionAlerts.length && !runNotified) {
            try { await notifySessionAlerts(panelFile, run.sessionAlerts, { source: 'runtime' }) }
            catch { console.error('[notification] 会话失效提醒发送失败，请检查通知渠道设置。') }
        }
    }
    clearTimeout(timeout)
}
process.exitCode = result
