import fs from 'node:fs'
import path from 'node:path'
import { lowMemoryConfig, writeJson, start, stopAll, waitForPort } from './runtime.mjs'
import { createRunRecorder } from '../lib/run-recorder.mjs'

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
        const display = start('Xvfb', [':99', '-screen', '0', '1366x900x24', '-nolisten', 'tcp', '-ac'])
        children.push(display)
        const until = Date.now() + 12000
        while (!fs.existsSync('/tmp/.X11-unix/X99')) {
            if (stopping || display.exitCode !== null || Date.now() > until) throw new Error('虚拟显示器未能启动')
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (stopping) throw new Error('授权已取消')
        const vnc = start('x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-nopw', '-forever', '-shared', '-noxdamage', '-quiet'])
        children.push(vnc)
        await waitForPort(5900, vnc)
        if (stopping) throw new Error('授权已取消')
        const web = start('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900'])
        children.push(web)
        await waitForPort(6080, web)
        if (stopping) throw new Error('授权已取消')
        console.log('__PANEL_DESKTOP_READY__ 在面板点击“打开远程浏览器”完成登录。')
    } else {
        const file = path.join(root, 'config.json')
        writeJson(file, lowMemoryConfig(JSON.parse(fs.readFileSync(file, 'utf8'))))
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
        ...children.filter(child => child !== browser).map(child => child.done.then(() => ({ code: 1 })))
    ])
    if (!stopping) await stop(first.code)
} catch (error) {
    console.error(`[ERROR] ${error.message}`)
    if (!stopping) await stop(1)
} finally {
    await stop(result)
    if (browserClosed) await browserClosed
    recorder?.finish(result, cancelled)
    clearTimeout(timeout)
}
process.exitCode = result
