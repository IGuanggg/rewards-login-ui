import fs from 'node:fs'
import { createRequire } from 'node:module'
import { start, stopAll, waitForPort } from './runtime.mjs'

// Runs without Microsoft credentials or network login. Use inside the built image.
const require = createRequire('/opt/rewards/package.json')
const { chromium } = require('patchright')
const children = []
let browser
try {
    const display = start('Xvfb', [':98', '-screen', '0', '1366x900x24', '-nolisten', 'tcp', '-ac'])
    children.push(display)
    const until = Date.now() + 10000
    while (!fs.existsSync('/tmp/.X11-unix/X98')) {
        if (display.exitCode !== null || Date.now() > until) throw new Error('Xvfb failed')
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    const vnc = start('x11vnc', ['-display', ':98', '-localhost', '-rfbport', '5901', '-nopw', '-forever', '-quiet'])
    children.push(vnc)
    await waitForPort(5901, vnc)
    const web = start('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6081', '127.0.0.1:5901'])
    children.push(web)
    await waitForPort(6081, web)
    const response = await fetch('http://127.0.0.1:6081/vnc.html')
    if (!response.ok || !(await response.text()).includes('noVNC')) throw new Error('noVNC assets missing')
    for (const headless of [false, true]) {
        browser = await chromium.launch({ headless, env: { ...process.env, DISPLAY: ':98' }, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
        const page = await browser.newPage()
        await page.setContent('<title>Container browser ready</title><p>OK</p>')
        if (await page.title() !== 'Container browser ready') throw new Error('Browser page failed')
        await browser.close()
        browser = null
        console.log(`PASS Chromium ${headless ? 'headless' : 'headed'}`)
    }
    console.log('PASS Xvfb + x11vnc + noVNC; no Microsoft account used')
} catch (error) {
    console.error(error)
    process.exitCode = 1
} finally {
    await browser?.close().catch(() => {})
    await stopAll(children.reverse())
}
