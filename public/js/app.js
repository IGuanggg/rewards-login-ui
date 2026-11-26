/* ============================================================
   Rewards 控制台 · 前端逻辑 v2
   流程：解锁面板 → 连接上游实例（自检）→ 账号授权 → 复用会话
   ============================================================ */

import { createActivityPanel } from './activity.js'
import { createRunConsole } from './run-console.js'
import { createTaskSettings } from './task-settings.js'
import { createDashboard } from './dashboard.js'
import { createNotifications } from './notifications.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const LS = { theme: 'rwd.theme.v4' }

const state = {
    authRequired: true,
    authenticated: false,
    botDir: '',
    control: null,
    accounts: null,
    editingIndex: null,
    jobEmail: null,
    jobRunning: false,
    jobStream: null,
    logFilter: 'all',
    feedStream: null,
    feed: []
}

/* ────────────────────────── 工具 ────────────────────────── */

const escapeHtml = value =>
    String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

const timeOf = ts => (ts ? new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false }) : '—')
const dashboard = createDashboard({ api, escapeHtml, onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码') })
const notifications = createNotifications({ api, onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码') })
const activityPanel = createActivityPanel({ api, escapeHtml, timeOf, onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码') })
const runConsole = createRunConsole({ api,
    onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码'),
    onStart: index => { activityPanel.today(); toast('success', index == null ? '已提交全部账号签到，运行进度会自动更新' : '已提交该账号签到，运行进度会自动更新') },
    onError: message => toast('error', message, 5200),
    onAction: (action, email, info) => {
        if (action === 'dashboard') { $('#tabs [data-tab="dashboard"]').click(); return }
        if (action === 'stop-auth' && email) {
            api('/api/login/stop', { method: 'POST', body: { email } })
                .then(() => { toast('info', '已发送终止授权指令'); runConsole.refresh(true); refreshRuns() })
                .catch(error => toast('error', error.message))
            return
        }
        if (action === 'logs') { if (info?.latest) activityPanel.selectRun(info.latest.run); else activityPanel.today(); $('#tabs [data-tab="logs"]').click(); return }
        if (action === 'settings') { selectSettingsTab('system'); $('#tabs [data-tab="settings"]').click(); return }
        if (action === 'desktop' && info?.authorization?.desktopUrl) { window.open(info.authorization.desktopUrl, '_blank', 'noopener'); return }
        $('#tabs [data-tab="accounts"]').click()
        if (action === 'accounts') { $('#btn-add-account').click(); return }
        if (action === 'login') {
            const account = state.accounts?.accounts?.find(account => account.email === email) || state.accounts?.accounts?.[0]
            if (account) openLoginDialog(account)
            else $('#btn-add-account').click()
        }
    }
})
const taskSettings = createTaskSettings({ api, escapeHtml, onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码'), onSaved: () => runConsole.refresh(true) })

function ago(ts) {
    if (!ts) return ''
    const diff = Date.now() - Number(ts)
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return `${Math.floor(diff / 86_400_000)} 天前`
}

async function api(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(pathname, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000)
    }).catch(error => {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('请求超时，请重试')
        throw error
    })
    let data = {}
    try {
        data = await response.json()
    } catch {}
    if (!response.ok) {
        const error = new Error(data?.error || `请求失败（HTTP ${response.status}）`)
        error.status = response.status
        error.hint = data?.hint
        error.missing = data?.missing
        error.retryIn = data?.retryIn
        error.body = data
        throw error
    }
    return data
}

/* ────────────────────────── Toast ────────────────────────── */

const ICONS = {
    success: '<path d="m5 12.5 4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    error: '<path d="M12 8v5m0 3.2v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    info: '<path d="M12 11v5m0-8.5v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
}

function toast(type, message, timeout = 3800) {
    const el = document.createElement('div')
    el.className = `toast toast--${type}`
    el.innerHTML = `<svg class="toast__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONS[type] || ICONS.info}</svg><span>${escapeHtml(message)}</span>`
    $('#toasts').appendChild(el)
    const close = () => {
        el.classList.add('is-out')
        setTimeout(() => el.remove(), 260)
    }
    el.addEventListener('click', close)
    setTimeout(close, timeout)
}

function confirmDialog({ title, message, confirmText = '确认', danger = false }) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog')
        dialog.className = 'dialog'
        dialog.innerHTML = `
            <div class="dialog__inner">
                <header class="dialog__head"><h3>${escapeHtml(title)}</h3></header>
                <div class="dialog__body prose"><p>${escapeHtml(message)}</p></div>
                <footer class="dialog__foot">
                    <button class="ghost-btn ghost-btn--bordered" data-act="cancel">取消</button>
                    <button class="liquid-btn liquid-btn--solid${danger ? ' liquid-btn--danger' : ''}" data-act="ok" style="min-width:110px"><span class="liquid-btn__text">${escapeHtml(confirmText)}</span></button>
                </footer>
            </div>`
        document.body.appendChild(dialog)
        dialog.addEventListener('click', event => {
            const act = event.target.closest('[data-act]')?.dataset.act
            if (act === 'ok') {
                dialog.close()
                resolve(true)
            } else if (act === 'cancel') {
                dialog.close()
                resolve(false)
            }
        })
        dialog.addEventListener('close', () => {
            dialog.remove()
            resolve(false)
        })
        dialog.showModal()
    })
}

/* ────────────────────────── 视图 ────────────────────────── */

const VIEWS = { unlock: '#view-unlock', setup: '#view-setup', app: '#view-app' }

function showView(name) {
    for (const [key, selector] of Object.entries(VIEWS)) $(selector).hidden = key !== name
    $('#appfoot').hidden = name !== 'app'
    if (name !== 'app') {
        runConsole.stop()
        dashboard.stop()
        activityPanel.stop()
        closeFeed()
        closeJobStream()
    }
}

function showUnlock(message) {
    showView('unlock')
    const errorEl = $('#unlock-error')
    if (message) {
        errorEl.textContent = message
        errorEl.hidden = false
    } else {
        errorEl.hidden = true
    }
    setTimeout(() => $('#unlock-token')?.focus(), 50)
}

function showSetup() {
    showView('setup')
    $('#setup-path').value = state.botDir || ''
    $('#setup-error').hidden = true
    detectInstance(true)
}

function showApp() {
    showView('app')
    runConsole.open()
    if ($('#tabs .is-active')?.dataset.tab === 'dashboard') dashboard.open()
    $('#topbar-path').textContent = '中国大陆'
    $('#topbar-path').title = state.botDir
    $('#appfoot-path').textContent = 'v5.0 内核适配'
    $('#appfoot-path').title = state.botDir
    $('#s-botdir').value = state.botDir
    $('#s-control-api').value = state.control?.base || ''
}

/* ────────────────────────── 解锁 ────────────────────────── */

async function handleUnlock(event) {
    event.preventDefault()
    const button = $('#btn-unlock')
    const errorEl = $('#unlock-error')
    const token = $('#unlock-token').value.trim()

    if (!token) {
        errorEl.textContent = '请输入访问密码'
        errorEl.hidden = false
        return
    }

    button.disabled = true
    button.classList.add('is-loading')
    $('.liquid-btn__text', button).textContent = '验证中…'

    try {
        await api('/api/auth/login', { method: 'POST', body: { token } })
        $('#unlock-token').value = ''
        errorEl.hidden = true
        await bootAfterAuth()
    } catch (error) {
        errorEl.textContent = error.retryIn ? `${error.message}` : error.message
        errorEl.hidden = false
        $('#unlock-token').select()
    } finally {
        button.disabled = false
        button.classList.remove('is-loading')
        $('.liquid-btn__text', button).textContent = '进入控制台'
    }
}

/* ────────────────────────── 首次设置 / 自检 ────────────────────────── */

function renderChecks(listEl, checks, { compact = false } = {}) {
    listEl.innerHTML = checks
        .map(check => {
            const tone = check.ok ? 'ok' : check.fatal ? 'bad' : 'warn'
            const icon = check.ok
                ? '<path d="m5 12.5 4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
                : '<path d="M12 8v5m0 3.2v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
            return `<li class="checkitem checkitem--${tone}">
                <svg class="checkitem__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${icon}</svg>
                <div class="checkitem__text">
                    <strong>${escapeHtml(check.label)}</strong>
                    ${compact ? '' : `<span>${escapeHtml(check.detail || '')}</span>`}
                </div>
            </li>`
        })
        .join('')
}

async function runPreflight(dir) {
    const list = $('#setup-checks')
    list.innerHTML = '<li class="checkitem checkitem--muted"><div class="checkitem__text"><span>正在检查…</span></div></li>'
    try {
        const query = dir ? `?botDir=${encodeURIComponent(dir)}` : ''
        const result = await api(`/api/preflight${query}`)
        renderChecks(list, result.checks || [])
        return result
    } catch (error) {
        list.innerHTML = `<li class="checkitem checkitem--bad"><div class="checkitem__text"><span>${escapeHtml(error.message)}</span></div></li>`
        return null
    }
}

async function detectInstance(silent) {
    try {
        const result = await api('/api/detect')
        if (result.detected) {
            $('#setup-path').value = result.botDir
            if (!silent) toast('success', `已探测到实例：${result.botDir}`)
            runPreflight(result.botDir)
            return result.botDir
        }
        if (!silent) toast('info', '没有自动探测到脚本仓库，请手动填写根目录')
    } catch (error) {
        if (!silent) toast('error', error.message)
    }
    runPreflight('')
    return ''
}

async function handleConnect() {
    const button = $('#btn-setup-connect')
    const errorEl = $('#setup-error')
    const dir = $('#setup-path').value.trim()

    errorEl.hidden = true
    if (!dir) {
        errorEl.textContent = '请填写脚本仓库根目录'
        errorEl.hidden = false
        return
    }

    button.disabled = true
    $('.liquid-btn__text', button).textContent = '检查中…'

    try {
        const check = await runPreflight(dir)
        if (!check?.ready) {
            errorEl.textContent = `环境未就绪：${(check?.blocking || ['未知错误']).join('、')}。请先按上方提示修复。`
            errorEl.hidden = false
            return
        }
        const result = await api('/api/config', { method: 'PUT', body: { botDir: dir } })
        state.botDir = result.botDir
        state.control = result.control
        applyAccounts(result.accounts)
        showApp()
        await refreshState()
        await refreshAccounts()
        await refreshRuns()
        openFeed()
        toast('success', '实例已连接')
    } catch (error) {
        errorEl.textContent = error.missing ? `${error.message}` : error.message
        errorEl.hidden = false
    } finally {
        button.disabled = false
        $('.liquid-btn__text', button).textContent = '检查并连接'
    }
}

/* ────────────────────────── 状态 ────────────────────────── */

async function refreshState() {
    try {
        const info = await api('/api/state')
        state.botDir = info.botDir || state.botDir
        state.control = info.control

        const envPill = $('#pill-env')
        envPill.classList.remove('is-ok', 'is-warn', 'is-bad')
        envPill.classList.add(state.botDir ? 'is-ok' : 'is-bad')
        $('span', envPill).textContent = state.botDir ? '实例已连接' : '未连接实例'

        const apiPill = $('#pill-api')
        apiPill.classList.remove('is-ok', 'is-warn', 'is-bad')
        const status = info.control?.status
        if (status === 'online') {
            apiPill.classList.add('is-ok')
            $('span', apiPill).textContent = '签到接口在线'
        } else if (status === 'unauthorized') {
            apiPill.classList.add('is-bad')
            $('span', apiPill).textContent = '签到令牌无效'
        } else if (status === 'error' || status === 'offline') {
            apiPill.classList.add('is-bad')
            $('span', apiPill).textContent = '签到接口异常'
        } else {
            apiPill.classList.add('is-warn')
            $('span', apiPill).textContent = '签到接口未配置'
        }

        const note = $('#s-control-note')
        const map = {
            online: `在线：${info.control.detail || ''}`,
            unauthorized: '令牌无效：请填写上游 API_TOKEN',
            offline: `无法连接：${info.control?.detail || ''}`,
            error: info.control?.detail || '接口异常',
            unconfigured: '未配置。仅“运行签到”需要它，账号授权不受影响。'
        }
        note.textContent = map[status] || '—'
        note.dataset.tone = status === 'online' ? 'ok' : status === 'unconfigured' ? 'muted' : 'bad'

        const hasControlToken = Boolean(info.hasControlToken)
        const tokenInput = $('#s-control-token')
        if (tokenInput) {
            tokenInput.placeholder = hasControlToken ? '已保存，留空保留；填写可替换' : '填入上游 API_TOKEN（可选）'
        }
        const clearWrap = $('#s-control-token-clear-wrap')
        const clearBox = $('#s-control-token-clear')
        if (clearWrap) clearWrap.hidden = !hasControlToken
        if (clearBox && !hasControlToken) clearBox.checked = false

        $('#s-auth-note').textContent = !info.authRequired
            ? '已通过 PANEL_NO_AUTH 关闭密码验证。'
            : info.passwordManagedByEnv
              ? '当前密码由环境变量 PANEL_TOKEN 接管：在此修改仅本次运行有效，重启容器后会恢复为环境变量值。修改后保留当前窗口登录态，其他设备需重新登录。'
              : '修改后保留当前窗口登录态，其他已登录设备需使用新密码重新登录。'
        $('#s-auth-note').dataset.tone = info.authRequired ? 'muted' : 'bad'

        const preflight = await api('/api/preflight').catch(() => null)
        if (preflight) renderChecks($('#settings-checks'), preflight.checks || [], { compact: false })

        $('#cmd-hint').textContent = [
            '命令行等价操作：',
            `  cd "${state.botDir}"`,
            '  npm install && npx patchright install chromium',
            '  node scripts/main/manualLogin.js --email <邮箱> --platform mobile|desktop|both [--fresh]'
        ].join('\n')

        return info
    } catch (error) {
        if (error.status === 401) {
            showUnlock('会话已过期，请重新输入访问密码')
            return null
        }
        toast('error', `读取状态失败：${error.message}`)
        return null
    }
}

/* ────────────────────────── 账号 ────────────────────────── */

function applyAccounts(payload) {
    if (!payload || payload.ok === false) return
    state.accounts = payload
    renderAccounts()
    runConsole.render()
    runConsole.refresh()
    const hint = $('#accounts-hint')
    const sessions = payload.sessions || {}
    hint.textContent = payload.envExists
        ? `${payload.accounts?.length || 0} 个账号`
        : '添加第一个账号开始使用'
    hint.title = payload.envPath || ''
    if (sessions.configured && sessions.configured !== 'sessions') {
        hint.textContent += ` · 会话目录 config.sessionPath=${sessions.configured}`
    }
    if (sessions.error) hint.textContent += ` · 会话库读取失败：${sessions.error}`
}

async function refreshAccounts() {
    try {
        const payload = await api('/api/accounts')
        if (payload.needsSetup) {
            showSetup()
            return
        }
        applyAccounts(payload)
    } catch (error) {
        if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
        toast('error', error.message)
    }
}

function sessionTile(label, session) {
    const ok = Boolean(session?.cookies)
    if (!ok) {
        return `<div class="session-tile" data-ok="false">
            <span class="session-tile__dot" aria-hidden="true"></span>
            <div class="session-tile__body">
                <strong>${label}</strong>
                <span>未登录</span>
            </div>
        </div>`
    }
    const when = session.updatedAt ? ago(session.updatedAt) : '已保存'
    const detail = `${when} · ${session.cookies} CK`
    return `<div class="session-tile" data-ok="true" title="${label}已保存 · ${session.cookies} cookies">
        <span class="session-tile__dot" aria-hidden="true"></span>
        <div class="session-tile__body">
            <strong>${label}</strong>
            <span>${escapeHtml(detail)}</span>
        </div>
    </div>`
}

function renderAccounts() {
    const list = $('#account-list')
    const empty = $('#accounts-empty')
    const accounts = state.accounts?.accounts ?? []

    if (!accounts.length) {
        list.innerHTML = ''
        empty.hidden = false
        return
    }
    empty.hidden = true

    list.innerHTML = accounts
        .map(account => {
            const hasMobile = Boolean(account.sessions?.mobile?.cookies)
            const hasDesktop = Boolean(account.sessions?.desktop?.cookies)
            const connected = hasMobile || hasDesktop
            const bothReady = hasMobile && hasDesktop
            const extra = [
                account.hasPassword ? '已存密码' : '',
                account.hasTotp ? '2FA' : '',
                account.hasProxy ? '代理' : ''
            ].filter(Boolean)

            return `<li class="account-item" data-index="${account.index}" data-email="${escapeHtml(account.email)}">
                <div class="account-item__top">
                    <span class="avatar" aria-hidden="true">${escapeHtml((account.email || '?').slice(0, 1).toUpperCase())}</span>
                    <div class="account-item__main">
                        <div class="account-item__email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</div>
                        <div class="account-item__tags">
                            <span class="meta-chip">#${account.index}</span>
                            ${extra.map(label => `<span class="meta-chip">${escapeHtml(label)}</span>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="account-item__sessions">
                    ${sessionTile('手机端', account.sessions?.mobile)}
                    ${sessionTile('电脑端', account.sessions?.desktop)}
                </div>
                <div class="account-item__actions">
                    <button class="mini-btn" type="button" data-act="run">运行签到</button>
                    <button class="mini-btn${bothReady ? '' : ' mini-btn--primary'}" type="button" data-act="authorize">${connected ? (bothReady ? '管理登录' : '补全登录') : '登录账号'}</button>
                    <button class="mini-btn mini-btn--ghost mini-btn--spacer" type="button" data-act="edit">编辑</button>
                    <button class="mini-btn mini-btn--danger" type="button" data-act="delete">删除</button>
                </div>
            </li>`
        })
        .join('')
}

/* ────────────────────────── 最近任务 ────────────────────────── */

const RUN_LABEL = { running: '进行中', done: '已保存', partial: '部分保存', failed: '失败', cancelled: '已终止' }

async function refreshRuns() {
    try {
        const { jobs } = await api('/api/jobs')
        renderRuns(jobs || [])
    } catch (error) {
        if (error.status === 401) showUnlock('会话已过期，请重新输入访问密码')
    }
}

function renderRuns(jobs) {
    const list = $('#run-list')
    $('#runs-count').textContent = `${jobs.length} 条`

    if (!jobs.length) {
        list.innerHTML = '<li class="run-list__empty">暂无授权记录</li>'
        return
    }

    list.innerHTML = jobs
        .map(job => {
            const platform = job.platform === 'both' ? '移动端 + 桌面端' : job.platform === 'desktop' ? '桌面端' : '移动端'
            const when = job.endedAt ? `${timeOf(job.startedAt)} → ${timeOf(job.endedAt)}` : `开始于 ${timeOf(job.startedAt)}`
            const tone = job.state === 'done' ? 'tag--ok' : job.state === 'partial' ? 'tag--warn' : job.state === 'failed' || job.state === 'cancelled' ? 'tag--warn' : 'tag--accent'
            return `<li class="run-item" data-state="${job.state}">
                <span class="run-item__dot"></span>
                <div class="run-item__main">
                    <div class="run-item__email" title="${escapeHtml(job.email)}">${escapeHtml(job.email)}</div>
                    <p class="run-item__meta">${platform} · ${when}</p>
                </div>
                <span class="tag ${tone}">${escapeHtml(RUN_LABEL[job.state] || job.state)}</span>
            </li>`
        })
        .join('')
}

/* ────────────────────────── 账号表单 ────────────────────────── */

const FIELDS = {
    email: '#f-email',
    password: '#f-password',
    totpSecret: '#f-totp',
    recoveryEmail: '#f-recovery',
    geoLocale: '#f-geo',
    langCode: '#f-lang',
    proxyUrl: '#f-proxy-url',
    proxyPort: '#f-proxy-port',
    proxyUsername: '#f-proxy-user',
    proxyPassword: '#f-proxy-pass'
}

function setFormMode(account) {
    state.editingIndex = account ? account.index : null
    $('#form-title').textContent = account ? '编辑账号' : '添加账号'
    $('#form-lead').textContent = account
        ? '留空的密码、密钥与代理会保持原样，也可勾选下方清除项删除。'
        : '先添加邮箱，再点「登录账号」完成微软登录，最后一键运行签到。'
    $('#btn-save .liquid-btn__text').textContent = account ? '保存修改' : '保存账号'
    $('#btn-reset').textContent = account ? '重置修改' : '清空'
    $('#btn-close-form').hidden = !account && !(state.accounts?.accounts?.length)
}

function setClearFlags(account = null) {
    const toggle = (wrapSel, boxSel, show) => {
        const wrap = $(wrapSel)
        const box = $(boxSel)
        if (wrap) wrap.hidden = !show
        if (box) box.checked = false
    }
    toggle('#f-remove-password-wrap', '#f-remove-password', Boolean(account?.hasPassword))
    toggle('#f-remove-totp-wrap', '#f-remove-totp', Boolean(account?.hasTotp))
    toggle('#f-remove-recovery-wrap', '#f-remove-recovery', Boolean(account?.hasRecovery))
    toggle('#f-remove-proxy-wrap', '#f-remove-proxy', Boolean(account?.hasProxy))
    const proxyCurrent = $('#f-proxy-current')
    if (proxyCurrent) {
        proxyCurrent.hidden = !account?.hasProxy
        proxyCurrent.textContent = account?.hasProxy ? `当前已存代理：${account.proxyLabel || '已配置'}` : ''
    }
}

function fillForm(account) {
    if (!account) return resetForm()
    $('#f-email').value = account.email
    $('#f-password').value = ''
    $('#f-password').placeholder = account.hasPassword ? '已保存，留空保持原密码' : '密码登录时必填'
    $('#f-totp').value = ''
    $('#f-totp').placeholder = account.hasTotp ? '已保存，留空则不修改' : 'JBSWY3DPEHPK3PXP'
    $('#f-recovery').value = ''
    $('#f-recovery').placeholder = account.hasRecovery ? '已保存，留空则不修改' : 'recovery@example.com'
    $('#f-geo').value = account.geoLocale || 'auto'
    $('#f-lang').value = account.langCode || 'zh-CN'
    $('#f-proxy-url').value = ''
    $('#f-proxy-url').placeholder = account.hasProxy ? '留空保持当前代理；填写新地址可替换' : 'http://127.0.0.1'
    $('#f-proxy-port').value = ''
    $('#f-proxy-user').value = ''
    $('#f-proxy-pass').value = ''
    $('#f-fp-mobile').checked = Boolean(account.saveFingerprint?.mobile)
    $('#f-fp-desktop').checked = Boolean(account.saveFingerprint?.desktop)
    setClearFlags(account)
    $('#form-error').hidden = true
    setFormMode(account)
}

function resetForm() {
    for (const selector of Object.values(FIELDS)) {
        const el = $(selector)
        if (el instanceof HTMLInputElement) el.value = ''
    }
    $('#f-geo').value = 'auto'
    $('#f-lang').value = 'zh-CN'
    $('#f-password').placeholder = '密码登录时必填'
    $('#f-totp').placeholder = 'JBSWY3DPEHPK3PXP'
    $('#f-recovery').placeholder = 'recovery@example.com'
    $('#f-proxy-url').placeholder = 'http://127.0.0.1'
    $('#f-fp-mobile').checked = true
    $('#f-fp-desktop').checked = true
    setClearFlags(null)
    $('#form-error').hidden = true
    setFormMode(null)
}

async function handleSaveAccount(event) {
    event.preventDefault()
    const button = $('#btn-save')
    const errorEl = $('#form-error')
    const wasEditing = Boolean(state.editingIndex)

    const body = {
        saveFingerprintMobile: $('#f-fp-mobile').checked,
        saveFingerprintDesktop: $('#f-fp-desktop').checked
    }
    if (state.editingIndex) {
        body.index = state.editingIndex
        body.removePassword = Boolean($('#f-remove-password')?.checked)
        body.removeTotp = Boolean($('#f-remove-totp')?.checked)
        body.removeRecovery = Boolean($('#f-remove-recovery')?.checked)
        body.removeProxy = Boolean($('#f-remove-proxy')?.checked)
    }
    for (const [key, selector] of Object.entries(FIELDS)) {
        const el = $(selector)
        if (el instanceof HTMLInputElement) body[key] = el.value
    }

    if (!body.email.trim()) {
        errorEl.textContent = '请填写微软账号邮箱'
        errorEl.hidden = false
        $('#f-email').focus()
        return
    }

    button.disabled = true
    $('.liquid-btn__text', button).textContent = '保存中…'

    try {
        const payload = await api('/api/accounts', { method: 'POST', body })
        applyAccounts(payload)
        resetForm()
        $('#account-editor').classList.remove('is-open')
        toast('success', wasEditing ? '账号配置已更新' : '账号已保存，点「登录账号」即可完成授权')
    } catch (error) {
        if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
        errorEl.textContent = error.message
        errorEl.hidden = false
    } finally {
        button.disabled = false
        $('.liquid-btn__text', button).textContent = state.editingIndex ? '保存修改' : '保存账号'
    }
}

/* ────────────────────────── 授权弹窗 ────────────────────────── */

const PLATFORM_HINT = {
    mobile: '仅登录手机端（1 次），用于手机搜索与每日签到任务。',
    desktop: '仅登录电脑端（1 次），用于电脑搜索与浏览活动。',
    both: '依次完成手机端与电脑端登录（共 2 次），首窗关闭后自动弹出下一窗。'
}

function pickDefaultPlatform(account) {
    const hasMobile = Boolean(account?.sessions?.mobile?.cookies)
    const hasDesktop = Boolean(account?.sessions?.desktop?.cookies)
    if (!hasMobile && hasDesktop) return 'mobile'
    if (hasMobile && !hasDesktop) return 'desktop'
    return 'both'
}

function syncPlatformPicker() {
    let selected = 'both'
    for (const chip of $$('#platform-picker .radio-chip')) {
        const input = $('input', chip)
        chip.classList.toggle('is-active', input.checked)
        if (input.checked) selected = input.value
    }
    const hint = $('#platform-hint')
    if (hint) hint.textContent = PLATFORM_HINT[selected] || PLATFORM_HINT.both
}

function renderLoginSessionState(account) {
    const box = $('#login-session-state')
    if (!box) return
    const items = [
        { key: 'mobile', label: '手机端会话', session: account?.sessions?.mobile },
        { key: 'desktop', label: '电脑端会话', session: account?.sessions?.desktop }
    ]
    box.innerHTML = items
        .map(({ label, session }) => {
            const ok = Boolean(session?.cookies)
            const meta = ok ? `已连接 · ${session.cookies} cookies · ${ago(session.updatedAt) || '已保存'}` : '尚未登录'
            return `<div class="session-card" data-ok="${ok}">
                <span class="session-card__dot" aria-hidden="true"></span>
                <div>
                    <strong>${label}</strong>
                    <span>${escapeHtml(meta)}</span>
                </div>
            </div>`
        })
        .join('')
}

function detectLoginPhase(job) {
    if (!job || job.platform !== 'both') return null
    const details = job.verification?.details || []
    const verified = p => details.find(d => d.platform === p)
    const lines = (job.log || []).map(line => line.text || '')
    const savedMobile = Boolean(verified('mobile')?.fresh) || lines.some(t => /Saved mobile session/i.test(t))
    const savedDesktop = Boolean(verified('desktop')?.fresh) || lines.some(t => /Saved desktop session/i.test(t))
    const openedDesktop = savedDesktop || lines.some(t => /Opening desktop|desktop manual login|\[DESKTOP\]/i.test(t))

    if (job.state !== 'running') {
        const mOk = Boolean(verified('mobile')?.fresh)
        const dOk = Boolean(verified('desktop')?.fresh)
        return {
            step: dOk || mOk ? 2 : 1,
            mobile: mOk ? 'done' : 'failed',
            desktop: dOk ? 'done' : 'failed',
            mobileText: mOk ? '会话已保存' : '未写入会话',
            desktopText: dOk ? '会话已保存' : '未写入会话'
        }
    }
    if (savedDesktop) {
        return { step: 2, mobile: savedMobile ? 'done' : 'active', desktop: 'done', mobileText: savedMobile ? '已保存' : '检测中', desktopText: '已保存' }
    }
    if (savedMobile || openedDesktop) {
        return {
            step: 2,
            mobile: savedMobile ? 'done' : 'active',
            desktop: 'active',
            mobileText: savedMobile ? '已完成并保存' : '切换中',
            desktopText: '请在浏览器中完成第 2 次登录'
        }
    }
    return {
        step: 1,
        mobile: 'active',
        desktop: 'pending',
        mobileText: '请在浏览器中完成第 1 次登录',
        desktopText: '等待移动端保存后自动弹出'
    }
}

function renderLoginSteps(job) {
    const el = $('#login-steps')
    if (!el) return null
    const phase = detectLoginPhase(job)
    if (!phase) {
        el.hidden = true
        return null
    }
    el.hidden = false
    el.innerHTML = `
        <div class="login-step" data-state="${phase.mobile}">
            <span class="login-step__num">${phase.mobile === 'done' ? '✓' : '1'}</span>
            <div class="login-step__body">
                <strong>步骤 1 · 移动端登录</strong>
                <span>${escapeHtml(phase.mobileText)}</span>
            </div>
        </div>
        <div class="login-step" data-state="${phase.desktop}">
            <span class="login-step__num">${phase.desktop === 'done' ? '✓' : '2'}</span>
            <div class="login-step__body">
                <strong>步骤 2 · 桌面端登录</strong>
                <span>${escapeHtml(phase.desktopText)}</span>
            </div>
        </div>`
    return phase
}

function setLoginInputsLocked(locked) {
    const picker = $('#platform-picker')
    if (picker) {
        picker.classList.toggle('is-locked', locked)
        for (const input of $$('input', picker)) input.disabled = locked
    }
    const freshInput = $('#opt-fresh')
    if (freshInput) freshInput.disabled = locked
    $('#opt-fresh-row')?.classList.toggle('is-locked', locked)
}

function selectPlatformRadio(value) {
    for (const chip of $$('#platform-picker .radio-chip')) {
        const input = $('input', chip)
        input.checked = input.value === value
    }
    syncPlatformPicker()
}

function setLoginFooter({
    startVisible = true,
    startDisabled = false,
    startText = '启动浏览器授权',
    stopVisible = false,
    doneVisible = false,
    runNowVisible = false,
    reauthVisible = false,
    closeVisible = false
} = {}) {
    const startBtn = $('#btn-start-login')
    if (startBtn) {
        startBtn.hidden = !startVisible
        startBtn.disabled = startDisabled || Boolean(startBtn.dataset.blockedByBusy)
        $('.liquid-btn__text', startBtn).textContent = startText
    }
    if ($('#btn-stop-login')) $('#btn-stop-login').hidden = !stopVisible
    if ($('#btn-login-done')) $('#btn-login-done').hidden = !doneVisible
    if ($('#btn-login-run-now')) $('#btn-login-run-now').hidden = !runNowVisible
    if ($('#btn-reauth-login')) $('#btn-reauth-login').hidden = !reauthVisible
    if ($('#btn-login-close')) $('#btn-login-close').hidden = !closeVisible
}

function openLoginDialog(account) {
    const preferred = pickDefaultPlatform(account)
    selectPlatformRadio(preferred)
    if ($('#opt-fresh')) $('#opt-fresh').checked = false
    setLoginInputsLocked(false)
    renderLoginSessionState(account)

    state.jobEmail = account.email
    state.jobRunning = false
    $('#dlg-login-title').textContent = `微软账号授权 · ACCOUNT_${account.index}`
    $('#dlg-login-sub').textContent = account.email
    $('#job-log').innerHTML = '<div class="log-empty">启动后这里会实时显示上游脚本的输出。</div>'
    $('#job-status').dataset.state = 'idle'
    $('.job-status__text').textContent = '等待开始'
    $('#job-time').textContent = ''
    $('#job-hint').hidden = true
    $('#remote-browser').hidden = true
    $('#login-steps').hidden = true
    $('#verify-list').hidden = true
    setLoginFooter({ startVisible: true, startDisabled: false, startText: '启动浏览器授权' })
    runConsole.render()
    $('#dlg-login').showModal()

    // 仅接管正在运行中的授权任务，不把过期的历史任务盖到当前会话状态上
    api(`/api/login/job?email=${encodeURIComponent(account.email)}`)
        .then(({ job }) => {
            if (!job || job.state !== 'running' || !$('#dlg-login').open || state.jobEmail !== account.email) return
            renderJob(job)
            connectJobStream(account.email)
        })
        .catch(() => {})
}

function connectJobStream(email) {
    closeJobStream()
    const stream = new EventSource(`/api/events?email=${encodeURIComponent(email)}`)
    state.jobStream = stream
    stream.addEventListener('job', event => {
        try {
            const job = JSON.parse(event.data)
            if (job) renderJob(job)
        } catch {}
    })
}

function closeJobStream() {
    if (state.jobStream) {
        state.jobStream.close()
        state.jobStream = null
    }
}

function renderJob(job) {
    if (!job || (state.jobEmail && job.email !== state.jobEmail)) return
    state.jobRunning = job.state === 'running'
    const statusEl = $('#job-status')
    const textEl = $('.job-status__text', statusEl)
    const hintEl = $('#job-hint')
    const remote = $('#remote-browser')
    remote.hidden = !job.desktopUrl || job.state !== 'running'
    if (job.desktopUrl) $('#remote-browser-link').href = job.desktopUrl
    else $('#remote-browser-link').removeAttribute('href')
    statusEl.dataset.state = job.state

    hintEl.hidden = !job.hint
    if (job.hint) hintEl.textContent = job.hint

    const phase = renderLoginSteps(job)
    const remoteNote = $('#remote-browser-note')
    if (remoteNote) {
        if (job.platform === 'both') {
            remoteNote.textContent =
                phase?.step === 2
                    ? '移动端已保存！当前为第 2/2 步，请在远程窗口继续完成桌面端登录。'
                    : '当前为第 1/2 步（移动端登录）；完成后窗口会关闭并自动打开第 2 个桌面端登录窗口。'
        } else {
            remoteNote.textContent = `仅需完成 1 次${job.platform === 'desktop' ? '桌面端' : '移动端'}微软登录，完成后自动保存会话。`
        }
    }

    const verifyEl = $('#verify-list')
    if (job.verification?.details?.length) {
        verifyEl.hidden = false
        verifyEl.innerHTML = job.verification.details
            .map(
                item => `<li class="verify-item" data-ok="${item.fresh}">
                    <span>${item.platform === 'mobile' ? '移动端' : '桌面端'}</span>
                    <span>${item.fresh ? `已写入 · ${item.cookies ?? '?'} cookies · ${timeOf(item.updatedAt)}` : '未写入'}</span>
                </li>`
            )
            .join('')
    } else {
        verifyEl.hidden = true
    }

    const platformText = job.platform === 'both' ? '移动端 + 桌面端' : job.platform === 'desktop' ? '桌面端' : '移动端'

    if (job.state === 'running') {
        selectPlatformRadio(job.platform)
        if ($('#opt-fresh')) $('#opt-fresh').checked = Boolean(job.fresh)
        setLoginInputsLocked(true)
        if (job.platform === 'both' && phase) {
            textEl.textContent =
                phase.step === 2
                    ? '步骤 2/2 · 移动端已保存，请继续完成桌面端登录'
                    : `${job.desktopUrl ? '步骤 1/2 · 请在远程窗口完成移动端登录' : '步骤 1/2 · 正在启动移动端登录'}`
        } else {
            textEl.textContent = `${job.desktopUrl ? '等待你在远程窗口登录' : '运行中'} · ${platformText}${job.fresh ? ' · 全新授权' : ''}`
        }
        $('#job-time').textContent = `开始于 ${timeOf(job.startedAt)}`
        setLoginFooter({
            stopVisible: true,
            startVisible: true,
            startDisabled: true,
            startText: job.desktopUrl ? '等待完成登录' : '运行中…'
        })
    } else if (job.state === 'done' || job.state === 'partial') {
        setLoginInputsLocked(false)
        textEl.textContent = job.state === 'done' ? `授权完成 · 会话已写入 ${platformText}` : `只完成 ${job.verification?.saved.map(p => (p === 'mobile' ? '移动端' : '桌面端')).join('、') || '部分平台'}`
        $('#job-time').textContent = timeOf(job.endedAt)
        setLoginFooter({ doneVisible: job.state === 'done', closeVisible: job.state !== 'done', startVisible: job.state !== 'done', startText: '继续补全登录' })
        closeJobStream()
        refreshAccounts().then(() => {
            if (!$('#dlg-login').open || state.jobEmail !== job.email || state.jobRunning) return
            const updated = state.accounts?.accounts?.find(a => a.email === job.email)
            if (updated) renderLoginSessionState(updated)
            const hasMobile = Boolean(updated?.sessions?.mobile?.cookies)
            const hasDesktop = Boolean(updated?.sessions?.desktop?.cookies)
            if (job.state === 'done' && hasMobile && hasDesktop) {
                setLoginFooter({
                    startVisible: false,
                    doneVisible: true,
                    runNowVisible: true,
                    reauthVisible: true
                })
            } else {
                const missing = !hasDesktop ? 'desktop' : !hasMobile ? 'mobile' : 'both'
                selectPlatformRadio(missing)
                setLoginFooter({
                    startVisible: true,
                    startDisabled: false,
                    startText: missing === 'desktop' ? '继续登录电脑端' : missing === 'mobile' ? '继续登录手机端' : '重新授权',
                    closeVisible: true
                })
            }
        })
        refreshRuns()
    } else if (job.state === 'failed' || job.state === 'cancelled') {
        setLoginInputsLocked(false)
        textEl.textContent =
            job.state === 'cancelled'
                ? '已终止'
                : job.exitCode === 0
                  ? '未检测到新会话，请重试'
                  : `运行失败（退出码 ${job.exitCode ?? '—'}）`
        $('#job-time').textContent = timeOf(job.endedAt)
        setLoginFooter({ closeVisible: true, startVisible: true, startDisabled: false, startText: '重试' })
        closeJobStream()
        refreshAccounts().then(() => {
            if (!$('#dlg-login').open || state.jobEmail !== job.email || state.jobRunning) return
            const updated = state.accounts?.accounts?.find(a => a.email === job.email)
            if (updated) renderLoginSessionState(updated)
        })
        refreshRuns()
    }

    renderJobLog(job.log || [])
}

function renderJobLog(lines) {
    const view = $('#job-log')
    const stick = view.scrollHeight - view.scrollTop - view.clientHeight < 50
    if (!lines.length) {
        view.innerHTML = '<div class="log-empty">启动后这里会实时显示上游脚本的输出。</div>'
        return
    }
    view.innerHTML = lines
        .map(
            line => `<div class="log-line" data-level="${escapeHtml(line.level)}">
                <span class="log-line__time">${line.t ? timeOf(line.t) : ''}</span>
                <span class="log-line__level">${escapeHtml(line.level)}</span>
                <span class="log-line__msg">${escapeHtml(line.text)}</span>
            </div>`
        )
        .join('')
    if (stick) view.scrollTop = view.scrollHeight
}

async function handleStartLogin() {
    if (!state.jobEmail) return
    const platform = $('input[name="platform"]:checked')?.value || 'both'
    const fresh = $('#opt-fresh').checked
    setLoginFooter({ startVisible: true, startDisabled: true, startText: '启动中…' })

    try {
        $('#job-log').innerHTML = ''
        $('#job-hint').hidden = true
        const { job } = await api('/api/login/start', {
            method: 'POST',
            body: { email: state.jobEmail, platform, fresh }
        })
        renderJob(job)
        connectJobStream(state.jobEmail)
        runConsole.refresh(true)
        toast('info', '授权已启动，请按页面提示完成微软登录')
    } catch (error) {
        if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
        setLoginInputsLocked(false)
        const hint = $('#job-hint')
        if (hint) {
            hint.textContent = error.message
            hint.hidden = false
        }
        $('#job-status').dataset.state = 'failed'
        $('.job-status__text').textContent = '无法启动授权'
        setLoginFooter({ startVisible: true, startDisabled: false, startText: '启动浏览器授权', closeVisible: true })
        runConsole.refresh(true)
    }
}

async function handleStopLogin() {
    if (!state.jobEmail) return
    try {
        await api('/api/login/stop', { method: 'POST', body: { email: state.jobEmail } })
        toast('info', '已发送终止指令')
    } catch (error) {
        toast('error', error.message)
    }
}

/* ────────────────────────── 日志流 ────────────────────────── */

function openFeed() {
    if (state.feedStream) return
    const stream = new EventSource('/api/events')
    state.feedStream = stream
    stream.addEventListener('job', event => {
        try {
            const job = JSON.parse(event.data)
            if (job) mergeJobIntoFeed(job)
        } catch {}
    })
}

function closeFeed() {
    if (state.feedStream) {
        state.feedStream.close()
        state.feedStream = null
    }
}

function mergeJobIntoFeed(job) {
    const tag = job.email.split('@')[0]
    state.feed = state.feed.filter(entry => entry.email !== job.email)
    for (const line of job.log || []) state.feed.push({ email: job.email, tag, ...line })
    if (state.feed.length > 500) state.feed.splice(0, state.feed.length - 500)
    renderFeed()
}

function renderFeed() {
    const view = $('#log-view')
    const filtered = state.logFilter === 'all' ? state.feed : state.feed.filter(line => line.level === state.logFilter)
    $('#logs-hint').textContent = state.feed.length
        ? `共 ${state.feed.length} 行 · 仅显示账号登录/授权窗口输出，与上方签到任务日志无关`
        : '仅显示账号登录/授权窗口输出，与上方签到任务日志无关'

    if (!filtered.length) {
        view.innerHTML = '<div class="log-empty">暂无日志。发起一次账号授权后，这里会实时滚动显示输出。</div>'
        return
    }

    view.innerHTML = filtered
        .map(
            line => `<div class="log-line" data-level="${line.level}">
                <span class="log-line__time">${line.t ? timeOf(line.t) : ''}</span>
                <span class="log-line__level">${line.level}</span>
                <span class="log-line__msg"><span style="opacity:.5">${escapeHtml(line.tag)}</span> ${escapeHtml(line.text)}</span>
            </div>`
        )
        .join('')

    if ($('#log-autoscroll').checked) view.scrollTop = view.scrollHeight
}

/* ────────────────────────── 签到（Control API） ────────────────────────── */

async function runAccount(index) {
    return runConsole.start(index)
}

/* ────────────────────────── 主题 ────────────────────────── */

function applyTheme(theme, persist = true) {
    const resolved = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.dataset.theme = resolved
    const label = $('#theme-label')
    if (label) label.textContent = resolved === 'dark' ? '浅色外观' : '深色外观'
    if (persist) {
        try {
            localStorage.setItem(LS.theme, resolved)
            localStorage.setItem('rwd.theme', resolved)
        } catch {}
    }
}

function selectSettingsTab(name) {
    const target = ['strategy', 'push', 'system'].includes(name) ? name : 'strategy'
    for (const tab of $$('#settings-tabs .seg__item')) {
        const active = tab.dataset.settingsTab === target
        tab.classList.toggle('is-active', active)
        tab.setAttribute('aria-selected', String(active))
        tab.tabIndex = active ? 0 : -1
    }
    for (const pane of ['strategy', 'push', 'system']) {
        const el = $(`#settings-pane-${pane}`)
        if (el) el.hidden = pane !== target
    }
}

/* ────────────────────────── 事件 ────────────────────────── */

function bindEvents() {
    const closeEditor = () => {
        $('#account-editor').classList.remove('is-open')
        resetForm()
    }
    const openEditor = () => {
        resetForm()
        $('.advanced').open = false
        $('#account-editor').classList.add('is-open')
        $('#btn-close-form').hidden = false
        requestAnimationFrame(() => $('#f-email').focus({ preventScroll: true }))
    }
    $('#btn-add-account').addEventListener('click', event => {
        event.preventDefault()
        openEditor()
    })
    $('#btn-empty-add')?.addEventListener('click', openEditor)
    $('#btn-close-form').addEventListener('click', closeEditor)
    $('.form-backdrop')?.addEventListener('click', event => {
        if (event.target === event.currentTarget && $('#account-editor').classList.contains('is-open')) closeEditor()
    })
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('#account-editor').classList.contains('is-open')) closeEditor()
    })
    $('#unlock-form').addEventListener('submit', handleUnlock)
    $('#btn-reveal-token').addEventListener('click', event => {
        const input = $('#unlock-token')
        const show = input.type === 'password'
        input.type = show ? 'text' : 'password'
        event.currentTarget.textContent = show ? '隐藏' : '显示'
    })

    $('#btn-setup-detect').addEventListener('click', () => detectInstance(false))
    $('#btn-setup-connect').addEventListener('click', handleConnect)

    for (const trigger of $$('[data-dialog]')) {
        trigger.addEventListener('click', () => $(`#${trigger.dataset.dialog}`).showModal())
    }
    for (const closer of $$('[data-close-dialog]')) {
        closer.addEventListener('click', () => closer.closest('dialog').close())
    }
    for (const dialog of $$('dialog.dialog')) {
        dialog.addEventListener('click', event => {
            if (event.target === dialog) {
                if (dialog.id === 'dlg-login' && state.jobRunning) return
                dialog.close()
            }
        })
    }
    for (const button of $$('[data-reveal]')) {
        button.addEventListener('click', () => {
            const input = $(`#${button.dataset.reveal}`)
            const show = input.type === 'password'
            input.type = show ? 'text' : 'password'
            button.textContent = show ? '隐藏' : '显示'
        })
    }

    $('#tabs').addEventListener('click', event => {
        const tab = event.target.closest('.tab')
        if (!tab) return
        for (const other of $$('.tab')) {
            other.classList.toggle('is-active', other === tab)
            other.setAttribute('aria-selected', String(other === tab))
            other.tabIndex = other === tab ? 0 : -1
        }
        const active = tab.dataset.tab
        $('#panel-dashboard').hidden = active !== 'dashboard'
        if (active === 'dashboard') dashboard.open(); else dashboard.stop()
        $('#panel-accounts').hidden = active !== 'accounts'
        $('#panel-logs').hidden = active !== 'logs'
        $('#panel-settings').hidden = active !== 'settings'
        if (active === 'logs') {
            activityPanel.open()
            openFeed()
            renderFeed()
        } else activityPanel.stop()
        if (active === 'settings') { refreshState(); taskSettings.load(); notifications.load() }
    })
    for (const tab of $$('#tabs .tab')) {
        tab.id = `tab-${tab.dataset.tab}`
        tab.setAttribute('aria-controls', `panel-${tab.dataset.tab}`)
        tab.tabIndex = tab.classList.contains('is-active') ? 0 : -1
        const panel = $(`#panel-${tab.dataset.tab}`)
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id)
    }
    $('#tabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = $$('#tabs .tab'), i = tabs.indexOf(document.activeElement)
        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (forward ? 1 : -1) + tabs.length) % tabs.length
        tabs[next].focus(); tabs[next].click()
    })

    for (const button of [$('#btn-theme'), $('#btn-entry-theme')]) {
        button.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'))
    }

    $('#btn-logout').addEventListener('click', async () => {
        try {
            await api('/api/auth/logout', { method: 'POST' })
        } catch {}
        closeFeed()
        closeJobStream()
        state.botDir = ''
        state.accounts = null
        state.authenticated = false
        showUnlock()
        toast('info', '已退出登录')
    })

    $('#btn-refresh').addEventListener('click', () => {
        refreshAccounts()
        refreshRuns()
        runConsole.refresh(true)
    })

    $('#account-list').addEventListener('click', async event => {
        const button = event.target.closest('[data-act]')
        if (!button) return
        const item = button.closest('.account-item')
        const index = Number(item.dataset.index)
        const account = state.accounts?.accounts.find(a => a.index === index)
        if (!account) return

        if (button.dataset.act === 'authorize') return openLoginDialog(account)
        if (button.dataset.act === 'run') return runAccount(index)
        if (button.dataset.act === 'edit') {
            button.closest('details')?.removeAttribute('open')
            fillForm(account)
            $('#account-editor').classList.add('is-open')
            $('#btn-close-form').hidden = false
            $('#f-email').focus()
            return
        }
        if (button.dataset.act === 'delete') {
            button.closest('details')?.removeAttribute('open')
            const ok = await confirmDialog({
                title: `删除 ACCOUNT_${index}？`,
                message: `移除 ${account.email} 的配置（保留已保存的登录会话）。`,
                confirmText: '删除',
                danger: true
            })
            if (!ok) return
            try {
                const payload = await api(`/api/accounts/${index}`, { method: 'DELETE' })
                applyAccounts(payload)
                refreshRuns()
                if (state.editingIndex === index) resetForm()
                toast('success', '账号已删除')
            } catch (error) {
                if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
                toast('error', error.message)
            }
        }
    })

    $('#account-form').addEventListener('submit', handleSaveAccount)
    $('#btn-reset').addEventListener('click', () => {
        if (state.editingIndex != null) {
            const existing = state.accounts?.accounts?.find(a => a.index === state.editingIndex)
            if (existing) { fillForm(existing); return }
        }
        resetForm()
    })
    for (const [inputSel, boxSel] of [
        ['#f-password', '#f-remove-password'],
        ['#f-totp', '#f-remove-totp'],
        ['#f-recovery', '#f-remove-recovery']
    ]) {
        $(inputSel)?.addEventListener('input', () => { if ($(inputSel).value) $(boxSel).checked = false })
        $(boxSel)?.addEventListener('change', () => { if ($(boxSel).checked) $(inputSel).value = '' })
    }
    for (const sel of ['#f-proxy-url', '#f-proxy-port', '#f-proxy-user', '#f-proxy-pass']) {
        $(sel)?.addEventListener('input', () => { if ($(sel).value.trim()) $('#f-remove-proxy').checked = false })
    }
    $('#f-remove-proxy')?.addEventListener('change', () => {
        if ($('#f-remove-proxy').checked) {
            for (const sel of ['#f-proxy-url', '#f-proxy-port', '#f-proxy-user', '#f-proxy-pass']) $(sel).value = ''
        }
    })

    $('#btn-recheck').addEventListener('click', async () => {
        const dir = $('#s-botdir').value.trim()
        if (!dir) return toast('error', '请填写实例路径')
        try {
            const check = await api(`/api/preflight?botDir=${encodeURIComponent(dir)}`)
            renderChecks($('#settings-checks'), check.checks || [])
            toast(check.ready ? 'success' : 'error', check.ready ? '环境已就绪' : `缺少：${check.blocking.join('、')}`)
        } catch (error) {
            toast('error', error.message)
        }
    })

    $('#btn-save-bot').addEventListener('click', async () => {
        const dir = $('#s-botdir').value.trim()
        if (!dir) return toast('error', '实例路径不能为空')
        try {
            const result = await api('/api/config', { method: 'PUT', body: { botDir: dir } })
            state.botDir = result.botDir
            applyAccounts(result.accounts)
            showApp()
            await refreshState()
            await refreshAccounts()
            await refreshRuns()
            toast('success', '实例路径已保存')
        } catch (error) {
            toast('error', error.message)
        }
    })

    $('#s-control-token').addEventListener('input', () => {
        if ($('#s-control-token').value.trim()) $('#s-control-token-clear').checked = false
    })

    $('#s-control-token-clear').addEventListener('change', () => {
        if ($('#s-control-token-clear').checked) $('#s-control-token').value = ''
    })

    $('#btn-save-control').addEventListener('click', async () => {
        try {
            const body = { controlApi: $('#s-control-api').value.trim() }
            const token = $('#s-control-token').value.trim()
            if ($('#s-control-token-clear').checked) body.clearControlToken = true
            else if (token) body.controlToken = token
            const result = await api('/api/config', { method: 'PUT', body })
            state.control = result.control
            $('#s-control-token').value = ''
            $('#s-control-token-clear').checked = false
            await refreshState()
            runConsole.refresh(true)
            const status = result.control?.status
            if (status === 'online') toast('success', '签到接口已连通')
            else if (status === 'unconfigured') toast('info', '已清除签到接口配置')
            else toast('error', `签到接口${status === 'unauthorized' ? '令牌无效' : '不可用'}`)
        } catch (error) {
            toast('error', error.message)
        }
    })

    const savePanelPassword = async () => {
        const value = $('#s-panel-token').value.trim()
        if (value.length < 8) return toast('error', '新密码至少 8 位')
        try {
            const res = await api('/api/auth/password', { method: 'POST', body: { token: value } })
            $('#s-panel-token').value = ''
            if (res.envManaged) {
                toast('info', '密码已临时更新；当前部署配置了 PANEL_TOKEN 环境变量，重启容器后会恢复为环境变量值', 6500)
            } else {
                toast('success', '面板访问密码已更新，其他设备需重新登录')
            }
        } catch (error) {
            toast('error', error.message)
        }
    }
    $('#s-panel-token').addEventListener('keydown', event => {
        if (event.key === 'Enter') void savePanelPassword()
    })
    $('#btn-save-password')?.addEventListener('click', savePanelPassword)

    $('#btn-start-login').addEventListener('click', handleStartLogin)
    $('#btn-reauth-login')?.addEventListener('click', handleStartLogin)
    $('#btn-stop-login').addEventListener('click', handleStopLogin)
    $('#btn-login-done')?.addEventListener('click', () => $('#dlg-login').close())
    $('#btn-login-close')?.addEventListener('click', () => $('#dlg-login').close())
    $('#btn-login-run-now')?.addEventListener('click', () => {
        const account = state.accounts?.accounts?.find(a => a.email === state.jobEmail)
        $('#dlg-login').close()
        if (account) void runAccount(account.index)
    })
    $('#dlg-login').addEventListener('close', () => {
        const wasRunning = state.jobRunning
        closeJobStream()
        state.jobEmail = null
        state.jobRunning = false
        setLoginInputsLocked(false)
        if (wasRunning) {
            toast('info', '远程授权仍在后台运行，可随时从账号页回到授权窗口或终止', 5000)
            runConsole.refresh(true)
        }
    })
    $('#platform-picker').addEventListener('change', syncPlatformPicker)

    $('#settings-tabs')?.addEventListener('click', event => {
        const tab = event.target.closest('.seg__item[data-settings-tab]')
        if (!tab) return
        selectSettingsTab(tab.dataset.settingsTab)
    })
    for (const tab of $$('#settings-tabs .seg__item[data-settings-tab]')) {
        tab.id = `settings-tab-${tab.dataset.settingsTab}`
        tab.setAttribute('aria-controls', `settings-pane-${tab.dataset.settingsTab}`)
        tab.tabIndex = tab.classList.contains('is-active') ? 0 : -1
        const pane = $(`#settings-pane-${tab.dataset.settingsTab}`)
        if (pane) {
            pane.setAttribute('role', 'tabpanel')
            pane.setAttribute('aria-labelledby', tab.id)
        }
    }
    $('#settings-tabs')?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = $$('#settings-tabs .seg__item[data-settings-tab]')
        const i = tabs.indexOf(document.activeElement)
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[next].focus()
        selectSettingsTab(tabs[next].dataset.settingsTab)
    })

    $('#dash-open-settings')?.addEventListener('click', () => {
        selectSettingsTab('strategy')
        $('#tabs [data-tab="settings"]').click()
    })
    for (const pill of [$('#pill-env'), $('#pill-api')]) {
        pill?.addEventListener('click', () => {
            selectSettingsTab('system')
            $('#tabs [data-tab="settings"]').click()
        })
    }

    $('#log-filter').addEventListener('click', event => {
        const item = event.target.closest('.seg__item')
        if (!item) return
        state.logFilter = item.dataset.level
        for (const other of $$('#log-filter .seg__item')) other.classList.toggle('is-active', other === item)
        renderFeed()
    })
    $('#btn-clear-logs').addEventListener('click', () => {
        state.feed = []
        renderFeed()
    })
}

/* ────────────────────────── 启动 ────────────────────────── */

async function bootAfterAuth() {
    const info = await api('/api/state')
    state.botDir = info.botDir || ''
    state.control = info.control

    if (!state.botDir) {
        if (!info.authRequired && !state.botDir) {
            // 未开启鉴权且未连接实例
        }
        showSetup()
        return
    }

    const preflight = await api('/api/preflight').catch(() => null)
    const payload = await api('/api/accounts').catch(() => null)
    applyAccounts(payload)
    showApp()
    await refreshState()
    await refreshRuns()
    openFeed()

    if (preflight && !preflight.ready) {
        toast('info', `环境未就绪：${preflight.blocking.join('、')}。账号授权可能无法启动。`, 6000)
    }
}

async function boot() {
    applyTheme(localStorage.getItem(LS.theme) || 'light', false)
    bindEvents()

    try {
        const auth = await api('/api/auth/state')
        state.authRequired = auth.authRequired
        state.authenticated = auth.authenticated

        if (auth.authRequired && !auth.authenticated) {
            $('#unlock-hint').hidden = false
            return showUnlock()
        }

        $('#unlock-hint').hidden = true
        await bootAfterAuth()
    } catch (error) {
        showUnlock(`无法连接面板服务：${error.message}`)
    }
}

boot()
