import fs from 'node:fs'
import path from 'node:path'
const fileFor = panelFile => path.join(path.dirname(panelFile), 'notifications.json')
const PROVIDERS = ['pushplus', 'serverchan', 'bark']
const DEFAULT_CONFIG = { provider: 'pushplus', enabled: false, onlyProblems: false, token: '', server: '' }
export function notificationConfig(panelFile) {
    const file = fileFor(panelFile)
    return fs.existsSync(file) ? { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) } : { ...DEFAULT_CONFIG }
}
export function notificationView(panelFile) {
    const config = notificationConfig(panelFile)
    let last = null
    try { last = JSON.parse(fs.readFileSync(path.join(path.dirname(panelFile), 'notification-result.json'), 'utf8')) } catch {}
    return { provider: config.provider, enabled: config.enabled, onlyProblems: config.onlyProblems, hasToken: Boolean(config.token), server: config.server || '', last }
}
export function saveNotifications(panelFile, body) {
    const bad = () => { throw Object.assign(new Error('通知设置无效，请检查渠道与密钥。'), { status: 422 }) }
    if (!body || !PROVIDERS.includes(body.provider) || typeof body.enabled !== 'boolean' || typeof body.onlyProblems !== 'boolean' || typeof body.token !== 'string') bad()
    if (body.clearToken != null && typeof body.clearToken !== 'boolean') bad()
    const previous = notificationConfig(panelFile)
    const token = body.clearToken ? '' : body.token.trim() || (previous.provider === body.provider ? previous.token : '')
    if (token && !/^[A-Za-z0-9_-]{8,256}$/.test(token)) bad()
    let server = previous.provider === body.provider ? previous.server || '' : ''
    if (body.provider === 'bark') {
        const raw = typeof body.server === 'string' ? body.server.trim() : ''
        const candidate = (raw || server).replace(/\/+$/, '')
        if (candidate) {
            let parsed
            try { parsed = new URL(candidate) } catch { bad() }
            if (!['http:', 'https:'].includes(parsed.protocol)) bad()
            server = candidate
        } else server = ''
        if (body.enabled && !server) throw Object.assign(new Error('Bark 需要填写服务器地址，例如 https://bark.example.com'), { status: 422 })
    } else server = ''
    if (body.enabled && !token) bad()
    const file = fileFor(panelFile), temp = `${file}.tmp`
    try { fs.writeFileSync(temp, JSON.stringify({ provider: body.provider, enabled: body.enabled, onlyProblems: body.onlyProblems, token, server }), { mode: 0o600 }); fs.renameSync(temp, file) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    return notificationView(panelFile)
}
async function deliver(config, title, content, fetcher) {
    if (config.provider === 'bark') {
        const response = await fetcher(`${config.server}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_key: config.token, title, body: content, group: 'Rewards 签到', level: 'active' }), signal: AbortSignal.timeout(8000), redirect: 'error' })
        if (!response.ok) throw new Error('通知渠道请求失败，请检查通知设置')
        const result = await response.json()
        if (Number(result.code) !== 200) throw new Error('通知渠道未接受消息，请检查密钥或渠道配额')
        return
    }
    const url = config.provider === 'serverchan' ? `https://sctapi.ft07.com/${config.token}.send` : 'https://www.pushplus.plus/send'
    const body = config.provider === 'serverchan' ? { title, desp: content } : { token: config.token, title, content, template: 'txt' }
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: 'error' })
    if (!response.ok) throw new Error('通知渠道请求失败，请检查通知设置')
    const result = await response.json()
    if (config.provider === 'pushplus' ? Number(result.code) !== 200 : Number(result.code) !== 0) throw new Error('通知渠道未接受消息，请检查密钥或渠道配额')
}
export async function notifyRun(panelFile, run, { fetcher = fetch } = {}) {
    const config = notificationConfig(panelFile)
    if (!config.enabled || !config.token || (config.provider === 'bark' && !config.server) || (config.onlyProblems && ['completed', 'cancelled'].includes(run.state))) return { skipped: true }
    const labels = { completed: '已完成', partial: '部分完成', failed: '运行失败', interrupted: '运行中断', cancelled: '已停止' }
    const title = `Rewards 签到${labels[run.state] || '已结束'}`
    // Summaries contain no email, raw logs, cookies or login codes.
    const content = `${run.day} · ${run.accounts?.length || 0} 个账号\n本轮确认积分：${run.points == null ? '待确认' : run.points}\n请打开控制台查看任务明细。`
    const resultFile = path.join(path.dirname(panelFile), 'notification-result.json')
    try {
        await deliver(config, title, content, fetcher)
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'sent' }), { mode: 0o600 })
        return { sent: true }
    } catch (error) {
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'failed' }), { mode: 0o600 })
        throw error
    }
}
