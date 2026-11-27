import fs from 'node:fs'
import path from 'node:path'

const DAY_MS = 86400000
const DEFAULT_WARNING_DAYS = 3
const BING_PROBE_URL = 'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
const MSA_AUTH_COOKIES = new Set([
    'MSPAuth',
    'WLSSC',
    'RPSSecAuth',
    'KievRPSSecAuth',
    'ESTSAUTH',
    'ESTSAUTHPERSISTENT'
])
const BING_HOSTS = new Set(['www.bing.com', 'cn.bing.com'])

const RUNTIME_INVALID_RE = [
    /SIGN_IN_METHOD_PICKER/i,
    /Passwordless authentication timeout/i,
    /No supported non-interactive sign-in method/i,
    /Login failed or aborted/i,
    /Cookies?\s+expired/i,
    /session\s+expired/i,
    /Invalid\s+session/i,
    /authentication\s+required/i,
    /re-?authenticate/i,
    /Redirected to login/i,
    /login\.live\.com/i,
    /login\.microsoftonline\.com/i,
    /account requires manual sign-?in/i
]

const RUNTIME_EXCLUDE_RE = [
    /Run cancelled/i,
    /The operation was aborted/i,
    /Bing request left the authenticated Bing session/i,
    /reqwest::Error/i,
    /\bETIMEDOUT\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b/i
]

const healthFileFor = panelFile => path.join(path.dirname(panelFile), 'session-health.json')
const alertStateFileFor = panelFile => path.join(path.dirname(panelFile), 'session-alert-state.json')

function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    try {
        fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
        try { fs.chmodSync(temp, 0o600) } catch {}
        fs.renameSync(temp, file)
    } finally {
        if (fs.existsSync(temp)) { try { fs.unlinkSync(temp) } catch {} }
    }
}

export function readSessionHealthMap(panelFile) {
    if (!panelFile) return {}
    const file = healthFileFor(panelFile)
    if (!fs.existsSync(file)) return {}
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

export function recordSessionHealth(panelFile, updates = []) {
    if (!panelFile || !Array.isArray(updates) || !updates.length) return readSessionHealthMap(panelFile)
    const map = readSessionHealthMap(panelFile)
    for (const item of updates) {
        const emailKey = String(item?.email || '').trim().toLowerCase()
        const platform = item?.platform
        if (!emailKey || !['mobile', 'desktop'].includes(platform)) continue
        if (!map[emailKey] || typeof map[emailKey] !== 'object') map[emailKey] = {}
        map[emailKey][platform] = {
            status: item.status,
            reason: item.reason || null,
            sessionUpdatedAt: Number.isFinite(Number(item.sessionUpdatedAt)) ? Number(item.sessionUpdatedAt) : null,
            checkedAt: Number.isFinite(Number(item.checkedAt)) ? Number(item.checkedAt) : Date.now(),
            source: item.source || 'probe',
            balance: Number.isFinite(Number(item.balance)) ? Number(item.balance) : null
        }
    }
    atomicJson(healthFileFor(panelFile), map)
    return map
}

export function clearSessionHealth(panelFile, email, platforms = ['mobile', 'desktop']) {
    if (!panelFile || !email) return
    const map = readSessionHealthMap(panelFile)
    const emailKey = String(email).trim().toLowerCase()
    if (!map[emailKey]) return
    for (const platform of platforms) delete map[emailKey][platform]
    if (!Object.keys(map[emailKey]).length) delete map[emailKey]
    atomicJson(healthFileFor(panelFile), map)
}

function domainMatches(cookieDomain, suffix) {
    const d = String(cookieDomain || '').trim().toLowerCase().replace(/^\.+/, '')
    return d === suffix || d.endsWith(`.${suffix}`)
}

export function inspectCookieHealth(rawStorage, { updatedAt = null, now = Date.now(), warningDays = DEFAULT_WARNING_DAYS, overlay = null } = {}) {
    if (rawStorage == null || rawStorage === '') {
        return { ok: false, cookies: 0, status: 'missing', reason: '会话内容为空', expiresAt: null, daysLeft: null, checkedAt: null, checkSource: 'local', probedBalance: null }
    }
    let parsed
    try {
        parsed = typeof rawStorage === 'string' ? JSON.parse(rawStorage) : rawStorage
    } catch {
        return { ok: false, cookies: 0, status: 'missing', reason: '会话内容无法解析', expiresAt: null, daysLeft: null, checkedAt: null, checkSource: 'local', probedBalance: null }
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
        return { ok: false, cookies: 0, status: 'missing', reason: '会话结构不完整', expiresAt: null, daysLeft: null, checkedAt: null, checkSource: 'local', probedBalance: null }
    }
    const usable = parsed.cookies.filter(cookie => cookie && typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
    if (!usable.length) {
        return { ok: false, cookies: 0, status: 'missing', reason: '没有可用 Cookie', expiresAt: null, daysLeft: null, checkedAt: null, checkSource: 'local', probedBalance: null }
    }

    let bingExp = null
    let msaExp = null
    for (const cookie of usable) {
        const expSec = Number(cookie.expires)
        if (!Number.isFinite(expSec) || expSec <= 0) continue
        const expMs = expSec * 1000
        if (cookie.name === '_U' && domainMatches(cookie.domain, 'bing.com')) {
            bingExp = bingExp == null ? expMs : Math.max(bingExp, expMs)
        }
        if (
            MSA_AUTH_COOKIES.has(cookie.name) &&
            (domainMatches(cookie.domain, 'live.com') || domainMatches(cookie.domain, 'microsoftonline.com') || domainMatches(cookie.domain, 'bing.com'))
        ) {
            msaExp = msaExp == null ? expMs : Math.max(msaExp, expMs)
        }
    }

    const criticalExps = [bingExp, msaExp].filter(value => value != null)
    const earliestExp = criticalExps.length ? Math.min(...criticalExps) : null
    const daysLeft = earliestExp != null ? Math.max(0, Math.round(((earliestExp - now) / DAY_MS) * 10) / 10) : null

    let status = 'valid'
    let reason = null
    if (criticalExps.length && criticalExps.every(exp => exp <= now)) {
        status = 'expired'
        reason = '关键登录 Cookie 已过期，需重新授权'
    } else if (bingExp != null && bingExp <= now) {
        status = 'expiring'
        reason = 'Bing 登录 Cookie (_U) 已过期，建议检测或重新授权'
    } else if (earliestExp != null && earliestExp - now <= warningDays * DAY_MS) {
        const ceilDays = Math.max(0, Math.ceil((earliestExp - now) / DAY_MS))
        status = 'expiring'
        reason = ceilDays <= 1 ? 'Cookie 将在 24 小时内过期，请及时重新授权' : `Cookie 即将过期（剩 ${ceilDays} 天）`
    }

    let checkedAt = null
    let checkSource = 'local'
    let probedBalance = null
    const overlayFresh =
        overlay &&
        typeof overlay === 'object' &&
        (overlay.sessionUpdatedAt == null || updatedAt == null || Number(updatedAt) <= Number(overlay.sessionUpdatedAt))

    if (overlayFresh) {
        checkedAt = overlay.checkedAt || null
        checkSource = overlay.source || 'probe'
        probedBalance = Number.isFinite(Number(overlay.balance)) ? Number(overlay.balance) : null
        if (overlay.status === 'invalid') {
            status = 'invalid'
            reason = overlay.reason || '会话已失效，需重新授权'
        }
    }

    return {
        ok: true,
        cookies: usable.length,
        status,
        reason,
        expiresAt: earliestExp,
        daysLeft,
        checkedAt,
        checkSource,
        probedBalance
    }
}

function isRuntimeInvalidMessage(text) {
    const value = String(text || '').trim()
    if (!value) return false
    if (RUNTIME_EXCLUDE_RE.some(pattern => pattern.test(value)) && !/SIGN_IN_METHOD_PICKER|Passwordless authentication timeout|No supported non-interactive|login\.live\.com|login\.microsoftonline\.com/i.test(value)) {
        return false
    }
    return RUNTIME_INVALID_RE.some(pattern => pattern.test(value))
}

function summarizeInvalidReason(text) {
    const value = String(text || '')
    if (/SIGN_IN_METHOD_PICKER/i.test(value)) return '需要手动选择登录方式（会话已失效）'
    if (/Passwordless authentication timeout/i.test(value)) return '无密码确认超时（会话已失效）'
    if (/No supported non-interactive sign-in method/i.test(value)) return '登录态失效，需要重新完成交互授权'
    if (/Cookies?\s+expired|session\s+expired|Invalid\s+session/i.test(value)) return '登录会话已过期，需重新授权'
    if (/login\.live\.com|login\.microsoftonline\.com|Redirected to login/i.test(value)) return '请求被重定向至微软登录页，需重新授权'
    return '登录校验失败（会话可能已失效），需重新授权'
}

export function detectRuntimeSessionInvalidations(run, events = []) {
    const hits = new Map()
    const add = (email, platform, message) => {
        const cleanEmail = String(email || '').trim()
        if (!cleanEmail || !cleanEmail.includes('@')) return
        const normPlatform = platform === 'MOBILE' || platform === 'mobile' ? 'mobile' : platform === 'DESKTOP' || platform === 'desktop' ? 'desktop' : null
        if (!normPlatform) return
        const key = `${cleanEmail.toLowerCase()}|${normPlatform}`
        if (!hits.has(key)) {
            hits.set(key, {
                email: cleanEmail,
                platform: normPlatform,
                status: 'invalid',
                reason: summarizeInvalidReason(message),
                source: 'runtime'
            })
        }
    }

    const authTitles = new Set(['LOGIN', 'LOGIN-BING', 'LOGIN-APP', 'GET-APP-TOKEN', 'SESSION', 'FLOW'])
    for (const event of Array.isArray(events) ? events : []) {
        if (!event || !['warn', 'error'].includes(event.level)) continue
        if (!authTitles.has(event.title) && !isRuntimeInvalidMessage(event.message)) continue
        if (!isRuntimeInvalidMessage(event.message)) continue
        const msg = String(event.message || '')
        if (event.platform === 'MOBILE' || event.platform === 'DESKTOP') {
            add(event.account, event.platform, msg)
        } else if (/\bmobile\b/i.test(msg)) {
            add(event.account, 'mobile', msg)
        } else if (/\bdesktop\b/i.test(msg)) {
            add(event.account, 'desktop', msg)
        } else {
            add(event.account, 'mobile', msg)
            add(event.account, 'desktop', msg)
        }
    }

    const emailsHit = new Set([...hits.values()].map(item => item.email.toLowerCase()))
    for (const account of Array.isArray(run?.accounts) ? run.accounts : []) {
        if (!account?.email || !account?.error) continue
        if (!isRuntimeInvalidMessage(account.error)) continue
        if (emailsHit.has(account.email.toLowerCase())) continue
        const msg = String(account.error)
        const mentionsMobile = /\bmobile\b|手机/i.test(msg)
        const mentionsDesktop = /\bdesktop\b|电脑/i.test(msg)
        if (mentionsMobile && !mentionsDesktop) add(account.email, 'mobile', msg)
        else if (mentionsDesktop && !mentionsMobile) add(account.email, 'desktop', msg)
        else {
            add(account.email, 'mobile', msg)
            add(account.email, 'desktop', msg)
        }
    }

    return [...hits.values()]
}

function extractUserAgent(fingerprint, platform) {
    try {
        const parsed = typeof fingerprint === 'string' ? JSON.parse(fingerprint) : fingerprint
        const ua = parsed?.fingerprint?.navigator?.userAgent || parsed?.headers?.['user-agent'] || parsed?.headers?.['User-Agent']
        if (typeof ua === 'string' && ua.trim()) return ua.trim()
    } catch {}
    return platform === 'mobile'
        ? 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0'
}

export async function probeBingSession({ storageState, fingerprint = null, platform = 'desktop', fetcher = fetch, now = Date.now() } = {}) {
    let parsed
    try {
        parsed = typeof storageState === 'string' ? JSON.parse(storageState) : storageState
    } catch {
        return { status: 'invalid', reason: '会话数据损坏，无法探测', balance: null }
    }
    const nowSec = now / 1000
    const cookies = (Array.isArray(parsed?.cookies) ? parsed.cookies : []).filter(
        cookie =>
            cookie &&
            typeof cookie.name === 'string' &&
            cookie.name &&
            typeof cookie.value === 'string' &&
            cookie.value &&
            domainMatches(cookie.domain, 'bing.com') &&
            (!cookie.expires || Number(cookie.expires) <= 0 || Number(cookie.expires) > nowSec)
    )
    if (!cookies.length) {
        return { status: 'invalid', reason: '缺少有效的 Bing 登录 Cookie，需重新授权', balance: null }
    }

    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    const ua = extractUserAgent(fingerprint, platform)
    let url = BING_PROBE_URL

    try {
        for (let hop = 0; hop < 4; hop++) {
            const response = await fetcher(url, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': ua,
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    Cookie: cookieHeader
                },
                signal: AbortSignal.timeout(8000)
            })
            const location = response.headers?.get?.('location')
            if (response.status >= 300 && response.status < 400 && location) {
                const nextUrl = new URL(location, url)
                if (!BING_HOSTS.has(nextUrl.hostname.toLowerCase())) {
                    return { status: 'invalid', reason: 'Bing 会话已跳转至登录页，需重新授权', balance: null }
                }
                url = nextUrl.href
                continue
            }
            if (response.status === 401 || response.status === 403) {
                return { status: 'invalid', reason: `服务端拒绝当前会话（HTTP ${response.status}），需重新授权`, balance: null }
            }
            if (!response.ok) {
                return { status: 'error', reason: `探测接口暂时异常（HTTP ${response.status}），未改动状态`, balance: null }
            }
            const text = await response.text()
            let data = null
            try { data = JSON.parse(text) } catch {}
            if (!data || typeof data !== 'object') {
                return { status: 'error', reason: '探测响应格式异常，未改动状态', balance: null }
            }
            const isRewardsUser = data.userInfo?.isRewardsUser ?? data.isRewardsUser
            if (isRewardsUser === true) {
                const balance = Number(data.userInfo?.balance)
                return { status: 'valid', reason: null, balance: Number.isFinite(balance) ? balance : null }
            }
            if (isRewardsUser === false) {
                return { status: 'invalid', reason: 'Bing 会话已失效（未处于登录状态），需重新授权', balance: null }
            }
            return { status: 'error', reason: '无法确认登录态，未改动状态', balance: null }
        }
        return { status: 'error', reason: '重定向次数过多，未改动状态', balance: null }
    } catch (error) {
        return { status: 'error', reason: `网络探测失败（${error?.name === 'TimeoutError' ? '超时' : '连接异常'}），未改动状态`, balance: null }
    }
}

export function collectSessionAlerts(accounts = [], { includeExpiring = true } = {}) {
    const alerts = []
    for (const account of accounts) {
        if (!account?.email) continue
        for (const platform of ['mobile', 'desktop']) {
            const session = account.sessions?.[platform]
            if (!session) continue
            const st = session.status
            if (st === 'invalid' || st === 'expired' || (includeExpiring && st === 'expiring')) {
                alerts.push({
                    email: account.email,
                    platform,
                    status: st,
                    daysLeft: session.daysLeft ?? null,
                    reason: session.reason || (st === 'invalid' ? '会话已失效，需重新授权' : st === 'expired' ? 'Cookie 已过期，需重新授权' : 'Cookie 即将过期')
                })
            }
        }
    }
    return alerts
}

const alertKey = item => `${String(item.email || '').toLowerCase()}|${item.platform}|${item.status}`

export function filterNewDailyAlerts(panelFile, alerts = [], { day, force = false } = {}) {
    if (!alerts.length) return []
    if (force || !panelFile) return alerts
    const file = alertStateFileFor(panelFile)
    let saved = null
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!saved || saved.day !== day || !Array.isArray(saved.keys)) return alerts
    const seen = new Set(saved.keys)
    return alerts.filter(item => !seen.has(alertKey(item)))
}

export function markDailyAlertsSent(panelFile, alerts = [], { day } = {}) {
    if (!panelFile || !alerts.length || !day) return
    const file = alertStateFileFor(panelFile)
    let keys = []
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (saved?.day === day && Array.isArray(saved.keys)) keys = saved.keys
    } catch {}
    const merged = [...new Set([...keys, ...alerts.map(alertKey)])]
    atomicJson(file, { day, keys: merged, updatedAt: Date.now() })
}
