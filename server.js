/**
 * Rewards 登录面板 · 本地服务（v2）
 * ------------------------------------------------------------
 * 零依赖，仅 Node.js 内置模块。职责：
 *   1. 面板自身访问鉴权（Cookie 会话，与上游 Control API 令牌分离）；
 *   2. 严格校验上游仓库结构，只在合法实例里读写 .env；
 *   3. 写入 .env 前拒绝控制字符，并按上游解析规则序列化；
 *   4. 以子进程运行 scripts/main/manualLogin.js，SSE 推送输出；
 *   5. 登录结果以 sessions.db 实际写入为准，而非退出码；
 *   6. 只读展示上游 config.json 指定的 sessionPath；
 *   7. 环境自检（仓库 / Node / 依赖 / Chromium / 构建产物）。
 *
 * 安全：默认只监听 127.0.0.1。会写 .env 并启动浏览器进程。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createDesktopProxy } from './lib/desktop-proxy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
// PANEL_CONFIG 可把面板自身配置挪到别处（自动化验收测试用它做隔离）
const CONFIG_FILE = process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG) : path.join(__dirname, 'config.json')

const HOST = process.env.PANEL_HOST || '127.0.0.1'
const PORT = Number(process.env.PANEL_PORT || 4173)
const AUTH_DISABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.PANEL_NO_AUTH || '').toLowerCase())
const REMOTE_DESKTOP = process.env.PANEL_REMOTE_DESKTOP === '1'

const SESSION_COOKIE = 'panel_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_JOB_LOG = 400
const MAX_BODY = 1_000_000

/* ────────────────────────── 基础工具 ────────────────────────── */

function log(...args) {
    console.log(`[panel ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args)
}

function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    })
    res.end(body)
}

function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', chunk => {
            size += chunk.length
            if (size > limit) {
                reject(Object.assign(new Error('请求体过大'), { status: 413 }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) return resolve({})
            try {
                resolve(JSON.parse(raw))
            } catch {
                reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
            }
        })
        req.on('error', reject)
    })
}

const sameSecret = (a, b) => {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
}

/* ────────────────────────── 持久配置 ────────────────────────── */

function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function writePrivateFile(file, text) {
    fs.writeFileSync(file, text, { mode: 0o600 })
    try {
        fs.chmodSync(file, 0o600)
    } catch {}
}

const MIN_PANEL_TOKEN = 8

const state = {
    botDir: '',
    controlApi: '',
    controlToken: '',
    panelToken: ''
}

function loadConfig() {
    const raw = readJsonSafe(CONFIG_FILE) || {}
    state.botDir = typeof raw.botDir === 'string' ? raw.botDir : ''
    state.controlApi = typeof raw.controlApi === 'string' ? raw.controlApi : ''
    state.controlToken = typeof raw.controlToken === 'string' ? raw.controlToken : ''
    // 与修改接口同一规则：不少于 8 位就保留，绝不因为更短而静默换成新密码
    state.panelToken = typeof raw.panelToken === 'string' && raw.panelToken.trim().length >= MIN_PANEL_TOKEN ? raw.panelToken.trim() : ''
}

function saveConfig() {
    writePrivateFile(
        CONFIG_FILE,
        JSON.stringify(
            {
                botDir: state.botDir,
                controlApi: state.controlApi,
                controlToken: state.controlToken,
                panelToken: state.panelToken
            },
            null,
            4
        ) + '\n'
    )
}

// 首次启动生成面板访问密码：环境变量优先，其次 config.json，最后随机生成并落盘
function ensurePanelToken() {
    const fromEnv = String(process.env.PANEL_TOKEN || '').trim()
    if (fromEnv) {
        state.panelToken = fromEnv
        return { token: fromEnv, generated: false, source: 'PANEL_TOKEN' }
    }
    if (state.panelToken) return { token: state.panelToken, generated: false, source: 'config.json' }

    const token = randomBytes(12).toString('base64url')
    state.panelToken = token
    saveConfig()
    return { token, generated: true, source: 'generated' }
}

/* ────────────────────────── 面板鉴权 ────────────────────────── */

// 会话签名材料：每次进程启动都重新生成。
// 重启后旧 Cookie 一律失效；退出登录再换一次，当前进程里已签发的 Cookie 也立刻失效。
let sessionSecret = randomBytes(32)

function secretKey() {
    return createHash('sha256').update(Buffer.concat([Buffer.from('panel-session-v2|'), sessionSecret])).digest()
}

function signSession(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const mac = createHmac('sha256', secretKey()).update(body).digest('base64url')
    return `${body}.${mac}`
}

function verifySession(cookieValue) {
    if (!cookieValue || typeof cookieValue !== 'string') return null
    const [body, mac] = cookieValue.split('.')
    if (!body || !mac) return null
    const expected = createHmac('sha256', secretKey()).update(body).digest('base64url')
    if (!sameSecret(mac, expected)) return null
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
        if (!payload?.exp || payload.exp < Date.now()) return null
        return payload
    } catch {
        return null
    }
}

function parseCookies(header = '') {
    const out = {}
    for (const part of String(header).split(';')) {
        const index = part.indexOf('=')
        if (index === -1) continue
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
    }
    return out
}

function isAuthenticated(req) {
    if (AUTH_DISABLED) return true
    const cookies = parseCookies(req.headers.cookie)
    return Boolean(verifySession(cookies[SESSION_COOKIE]))
}

function setSessionCookie(res, token) {
    const value = signSession({ iat: Date.now(), exp: Date.now() + SESSION_TTL_MS })
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
            SESSION_TTL_MS / 1000
        )}`
    )
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
}

// 登录失败节流：同一来源 5 次失败后锁定 30 秒
const loginAttempts = new Map()

function attemptState(ip) {
    const entry = loginAttempts.get(ip)
    if (!entry) return { blocked: false, count: 0 }
    if (entry.until && entry.until > Date.now()) return { blocked: true, retryIn: Math.ceil((entry.until - Date.now()) / 1000) }
    if (entry.until && entry.until <= Date.now()) loginAttempts.delete(ip)
    return { blocked: false, count: entry.count || 0 }
}

function recordFailure(ip) {
    const entry = loginAttempts.get(ip) || { count: 0, until: 0 }
    entry.count += 1
    if (entry.count >= 5) {
        entry.until = Date.now() + 30_000
        entry.count = 0
    }
    loginAttempts.set(ip, entry)
}

/* ────────────────────────── 上游仓库校验 ────────────────────────── */

const BOT_MARKERS = ['scripts/main/manualLogin.js', 'scripts/utils.js', 'package.json']

/**
 * 严格判定一个目录是否是上游 Microsoft-Rewards-Script 仓库。
 * 返回 { ok, dir, missing, pkg }
 */
function inspectBotRepo(dir) {
    const result = { ok: false, dir: dir ? path.resolve(dir) : '', missing: [], pkg: null }
    if (!result.dir) {
        result.missing.push('未填写路径')
        return result
    }
    let stat = null
    try {
        stat = fs.statSync(result.dir)
    } catch {
        result.missing.push('目录不存在')
        return result
    }
    if (!stat.isDirectory()) {
        result.missing.push('不是目录')
        return result
    }

    for (const marker of BOT_MARKERS) {
        if (!fs.existsSync(path.join(result.dir, marker))) result.missing.push(marker)
    }

    const pkgPath = path.join(result.dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
        const pkg = readJsonSafe(pkgPath)
        if (!pkg) result.missing.push('package.json 不是合法 JSON')
        else {
            result.pkg = pkg
            if (!/microsoft-rewards/i.test(String(pkg.name || ''))) {
                result.missing.push('package.json 的 name 不是 microsoft-rewards-script')
            }
        }
    }

    result.ok = result.missing.length === 0
    return result
}

function assertBotRepo(rawDir) {
    const inspection = inspectBotRepo(rawDir)
    if (!inspection.ok) {
        const error = new Error(`不是有效的 Microsoft-Rewards-Script 仓库：缺少 ${inspection.missing.join('、')}`)
        error.status = 422
        error.missing = inspection.missing
        error.hint = '请填写上游脚本仓库的根目录（包含 package.json、scripts/main/manualLogin.js）'
        throw error
    }
    return inspection
}

/** 只做探测，不抛错：用于自动发现 */
function detectBotDir() {
    const candidates = []
    const push = dir => {
        const resolved = path.resolve(dir)
        if (!candidates.includes(resolved)) candidates.push(resolved)
    }
    if (state.botDir) push(state.botDir)
    if (process.env.BOT_DIR) push(process.env.BOT_DIR)

    // 面板放在仓库内：向上最多 4 层
    let dir = __dirname
    for (let i = 0; i < 4; i++) {
        push(dir)
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    // 面板的 bot 子目录
    push(path.join(__dirname, 'bot'))

    const hits = candidates.map(candidate => ({ dir: candidate, inspection: inspectBotRepo(candidate) }))
    return {
        found: hits.find(hit => hit.inspection.ok) || null,
        candidates: hits.slice(0, 6).map(hit => ({
            dir: hit.dir,
            ok: hit.inspection.ok,
            missing: hit.inspection.missing.slice(0, 3)
        }))
    }
}

/* ────────────────────────── 上游 config.json / sessionPath ────────────────────────── */

function loadBotConfig(botDir) {
    const candidates = [
        path.join(botDir, 'config.json'),
        path.join(botDir, 'dist', 'config.json'),
        path.join(botDir, 'src', 'config.json')
    ]
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue
        const data = readJsonSafe(file)
        if (data && typeof data === 'object') return { data, path: file }
        return { data: null, path: file, invalid: true }
    }
    return { data: null, path: null }
}

/** 与上游 getSessionDbPath 一致：cwd(=仓库根) 与 dist/src 变体 */
function resolveSessionDb(botDir) {
    const { data, path: configPath } = loadBotConfig(botDir)
    const sessionPath = typeof data?.sessionPath === 'string' && data.sessionPath.trim() ? data.sessionPath.trim() : 'sessions'
    const candidates = [
        path.resolve(botDir, sessionPath, 'sessions.db'),
        path.join(botDir, 'dist', sessionPath, 'sessions.db'),
        path.join(botDir, 'src', sessionPath, 'sessions.db')
    ]
    const found = candidates.find(file => fs.existsSync(file)) || null
    return { configured: sessionPath, path: found, expected: candidates[0], configPath, configInvalid: Boolean(data === null && configPath) }
}

/* ────────────────────────── 会话读取（只读） ────────────────────────── */

function inspectStorage(raw) {
    if (raw == null || raw === '') return { ok: false, cookies: 0, reason: '会话内容为空' }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { ok: false, cookies: 0, reason: '会话内容无法解析' }
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
        return { ok: false, cookies: 0, reason: '会话结构不完整' }
    }
    const usable = parsed.cookies.filter(cookie => cookie && typeof cookie.name === 'string' && cookie.name && typeof cookie.value === 'string' && cookie.value)
    if (!usable.length) return { ok: false, cookies: 0, reason: '没有可用 Cookie' }
    return { ok: true, cookies: usable.length, reason: null }
}

function readSessionRows(botDir) {
    const db = resolveSessionDb(botDir)
    if (!db.path) {
        return { ...db, exists: false, rows: [], error: db.configInvalid ? 'config.json 无法解析' : null }
    }
    let handle
    try {
        handle = new DatabaseSync(db.path, { readOnly: true })
        handle.exec('PRAGMA busy_timeout = 2000')
        const rows = handle
            .prepare('SELECT email, platform, storage_state, updated_at FROM sessions')
            .all()
            .map(row => {
                const storage = inspectStorage(row.storage_state)
                return {
                    email: row.email,
                    platform: row.platform,
                    updatedAt: Number(row.updated_at) || null,
                    cookies: storage.cookies,
                    usable: storage.ok,
                    reason: storage.reason
                }
            })
        return { ...db, exists: true, rows, error: null }
    } catch (error) {
        return { ...db, exists: true, rows: [], error: String(error.message || error) }
    } finally {
        try {
            handle?.close()
        } catch {}
    }
}

function sessionMap(botDir, email) {
    const result = readSessionRows(botDir)
    const map = {}
    for (const row of result.rows) {
        if (row.email.toLowerCase() !== String(email).toLowerCase()) continue
        map[row.platform] = { updatedAt: row.updatedAt, cookies: row.cookies, usable: row.usable, reason: row.reason }
    }
    return { map, db: result }
}

/* ────────────────────────── .env 读写 ────────────────────────── */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function assertSafeValue(field, value) {
    if (CONTROL_CHARS.test(value)) {
        const error = new Error(`${field} 不能包含换行符或其他控制字符`)
        error.status = 422
        throw error
    }
}

/**
 * 按上游 loadEnvFile 的解析规则序列化：去掉首尾空白、剥掉成对引号。
 * 因此只在“首尾空白”或“首尾是引号”时才加引号，且选一个值里不存在的引号。
 */
function encodeEnvValue(field, rawValue) {
    const value = String(rawValue ?? '')
    assertSafeValue(field, value)
    if (value === '') return ''

    const needsQuote = /^\s/.test(value) || /\s$/.test(value) || /^["']/.test(value) || /["']$/.test(value)
    if (!needsQuote) return value

    const hasDouble = value.includes('"')
    const hasSingle = value.includes("'")
    if (!hasDouble) return `"${value}"`
    if (!hasSingle) return `'${value}'`

    const error = new Error(`${field} 同时包含单引号与双引号，无法安全写入 .env，请改用其他凭据或手动编辑`)
    error.status = 422
    throw error
}

function parseEnvLine(line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const eq = trimmed.indexOf('=')
    if (eq === -1) return null
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
    }
    return { key, value }
}

function readEnvModel(envPath) {
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.length ? text.split(/\r?\n/) : []
    if (lines.length && lines.at(-1) === '') lines.pop()

    const accounts = new Map()
    for (const line of lines) {
        const parsed = parseEnvLine(line)
        if (!parsed) continue
        const match = /^ACCOUNT_(\d+)_([A-Z0-9_]+)$/.exec(parsed.key)
        if (!match) continue
        const index = Number(match[1])
        if (!accounts.has(index)) accounts.set(index, { index, values: {} })
        accounts.get(index).values[match[2]] = parsed.value
    }
    return { text, lines, eol, accounts }
}

function rawEnvValue(model, index, key) {
    for (const line of model.lines) {
        const parsed = parseEnvLine(line)
        if (parsed?.key === `ACCOUNT_${index}_${key}`) return parsed.value
    }
    return ''
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const GEO_RE = /^(auto|[A-Za-z]{2})$/i
const TOTP_RE = /^[A-Z2-7]{16,64}$/
const PROXY_RE = /^(https?|socks[45]?):\/\/(?!.*@)[^\s/]+$/i
const BOOL = new Set(['true', 'false'])

function normalizeAccountInput(input) {
    const errors = []
    const out = {}

    const email = String(input.email ?? '').trim()
    if (!email) errors.push('邮箱不能为空')
    else if (!EMAIL_RE.test(email)) errors.push('邮箱格式不正确')
    else if (CONTROL_CHARS.test(email)) errors.push('邮箱包含非法字符')
    out.email = email

    const password = String(input.password ?? '')
    if (password) {
        if (CONTROL_CHARS.test(password)) errors.push('密码不能包含换行符或其他控制字符')
        else out.password = password
    }

    const totp = String(input.totpSecret ?? '').replace(/[\s-]+/g, '').toUpperCase()
    if (totp) {
        if (!TOTP_RE.test(totp)) errors.push('TOTP 密钥应只含 A-Z 与 2-7，长度 16 位以上')
        else out.totpSecret = totp
    }

    const recovery = String(input.recoveryEmail ?? '').trim()
    if (recovery) {
        if (!EMAIL_RE.test(recovery)) errors.push('备用邮箱格式不正确')
        else if (CONTROL_CHARS.test(recovery)) errors.push('备用邮箱包含非法字符')
        else out.recoveryEmail = recovery
    }

    const geo = String(input.geoLocale ?? 'auto').trim() || 'auto'
    if (!GEO_RE.test(geo)) errors.push('国家/地区应为 auto 或两位国家代码（如 US、CN）')
    else out.geoLocale = geo.toLowerCase() === 'auto' ? 'auto' : geo.toUpperCase()

    const lang = String(input.langCode ?? '').trim()
    if (lang) {
        if (!LANG_RE.test(lang)) errors.push('语言代码格式不正确（如 zh-CN、en）')
        else out.langCode = lang
    }

    const proxyUrl = String(input.proxyUrl ?? '').trim()
    const proxyPort = String(input.proxyPort ?? '').trim()
    const proxyUser = String(input.proxyUsername ?? '').trim()
    const proxyPass = String(input.proxyPassword ?? '')

    if (proxyUrl) {
        if (!PROXY_RE.test(proxyUrl)) {
            errors.push('代理地址需形如 http://127.0.0.1（凭据请填在用户名/密码栏）')
        } else if (CONTROL_CHARS.test(proxyUrl) || CONTROL_CHARS.test(proxyUser) || CONTROL_CHARS.test(proxyPass)) {
            errors.push('代理字段不能包含换行符或其他控制字符')
        } else {
            const port = Number(proxyPort)
            if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('代理端口需为 1-65535 的整数')
            else if (Boolean(proxyUser) !== Boolean(proxyPass)) errors.push('代理用户名与密码必须同时填写')
            else if (/^socks/i.test(proxyUrl) && proxyUser) errors.push('SOCKS 代理不支持用户名密码认证')
            else out.proxy = { url: proxyUrl, port, username: proxyUser, password: proxyPass }
        }
    } else if (proxyPort || proxyUser || proxyPass) {
        errors.push('填写了代理端口或凭据时，代理地址不能为空')
    }

    out.saveFingerprint = {
        mobile: parseBool(input.saveFingerprintMobile),
        desktop: parseBool(input.saveFingerprintDesktop)
    }

    out.removeProxy = input.removeProxy === true

    return { errors, value: out }
}

function parseBool(value) {
    if (value === undefined || value === null || value === '') return undefined
    const text = String(value).trim().toLowerCase()
    if (!BOOL.has(text)) throw Object.assign(new Error('布尔字段只能是 true 或 false'), { status: 422 })
    return text === 'true'
}

function buildAccountBlock(index, value) {
    const set = (key, raw) => `ACCOUNT_${index}_${key}=${encodeEnvValue(`ACCOUNT_${index}_${key}`, raw)}`
    const lines = [`# ── ACCOUNT_${index} · ${value.email} ──`, set('EMAIL', value.email)]
    if (value.password) lines.push(set('PASSWORD', value.password))
    lines.push(set('TOTP_SECRET', value.totpSecret ?? ''))
    lines.push(set('RECOVERY_EMAIL', value.recoveryEmail ?? ''))
    lines.push(set('GEO_LOCALE', value.geoLocale ?? 'auto'))
    lines.push(set('LANG_CODE', value.langCode ?? 'zh-CN'))
    if (value.proxy) {
        lines.push(set('PROXY_HTTP', /^https?:/i.test(value.proxy.url) ? 'true' : 'false'))
        lines.push(set('PROXY_URL', value.proxy.url))
        lines.push(set('PROXY_PORT', String(value.proxy.port)))
        lines.push(set('PROXY_USERNAME', value.proxy.username))
        lines.push(set('PROXY_PASSWORD', value.proxy.password))
    }
    if (value.saveFingerprint?.mobile !== undefined) lines.push(set('SAVE_FINGERPRINT_MOBILE', String(value.saveFingerprint.mobile)))
    if (value.saveFingerprint?.desktop !== undefined) lines.push(set('SAVE_FINGERPRINT_DESKTOP', String(value.saveFingerprint.desktop)))
    return lines.map(line => {
        // 逐行再校验一次，避免任何字段把换行带进文件
        if (CONTROL_CHARS.test(line)) throw Object.assign(new Error('账号字段包含非法换行'), { status: 422 })
        return line
    })
}

function writeEnv(envPath, text) {
    if (fs.existsSync(envPath)) {
        const backup = `${envPath}.panel.bak`
        try {
            fs.copyFileSync(envPath, backup)
            try {
                fs.chmodSync(backup, 0o600)
            } catch {}
        } catch {}
    }
    writePrivateFile(envPath, text)
}

function upsertAccount(envPath, index, value) {
    const model = readEnvModel(envPath)
    const block = buildAccountBlock(index, value)
    const headerRe = new RegExp(`^# ── ACCOUNT_${index} · .* ──$`)
    const anyHeader = /^# ── ACCOUNT_\d+ · .* ──$/

    const keyIndex = line => {
        const parsed = parseEnvLine(line)
        const match = parsed && /^ACCOUNT_(\d+)_/.exec(parsed.key)
        return match ? Number(match[1]) : null
    }

    let anchor = null
    for (let i = 0; i < model.lines.length; i++) {
        const n = keyIndex(model.lines[i])
        if (n === null) continue
        if (n === index || n > index) {
            anchor = i
            break
        }
    }
    if (anchor !== null && keyIndex(model.lines[anchor]) !== index) {
        while (anchor > 0 && (anyHeader.test(model.lines[anchor - 1].trim()) || model.lines[anchor - 1].trim() === '')) {
            anchor--
        }
    }

    const kept = []
    for (let i = 0; i < model.lines.length; i++) {
        const line = model.lines[i]
        if (keyIndex(line) === index || headerRe.test(line.trim())) continue
        kept.push({ line, from: i })
    }

    let insertAt = kept.length
    if (anchor !== null) {
        const found = kept.findIndex(entry => entry.from >= anchor)
        insertAt = found === -1 ? kept.length : found
    }

    const before = kept.slice(0, insertAt).map(entry => entry.line)
    const after = kept.slice(insertAt).map(entry => entry.line)
    while (before.length && before.at(-1).trim() === '') before.pop()
    while (after.length && after[0].trim() === '') after.shift()

    const out = [...before]
    if (out.length) out.push('')
    out.push(...block)
    if (after.length) out.push('')
    out.push(...after)

    const tidy = []
    for (const line of out) {
        if (line.trim() === '' && tidy.at(-1)?.trim() === '') continue
        tidy.push(line)
    }

    writeEnv(envPath, tidy.join(model.eol) + model.eol)
    return { created: !model.accounts.has(index) }
}

function deleteAccount(envPath, index) {
    const model = readEnvModel(envPath)
    if (!model.accounts.has(index)) return false
    const prefix = `ACCOUNT_${index}_`
    const headerRe = new RegExp(`^# ── ACCOUNT_${index} · .* ──$`)
    const kept = model.lines.filter(line => {
        const parsed = parseEnvLine(line)
        if (parsed?.key.startsWith(prefix)) return false
        if (headerRe.test(line.trim())) return false
        return true
    })
    const compact = []
    for (const line of kept) {
        if (line.trim() === '' && compact.at(-1)?.trim() === '') continue
        compact.push(line)
    }
    writeEnv(envPath, compact.join(model.eol) + model.eol)
    return true
}

/* ────────────────────────── 环境自检 ────────────────────────── */

function fileExists(file) {
    try {
        return fs.statSync(file).isFile()
    } catch {
        return false
    }
}

function browserRoots() {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    return [
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
        home ? path.join(home, '.cache', 'ms-playwright') : null,
        home ? path.join(home, 'Library', 'Caches', 'ms-playwright') : null
    ].filter(Boolean)
}

/** 可见授权需要真正的 Chromium 可执行文件，空目录和 headless shell 都不算 */
function findChromiumExecutable() {
    const names = process.platform === 'win32' ? ['chrome.exe'] : ['chrome', 'chromium']
    const roots = browserRoots()

    for (const root of roots) {
        if (!fs.existsSync(root)) continue
        let entries = []
        try {
            entries = fs.readdirSync(root, { withFileTypes: true })
        } catch {
            continue
        }
        const dirs = entries
            .filter(entry => entry.isDirectory() && /^chromium-\d+/i.test(entry.name) && !/headless/i.test(entry.name))
            .map(entry => entry.name)
            .sort()
            .reverse()

        for (const dir of dirs) {
            const base = path.join(root, dir)
            const candidates = [
                path.join(base, 'chrome-win64', 'chrome.exe'),
                path.join(base, 'chrome-win', 'chrome.exe'),
                path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                path.join(base, 'chrome-linux', 'chrome')
            ]
            for (const file of candidates) {
                if (fileExists(file)) return file
            }
            const found = walkForExecutable(base, names, 4)
            if (found) return found
        }
    }
    return null
}

function walkForExecutable(dir, names, depth) {
    if (depth < 0) return null
    let entries = []
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return null
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && names.includes(entry.name.toLowerCase()) && !/headless/i.test(full)) return full
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || /headless/i.test(entry.name)) continue
        const found = walkForExecutable(path.join(dir, entry.name), names, depth - 1)
        if (found) return found
    }
    return null
}

function preflight(botDir) {
    const checks = []
    const inspection = inspectBotRepo(botDir)
    checks.push({
        id: 'repo',
        label: '上游脚本仓库',
        ok: inspection.ok,
        detail: inspection.ok ? inspection.dir : `缺少 ${inspection.missing.join('、')}`,
        fatal: true
    })

    const nodeMajor = Number(process.versions.node.split('.')[0])
    checks.push({
        id: 'node',
        label: 'Node.js',
        ok: nodeMajor >= 24,
        detail: `v${process.versions.node}${nodeMajor >= 24 ? '' : '（上游要求 >= 24）'}`,
        fatal: nodeMajor < 24
    })

    if (inspection.ok) {
        const nodeModules = path.join(inspection.dir, 'node_modules')
        const deps = ['patchright', 'fingerprint-generator', 'fingerprint-injector', 'otpauth', 'ghost-cursor-playwright-port']
        const missing = deps.filter(dep => !fs.existsSync(path.join(nodeModules, dep)))
        checks.push({
            id: 'deps',
            label: '脚本依赖',
            ok: missing.length === 0,
            detail: missing.length ? `缺少 ${missing.join('、')}（执行 npm install）` : '已安装',
            fatal: missing.length > 0
        })
    } else {
        checks.push({ id: 'deps', label: '脚本依赖', ok: false, detail: '仓库无效，跳过', fatal: true, skipped: true })
    }

    const chromium = findChromiumExecutable()
    checks.push({
        id: 'chromium',
        label: '可见浏览器',
        ok: Boolean(chromium),
        detail: chromium || '未找到可用的 Chromium 可执行文件。空目录和 headless shell 不算，请执行 npx patchright install chromium',
        fatal: !chromium,
        scope: 'authorize'
    })

    if (inspection.ok) {
        const botConfig = loadBotConfig(inspection.dir)
        const sessionPath = typeof botConfig.data?.sessionPath === 'string' ? botConfig.data.sessionPath.trim() : ''
        const configOk = Boolean(botConfig.data) && sessionPath.length > 0
        checks.push({
            id: 'config',
            label: '授权配置',
            ok: configOk,
            detail: configOk
                ? `${botConfig.path} · sessionPath=${sessionPath}`
                : botConfig.path
                  ? `${botConfig.path} 缺少 sessionPath，手动授权会直接退出。请从 config.example.json 复制一份并填写 sessionPath`
                  : '缺少 config.json。请从 config.example.json 复制，并填写 sessionPath（通常为 sessions）',
            fatal: !configOk,
            scope: 'authorize'
        })

        const hasDist = fileExists(path.join(inspection.dir, 'dist', 'index.js'))
        checks.push({
            id: 'build',
            label: '签到构建产物',
            ok: hasDist,
            detail: hasDist ? 'dist/index.js 已存在，可运行签到' : '缺少 dist/index.js。不影响浏览器授权；要签到请先 npm run build',
            fatal: false,
            warn: !hasDist,
            scope: 'run'
        })

        const db = resolveSessionDb(inspection.dir)
        checks.push({
            id: 'sessions',
            label: '会话数据库',
            ok: Boolean(db.path),
            detail: db.path || `尚未生成（预期 ${db.expected}）`,
            fatal: false,
            warn: true
        })
    }

    const authorizeBlocking = checks.filter(check => check.scope !== 'run' && check.fatal && !check.ok)
    const runBlocking = checks.filter(check => !check.ok && (check.scope === 'run' || (check.fatal && check.scope !== 'authorize')))
    return {
        checks,
        ready: authorizeBlocking.length === 0,
        authorizeReady: authorizeBlocking.length === 0,
        runReady: authorizeBlocking.length === 0 && !checks.some(check => check.id === 'build' && !check.ok),
        blocking: authorizeBlocking.map(check => check.label),
        runBlocking: runBlocking.filter(check => !check.ok).map(check => check.label),
        botDir: inspection.ok ? inspection.dir : ''
    }
}

/* ────────────────────────── 账号汇总 ────────────────────────── */

const mask = value => (!value ? '' : value.length <= 4 ? '••••' : `${value.slice(0, 2)}••••${value.slice(-2)}`)

function buildAccountsPayload(botDir) {
    const inspection = inspectBotRepo(botDir)
    if (!inspection.ok) return { ok: false, reason: inspection.missing, accounts: [] }

    const envPath = path.join(inspection.dir, '.env')
    const model = readEnvModel(envPath)
    const sessions = readSessionRows(inspection.dir)
    const byEmail = new Map()
    for (const row of sessions.rows) {
        const key = row.email.toLowerCase()
        if (!byEmail.has(key)) byEmail.set(key, {})
        byEmail.get(key)[row.platform] = row
    }

    const accounts = [...model.accounts.values()]
        .sort((a, b) => a.index - b.index)
        .map(account => {
            const email = account.values.EMAIL ?? ''
            const record = byEmail.get(email.toLowerCase()) ?? {}
            const proxyUrl = account.values.PROXY_URL ?? ''
            const proxyPort = account.values.PROXY_PORT ?? ''
            return {
                index: account.index,
                email,
                hasPassword: Boolean(account.values.PASSWORD),
                hasTotp: Boolean(account.values.TOTP_SECRET),
                hasRecovery: Boolean(account.values.RECOVERY_EMAIL),
                geoLocale: account.values.GEO_LOCALE || 'auto',
                langCode: account.values.LANG_CODE || 'en',
                hasProxy: Boolean(proxyUrl),
                proxyLabel: proxyUrl ? `${proxyUrl}:${proxyPort}${account.values.PROXY_USERNAME ? ' · 带凭据' : ''}` : '',
                saveFingerprint: {
                    mobile: (account.values.SAVE_FINGERPRINT_MOBILE ?? 'false') === 'true',
                    desktop: (account.values.SAVE_FINGERPRINT_DESKTOP ?? 'false') === 'true'
                },
                passwordMasked: mask(account.values.PASSWORD),
                totpMasked: mask(account.values.TOTP_SECRET),
                sessions: {
                    mobile: record.mobile ? { updatedAt: record.mobile.updatedAt, cookies: record.mobile.cookies } : null,
                    desktop: record.desktop ? { updatedAt: record.desktop.updatedAt, cookies: record.desktop.cookies } : null
                }
            }
        })

    return {
        ok: true,
        botDir: inspection.dir,
        envExists: fs.existsSync(envPath),
        envPath,
        accounts,
        nextIndex: accounts.length ? Math.max(...accounts.map(a => a.index)) + 1 : 1,
        sessions: {
            exists: sessions.exists,
            path: sessions.path,
            expected: sessions.expected,
            configured: sessions.configured,
            count: sessions.rows.length,
            error: sessions.error
        }
    }
}

/* ────────────────────────── 手动登录任务 ────────────────────────── */

const jobs = new Map()
const desktopProxy = createDesktopProxy({
    authenticated: isAuthenticated,
    active: () => REMOTE_DESKTOP && [...jobs.values()].some(job => job.state === 'running' && job.desktopReady)
})
let browserStartPending = false

async function guardedBrowserStart(action) {
    if (!REMOTE_DESKTOP) return action()
    if (browserStartPending || [...jobs.values()].some(job => job.state === 'running')) {
        throw Object.assign(new Error('已有授权或签到任务，请等待完成后再启动。'), { status: 409 })
    }
    browserStartPending = true
    try {
        const control = await probeControlApi()
        if (control.status !== 'online') throw Object.assign(new Error('容器内签到服务尚未就绪，请稍后重试。'), { status: 503 })
        if (control.remoteState !== 'idle') throw Object.assign(new Error('签到任务正在运行，请先停止或等待结束再授权。'), { status: 409 })
        return await action()
    } finally { browserStartPending = false }
}

function jobView(job) {
    if (!job) return null
    return {
        email: job.email,
        platform: job.platform,
        fresh: job.fresh,
        state: job.state,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        hint: job.hint || null,
        desktopUrl: REMOTE_DESKTOP && job.state === 'running' && job.desktopReady
            ? '/desktop/vnc.html?autoconnect=1&resize=scale&path=desktop/websockify' : null,
        verification: job.verification || null,
        log: job.log.slice(-MAX_JOB_LOG)
    }
}

function classifyLog(line, previous) {
    const tagged = /\[(INFO|WARN|ERROR|SUCCESS|DEBUG)\]/i.exec(line)
    if (tagged) {
        const level = tagged[1].toUpperCase()
        if (level === 'SUCCESS') return 'success'
        if (level === 'DEBUG') return 'info'
        return level.toLowerCase()
    }
    if (/^\s+at\s|^\s*\{|^\s*\}|code: '/.test(line) && previous) return previous.level
    if (/\bERROR\b|Error:|错误|失败/.test(line)) return 'error'
    if (/\bWARN\b|警告/.test(line)) return 'warn'
    if (/SUCCESS|Saved .* session/i.test(line)) return 'success'
    return 'info'
}

function diagnoseFailure(text, verification) {
    if (verification && verification.checked && !verification.saved.length) {
        return '进程已结束，但所选账号/平台的会话没有被写入。常见原因：浏览器未完成微软登录、登录中途关闭窗口，或登录的账号与填写的不一致。'
    }
    if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i.test(text)) {
        return '依赖未安装：请在实例目录执行 npm install 与 npx patchright install chromium。'
    }
    if (/Executable doesn't exist|patchright install/i.test(text)) {
        return 'Chromium 内核缺失：请在实例目录执行 npx patchright install chromium。'
    }
    if (/No ACCOUNT_N_\* block found/i.test(text)) {
        return '.env 里没有该账号：请先保存账号。'
    }
    return null
}

function verifySessions(botDir, job) {
    const platforms = job.platform === 'both' ? ['mobile', 'desktop'] : [job.platform]
    const { map, db } = sessionMap(botDir, job.email)
    const saved = []
    const missing = []
    const details = platforms.map(platform => {
        const row = map[platform]
        const before = job.baseline?.[platform] ?? null
        const newer = Boolean(row?.updatedAt) && (before === null ? row.updatedAt >= job.startedAt - 1000 : row.updatedAt > before)
        // 时间更新还不够：内容必须能解析，并且至少有一个可用 Cookie
        const fresh = newer && row.usable === true
        if (fresh) saved.push(platform)
        else missing.push(platform)
        return {
            platform,
            fresh,
            updatedAt: row?.updatedAt ?? null,
            previous: before,
            cookies: row?.cookies ?? null,
            reason: !newer ? null : row?.usable ? null : row?.reason || '会话不可用'
        }
    })
    return { checked: true, saved, missing, details, dbPath: db.path, expected: db.expected, error: db.error }
}

function startManualLogin({ botDir, email, platform, fresh }) {
    const key = email.toLowerCase()
    const running = jobs.get(key)
    if (running && running.state === 'running') {
        return { ok: false, status: 409, error: '该账号已有正在运行的登录任务' }
    }

    const script = path.join(botDir, 'scripts', 'main', 'manualLogin.js')
    if (!fileExists(script)) {
        return { ok: false, status: 422, error: `未找到 ${script}` }
    }

    const envModel = readEnvModel(path.join(botDir, '.env'))
    const knownEmail = [...envModel.accounts.values()].some(
        account => (account.values.EMAIL || '').toLowerCase() === key
    )
    if (!knownEmail) {
        return { ok: false, status: 400, error: `.env 中没有 ${email} 对应的 ACCOUNT_N_* 配置，请先保存账号` }
    }

    const job = {
        email,
        platform,
        fresh: Boolean(fresh),
        state: 'running',
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        hint: null,
        verification: null,
        // 记录任务开始前的会话时间戳，用于判断“本次是否真的重新授权”
        baseline: (() => {
            const { map } = sessionMap(botDir, email)
            return { mobile: map.mobile?.updatedAt ?? null, desktop: map.desktop?.updatedAt ?? null }
        })(),
        log: [],
        child: null,
        cancelled: false
    }
    jobs.set(key, job)

    const args = REMOTE_DESKTOP
        ? ['--nonblock', '--no-fork', '--conflict-exit-code', '75', '/tmp/rewards-browser.lock', process.execPath,
            path.join(__dirname, 'docker', 'worker.mjs'), 'login', '--email', email, '--platform', platform]
        : [script, '--email', email, '--platform', platform]
    if (fresh) args.push('--fresh')

    log('启动手动登录 →', email, platform, fresh ? '(fresh)' : '')

    let child
    try {
        child = spawn(REMOTE_DESKTOP ? '/usr/bin/flock' : process.execPath, args, {
            cwd: botDir,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        })
    } catch (error) {
        job.state = 'failed'
        job.endedAt = Date.now()
        job.log.push({ t: Date.now(), level: 'error', text: `无法启动进程：${error.message}` })
        return { ok: false, status: 500, error: '无法启动登录进程' }
    }

    job.child = child

    const push = chunk => {
        if (REMOTE_DESKTOP) {
            job.outputTail = ((job.outputTail || '') + chunk.toString('utf8')).slice(-2048)
            if (job.outputTail.includes('__PANEL_DESKTOP_READY__')) job.desktopReady = true
        }
        for (const rawLine of chunk.toString('utf8').split(/\r?\n/)) {
            const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trimEnd()
            if (!line) continue
            job.log.push({ t: Date.now(), level: classifyLog(line, job.log.at(-1)), text: line })
        }
        if (job.log.length > MAX_JOB_LOG) job.log.splice(0, job.log.length - MAX_JOB_LOG)
        broadcast(key, jobView(job))
    }

    child.stdout.on('data', push)
    child.stderr.on('data', push)

    child.on('error', error => {
        job.log.push({ t: Date.now(), level: 'error', text: `进程错误：${error.message}` })
        job.state = 'failed'
        job.endedAt = Date.now()
        broadcast(key, jobView(job))
    })

    child.on('exit', (code, signal) => {
        if (REMOTE_DESKTOP) desktopProxy.close()
        job.exitCode = code
        job.endedAt = Date.now()
        job.child = null

        // 关键：成功与否只看 sessions.db 是否真的写入了对应平台，
        // 并且进程本身必须是正常退出（非零退出码 / 被信号杀掉都不算成功）
        job.verification = verifySessions(botDir, job)
        const joined = job.log.map(line => line.text).join('\n')
        const { saved, missing } = job.verification
        const exitedCleanly = code === 0 && !signal

        if (job.cancelled || signal) {
            job.state = 'cancelled'
            job.hint = '任务被终止，未写入新的会话。'
        } else if (!exitedCleanly) {
            job.state = 'failed'
            job.hint = code === 75 ? '已有授权或签到任务占用浏览器，请等待完成后重试。'
                : code === 124 ? '授权超时，远程浏览器已关闭。请重新启动授权。'
                : `进程异常退出（退出码 ${code ?? '—'}），本次授权无效。`
        } else if (!saved.length) {
            job.state = 'failed'
            job.hint = diagnoseFailure(joined, job.verification)
        } else if (missing.length) {
            job.state = 'partial'
            job.hint = `只保存了 ${saved.join('、')} 会话，${missing.join('、')} 未写入：需要再单独授权一次该平台。`
        } else {
            job.state = 'done'
            job.hint = null
        }

        log('登录任务结束 →', email, 'code=', code, 'state=', job.state, 'saved=', saved.join(',') || '-')
        broadcast(key, jobView(job))
    })

    return { ok: true, job: jobView(job) }
}

/* ────────────────────────── SSE ────────────────────────── */

const sseClients = new Set()

function broadcast(emailKey, payload) {
    const frame = `event: job\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of sseClients) {
        if (client.emailKey && emailKey && client.emailKey !== emailKey) continue
        try {
            client.res.write(frame)
        } catch {}
    }
}

function handleSse(req, res, url) {
    const emailKey = (url.searchParams.get('email') || '').toLowerCase()
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')

    const client = { res, emailKey }
    sseClients.add(client)
    res.write(`event: job\ndata: ${JSON.stringify(jobView(emailKey ? jobs.get(emailKey) : null))}\n\n`)

    const keepAlive = setInterval(() => {
        try {
            res.write(': ping\n\n')
        } catch {}
    }, 15000)

    req.on('close', () => {
        clearInterval(keepAlive)
        sseClients.delete(client)
    })
}

/* ────────────────────────── Control API ────────────────────────── */

async function probeControlApi() {
    const base = (state.controlApi || 'http://127.0.0.1:3010').replace(/\/+$/, '')
    if (!state.controlApi && !state.controlToken) return { status: 'unconfigured', base }

    const headers = {}
    if (state.controlToken) headers.Authorization = `Bearer ${state.controlToken}`

    try {
        const response = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(1800) })
        let data = null
        try {
            data = await response.json()
        } catch {}
        if (response.status === 401 || response.status === 403) {
            return { status: 'unauthorized', base, http: response.status, detail: 'Control API 令牌无效或未配置' }
        }
        if (!response.ok) {
            return { status: 'error', base, http: response.status, detail: `Control API 返回 ${response.status}` }
        }
        return { status: 'online', base, http: response.status, detail: `运行状态 ${data?.state ?? 'idle'}`, remoteState: data?.state ?? null }
    } catch (error) {
        return { status: 'offline', base, detail: String(error.message || error) }
    }
}

async function callControlApi(method, endpoint, body) {
    const probe = await probeControlApi()
    if (probe.status !== 'online') {
        const message =
            probe.status === 'unconfigured'
                ? '未配置 Control API，无法执行签到任务'
                : probe.status === 'unauthorized'
                  ? 'Control API 令牌无效'
                  : probe.status === 'offline'
                    ? 'Control API 无法连接'
                    : 'Control API 异常'
        return { ok: false, http: probe.http || 0, error: message, probe }
    }
    const headers = { 'Content-Type': 'application/json' }
    if (state.controlToken) headers.Authorization = `Bearer ${state.controlToken}`
    try {
        const response = await fetch(`${probe.base}${endpoint}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000)
        })
        let data = {}
        try {
            data = await response.json()
        } catch {}
        return { ok: response.ok, http: response.status, data, probe }
    } catch (error) {
        return { ok: false, http: 0, error: String(error.message || error), probe }
    }
}

/* ────────────────────────── 静态资源 ────────────────────────── */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2'
}

function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const filePath = path.join(PUBLIC_DIR, rel)
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' })

    fs.readFile(filePath, (error, data) => {
        if (error) {
            if (!path.extname(rel)) {
                return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                    if (err2) return json(res, 404, { error: 'Not found' })
                    res.writeHead(200, { 'Content-Type': MIME['.html'] })
                    res.end(html)
                })
            }
            return json(res, 404, { error: 'Not found' })
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        })
        res.end(data)
    })
}

/* ────────────────────────── 路由 ────────────────────────── */

const PUBLIC_ROUTES = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/logout', '/api/health'])

function currentBotDir() {
    if (state.botDir) {
        const inspection = inspectBotRepo(state.botDir)
        if (inspection.ok) return inspection.dir
    }
    const detected = detectBotDir()
    if (detected.found) return detected.found.dir
    return ''
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
    const { pathname } = url
    const ip = req.socket.remoteAddress || 'local'

    try {
        if (pathname === '/desktop' || pathname.startsWith('/desktop/')) {
            if (!REMOTE_DESKTOP) return json(res, 404, { error: '当前运行方式未启用远程浏览器' })
            return desktopProxy.handle(req, res, url)
        }
        /* ── 鉴权网关 ── */
        if (pathname.startsWith('/api/') && !PUBLIC_ROUTES.has(pathname)) {
            if (!isAuthenticated(req)) {
                return json(res, 401, {
                    error: '需要先验证面板访问密码',
                    code: 'UNAUTHORIZED',
                    authRequired: !AUTH_DISABLED
                })
            }
        }

        /* ── 认证 ── */
        if (pathname === '/api/auth/state' && req.method === 'GET') {
            const botDir = currentBotDir()
            return json(res, 200, {
                authRequired: !AUTH_DISABLED,
                authenticated: isAuthenticated(req),
                botDir,
                repoSynced: Boolean(state.botDir) && inspectBotRepo(state.botDir).ok,
                panelVersion: '2.0.0'
            })
        }

        if (pathname === '/api/auth/login' && req.method === 'POST') {
            if (AUTH_DISABLED) return json(res, 200, { ok: true, authRequired: false })

            const gate = attemptState(ip)
            if (gate.blocked) {
                return json(res, 429, { error: `失败次数过多，请 ${gate.retryIn} 秒后再试`, retryIn: gate.retryIn })
            }

            const body = await readBody(req)
            const token = String(body.token ?? '').trim()
            if (!token || !sameSecret(token, state.panelToken)) {
                recordFailure(ip)
                return json(res, 401, { error: '访问密码不正确' })
            }

            loginAttempts.delete(ip)
            setSessionCookie(res)
            return json(res, 200, { ok: true })
        }

        if (pathname === '/api/auth/logout' && req.method === 'POST') {
            // 必须带当前会话：无 Cookie 的请求不能作废别人的登录
            if (!isAuthenticated(req)) {
                return json(res, 401, { error: '未登录，无需退出', code: 'UNAUTHORIZED' })
            }
            sessionSecret = randomBytes(32)
            desktopProxy.close()
            for (const client of sseClients) {
                try {
                    client.res.end()
                } catch {}
            }
            sseClients.clear()
            clearSessionCookie(res)
            return json(res, 200, { ok: true })
        }

        /* ── 面板配置 ── */
        if (pathname === '/api/state' && req.method === 'GET') {
            const botDir = currentBotDir()
            const control = await probeControlApi()
            const detection = botDir ? null : detectBotDir()
            return json(res, 200, {
                authRequired: !AUTH_DISABLED,
                botDir,
                configured: Boolean(state.botDir),
                candidates: detection?.candidates ?? [],
                control,
                controlConfigured: Boolean(state.controlApi || state.controlToken),
                version: process.version,
                platform: process.platform
            })
        }

        if (pathname === '/api/preflight' && req.method === 'GET') {
            // 明确指定的路径优先；没指定才回退到当前已连接实例
            const requested = (url.searchParams.get('botDir') || '').trim()
            const dir = requested || currentBotDir()
            if (!dir) {
                return json(res, 200, { ready: false, authorizeReady: false, runReady: false, blocking: ['未连接实例'], checks: [], botDir: '' })
            }
            const result = preflight(dir)
            return json(res, 200, result)
        }

        if (pathname === '/api/detect' && req.method === 'GET') {
            const detection = detectBotDir()
            return json(res, 200, {
                botDir: detection.found?.dir || '',
                detected: Boolean(detection.found),
                candidates: detection.candidates
            })
        }

        if (pathname === '/api/config' && req.method === 'PUT') {
            const body = await readBody(req)

            if (typeof body.botDir === 'string' && body.botDir.trim()) {
                const inspection = assertBotRepo(body.botDir.trim()) // 严格校验，不合格直接 422
                state.botDir = inspection.dir
            }
            if (typeof body.controlApi === 'string') state.controlApi = body.controlApi.trim()
            if (typeof body.controlToken === 'string') state.controlToken = body.controlToken.trim()
            if (body.disconnect === true) {
                state.botDir = ''
                state.controlApi = ''
                state.controlToken = ''
            }
            saveConfig()

            const accounts = state.botDir ? buildAccountsPayload(state.botDir) : null
            const control = await probeControlApi()
            return json(res, 200, { ok: true, botDir: state.botDir, accounts, control })
        }

        if (pathname === '/api/auth/password' && req.method === 'POST') {
            const body = await readBody(req)
            const next = String(body.token ?? '').trim()
            if (next.length < MIN_PANEL_TOKEN) return json(res, 422, { error: `新密码至少 ${MIN_PANEL_TOKEN} 位` })
            state.panelToken = next
            saveConfig()
            setSessionCookie(res)
            return json(res, 200, { ok: true })
        }

        /* ── 账号 ── */
        if (pathname === '/api/accounts' && req.method === 'GET') {
            const dir = currentBotDir()
            if (!dir) {
                return json(res, 200, { ok: false, reason: ['未连接实例'], accounts: [], needsSetup: true })
            }
            return json(res, 200, buildAccountsPayload(dir))
        }

        if (pathname === '/api/accounts' && req.method === 'POST') {
            const body = await readBody(req)
            const dir = currentBotDir()
            if (!dir) throw Object.assign(new Error('尚未连接有效实例'), { status: 422, missing: ['未连接实例'] })

            const envPath = path.join(dir, '.env')
            const model = readEnvModel(envPath)
            const requested = Number(body.index)
            const index = Number.isInteger(requested) && requested > 0
                ? requested
                : model.accounts.size
                  ? Math.max(...model.accounts.keys()) + 1
                  : 1

            const { errors, value } = normalizeAccountInput(body)
            if (!value.email) errors.push('邮箱必填')
            if (errors.length) return json(res, 422, { error: errors[0], errors })

            const duplicate = [...model.accounts.values()].find(
                account => account.index !== index && (account.values.EMAIL || '').toLowerCase() === value.email.toLowerCase()
            )
            if (duplicate) return json(res, 409, { error: `该邮箱已存在于 ACCOUNT_${duplicate.index}` })

            if (model.accounts.has(index)) {
                // 编辑：未提交的字段保持原值，绝不擅自改写
                const keep = (field, key) => {
                    if (value[field]) return
                    const old = rawEnvValue(model, index, key)
                    if (old) value[field] = old
                }
                keep('password', 'PASSWORD')
                keep('totpSecret', 'TOTP_SECRET')
                keep('recoveryEmail', 'RECOVERY_EMAIL')

                if (!value.proxy && !value.removeProxy) {
                    const oldUrl = rawEnvValue(model, index, 'PROXY_URL')
                    const oldPort = Number(rawEnvValue(model, index, 'PROXY_PORT'))
                    if (oldUrl && Number.isInteger(oldPort) && oldPort > 0) {
                        value.proxy = {
                            url: oldUrl,
                            port: oldPort,
                            username: rawEnvValue(model, index, 'PROXY_USERNAME'),
                            password: rawEnvValue(model, index, 'PROXY_PASSWORD')
                        }
                    }
                }

                if (value.saveFingerprint.mobile === undefined) {
                    value.saveFingerprint.mobile = (rawEnvValue(model, index, 'SAVE_FINGERPRINT_MOBILE') || 'false') === 'true'
                }
                if (value.saveFingerprint.desktop === undefined) {
                    value.saveFingerprint.desktop = (rawEnvValue(model, index, 'SAVE_FINGERPRINT_DESKTOP') || 'false') === 'true'
                }
            } else {
                // 新增：给出默认值
                if (value.saveFingerprint.mobile === undefined) value.saveFingerprint.mobile = true
                if (value.saveFingerprint.desktop === undefined) value.saveFingerprint.desktop = true
            }

            const { created } = upsertAccount(envPath, index, value)
            log(created ? '新增账号' : '更新账号', `ACCOUNT_${index}`, value.email)
            return json(res, created ? 201 : 200, { ok: true, index, ...buildAccountsPayload(dir) })
        }

        if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
            const index = Number(pathname.split('/').pop())
            if (!Number.isInteger(index) || index < 1) throw Object.assign(new Error('账号序号不合法'), { status: 400 })
            const dir = currentBotDir()
            if (!dir) throw Object.assign(new Error('尚未连接有效实例'), { status: 422 })

            const envPath = path.join(dir, '.env')
            const model = readEnvModel(envPath)
            const email = model.accounts.get(index)?.values.EMAIL
            if (!email) throw Object.assign(new Error('账号不存在'), { status: 404 })

            const running = jobs.get(email.toLowerCase())
            if (running?.state === 'running' && running.child) {
                running.cancelled = true
                running.child.kill()
            }

            deleteAccount(envPath, index)
            log('删除账号', `ACCOUNT_${index}`, email)
            return json(res, 200, { ok: true, ...buildAccountsPayload(dir) })
        }

        /* ── 登录任务 ── */
        if (pathname === '/api/jobs' && req.method === 'GET') {
            const list = [...jobs.values()]
                .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
                .slice(0, 12)
                .map(job => ({
                    email: job.email,
                    platform: job.platform,
                    fresh: job.fresh,
                    state: job.state,
                    startedAt: job.startedAt,
                    endedAt: job.endedAt,
                    exitCode: job.exitCode,
                    hint: job.hint || null,
                    verification: job.verification
                }))
            return json(res, 200, { jobs: list })
        }

        if (pathname === '/api/login/start' && req.method === 'POST') {
            const body = await readBody(req)
            const dir = currentBotDir()
            if (!dir) throw Object.assign(new Error('尚未连接有效实例'), { status: 422 })

            const email = String(body.email || '').trim()
            if (!EMAIL_RE.test(email)) return json(res, 422, { error: '邮箱格式不正确' })
            const platform = ['mobile', 'desktop', 'both'].includes(body.platform) ? body.platform : 'mobile'

            const result = await guardedBrowserStart(() => startManualLogin({ botDir: dir, email, platform, fresh: Boolean(body.fresh) }))
            if (!result.ok) return json(res, result.status || 400, { error: result.error })
            return json(res, 202, { ok: true, job: result.job })
        }

        if (pathname === '/api/login/job' && req.method === 'GET') {
            const email = (url.searchParams.get('email') || '').toLowerCase()
            return json(res, 200, { job: jobView(jobs.get(email)) })
        }

        if (pathname === '/api/login/stop' && req.method === 'POST') {
            const body = await readBody(req)
            const email = String(body.email || '').toLowerCase()
            const job = jobs.get(email)
            if (!job || job.state !== 'running') throw Object.assign(new Error('没有正在运行的登录任务'), { status: 404 })
            job.cancelled = true
            job.child?.kill()
            return json(res, 200, { ok: true })
        }

        /* ── Control API ── */
        if (pathname === '/api/control/start' && req.method === 'POST') {
            const body = await readBody(req)
            const result = await guardedBrowserStart(() => callControlApi('POST', '/start', body.payload || {}))
            return json(res, result.ok ? 202 : result.http || 503, result)
        }

        if (pathname === '/api/control/stop' && req.method === 'POST') {
            const result = await callControlApi('POST', '/stop', {})
            return json(res, result.ok ? 202 : result.http || 503, result)
        }

        if (pathname === '/api/events' && req.method === 'GET') {
            return handleSse(req, res, url)
        }

        if (pathname === '/api/health' && req.method === 'GET') {
            return json(res, 200, { ok: true, version: '2.0.0' })
        }

        if (pathname.startsWith('/api/')) return json(res, 404, { error: '未知接口' })

        if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname)
        return json(res, 405, { error: 'Method not allowed' })
    } catch (error) {
        const status = error.status || 500
        if (status >= 500) log('请求失败', req.method, pathname, error)
        return json(res, status, { error: error.message || '服务器错误', hint: error.hint, missing: error.missing })
    }
})

server.on('upgrade', (req, socket, head) => {
    if (REMOTE_DESKTOP) return desktopProxy.upgrade(req, socket, head)
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
})

/* ────────────────────────── 启动 ────────────────────────── */

loadConfig()
const tokenInfo = ensurePanelToken()

server.listen(PORT, HOST, () => {
    const botDir = currentBotDir()
    const lines = [
        '',
        '  ╭────────────────────────────────────────────────╮',
        '  │  Microsoft Rewards 登录面板  v2                │',
        '  ╰────────────────────────────────────────────────╯',
        `  地址        http://${HOST}:${PORT}`,
        `  实例目录    ${botDir || '未连接（进入面板后会引导设置）'}`,
        `  Control API ${state.controlApi || '未配置（可选，仅“跑分”需要）'}`,
        ''
    ]

    if (AUTH_DISABLED) {
        lines.push('  ⚠ PANEL_NO_AUTH=1：面板接口未设防，仅可用于完全可信的本机环境。')
    } else {
        lines.push(`  访问密码    ${tokenInfo.token}`)
        lines.push(`              （来源：${tokenInfo.source}${tokenInfo.generated ? '，已写入 config.json' : ''}）`)
        lines.push('              打开页面后输入此密码进入面板；可用 PANEL_TOKEN 环境变量覆盖。')
    }
    lines.push('')
    console.log(lines.join('\n'))
})

server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 已被占用，请设置 PANEL_PORT 换一个端口。`)
        process.exit(1)
    }
    throw error
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    desktopProxy.close()
    for (const client of sseClients) client.res.end()
    for (const job of jobs.values()) if (job.child) { job.cancelled = true; job.child.kill() }
    server.close()
    const deadline = Date.now() + 8000
    const timer = setInterval(() => {
        if (![...jobs.values()].some(job => job.child) || Date.now() > deadline) {
            clearInterval(timer)
            process.exit(0)
        }
    }, 100)
})
