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

const LS = { theme: 'rwd.theme' }

const state = {
    authRequired: true,
    authenticated: false,
    botDir: '',
    control: null,
    accounts: null,
    nextIndex: 1,
    editingIndex: null,
    jobEmail: null,
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
const runConsole = createRunConsole({ api, escapeHtml,
    onUnauthorized: () => showUnlock('会话已过期，请重新输入访问密码'),
    onStart: index => { activityPanel.today(); toast('success', index == null ? '已提交全部账号签到，运行进度会自动更新' : '已提交该账号签到，运行进度会自动更新') },
    onAction: (action, email, info) => {
        if (action === 'logs') { if (info?.latest) activityPanel.selectRun(info.latest.run); else activityPanel.today(); $('#tabs [data-tab="logs"]').click(); return }
        if (action === 'settings') { $('#tabs [data-tab="settings"]').click(); return }
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
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('请求超时，请刷新状态确认结果后重试')
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
                    <button class="primary-btn primary-btn--full" data-act="ok" style="min-width:120px"><span class="primary-btn__text">${escapeHtml(confirmText)}</span></button>
                </footer>
            </div>`
        if (danger) $('[data-act="ok"]', dialog).style.background = 'var(--danger)'
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
    $('#topbar-path').textContent = '中国大陆 · 签到工作台'
    $('#topbar-path').title = state.botDir
    $('#appfoot-path').textContent = '配置、会话与运行记录保存在实例数据目录'
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
    $('.primary-btn__text', button).textContent = '验证中…'

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
        $('.primary-btn__text', button).textContent = '进入控制台'
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
    $('.primary-btn__text', button).textContent = '检查中…'

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
        $('.primary-btn__text', button).textContent = '检查并连接'
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

        $('#s-auth-note').textContent = info.authRequired
            ? '已启用访问密码；修改后需重新登录。'
            : '⚠ 已用 PANEL_NO_AUTH 关闭鉴权，任何能访问本端口的人都能读写账号配置。'
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
    state.nextIndex = payload.nextIndex || 1
    renderAccounts()
    runConsole.render()
    runConsole.refresh()
    const hint = $('#accounts-hint')
    const sessions = payload.sessions || {}
    hint.textContent = payload.envExists
        ? `${payload.accounts?.length || 0} 个账号 · 登录信息保存在本机`
        : '添加第一个账号，开始连接'
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

function sessionPhrase(label, session) {
    if (!session) return `${label}未连接`
    return `${label}已保存 · ${ago(session.updatedAt)}`
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
            const summary = [sessionPhrase('手机', account.sessions?.mobile), sessionPhrase('电脑', account.sessions?.desktop)].join(' · ')
            const connected = Boolean(account.sessions?.mobile || account.sessions?.desktop)
            const extra = [
                account.hasPassword ? '已保存密码' : '',
                account.hasTotp ? '双重验证' : '',
                account.hasProxy ? '使用代理' : ''
            ].filter(Boolean)

            return `<li class="account-item" data-index="${account.index}" data-email="${escapeHtml(account.email)}">
                <span class="avatar" aria-hidden="true">${escapeHtml((account.email || '?').slice(0, 1))}</span>
                <div class="account-item__main">
                    <div class="account-item__email" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</div>
                    <p class="account-item__summary">${escapeHtml(summary)}</p>
                    ${extra.length ? `<p class="account-item__extra">${extra.map(escapeHtml).join(' · ')}</p>` : ''}
                </div>
                <div class="account-item__actions">
                    <button class="mini-btn" data-act="run">运行此账号</button>
                    <button class="mini-btn" data-act="authorize">${connected ? '重新登录' : '登录账号'}</button>
                    <details class="more">
                        <summary>更多</summary>
                        <div class="more__menu">
                            <button type="button" data-act="edit">编辑</button>
                            <button type="button" data-act="delete">删除</button>
                        </div>
                    </details>
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
        list.innerHTML = '<li class="run-list__empty">还没有最近活动。完成一次账号授权后，结果会显示在这里。</li>'
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
        ? '留空的密码和验证器密钥会保持原样。'
        : '填写邮箱后，登录一次以保存会话。'
    $('#btn-save .primary-btn__text').textContent = account ? '保存修改' : '保存账号'
    $('#btn-close-form').hidden = !account && !(state.accounts?.accounts?.length)
}

function fillForm(account) {
    if (!account) return resetForm()
    $('#f-email').value = account.email
    $('#f-password').value = ''
    $('#f-password').placeholder = account.hasPassword ? '留空则保持原密码' : '密码登录时必填'
    $('#f-totp').value = ''
    $('#f-totp').placeholder = account.hasTotp ? '已保存，留空则不修改' : 'JBSWY3DPEHPK3PXP'
    $('#f-recovery').value = ''
    $('#f-recovery').placeholder = account.hasRecovery ? '已保存，留空则不修改' : 'recovery@example.com'
    $('#f-geo').value = account.geoLocale || 'auto'
    $('#f-lang').value = account.langCode || 'zh-CN'
    $('#f-proxy-url').value = ''
    $('#f-proxy-port').value = ''
    $('#f-proxy-user').value = ''
    $('#f-proxy-pass').value = ''
    $('#f-fp-mobile').checked = Boolean(account.saveFingerprint?.mobile)
    $('#f-fp-desktop').checked = Boolean(account.saveFingerprint?.desktop)
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
    $('#f-fp-mobile').checked = true
    $('#f-fp-desktop').checked = true
    $('#form-error').hidden = true
    setFormMode(null)
}

async function handleSaveAccount(event) {
    event.preventDefault()
    const button = $('#btn-save')
    const errorEl = $('#form-error')

    const body = {
        index: state.editingIndex || state.nextIndex,
        saveFingerprintMobile: $('#f-fp-mobile').checked,
        saveFingerprintDesktop: $('#f-fp-desktop').checked
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
    $('.primary-btn__text', button).textContent = '保存中…'

    try {
        const payload = await api('/api/accounts', { method: 'POST', body })
        applyAccounts(payload)
        resetForm()
        $('#account-editor').classList.remove('is-open')
        toast('success', `账号已保存，可以点「连接」完成登录`)
    } catch (error) {
        if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
        errorEl.textContent = error.message
        errorEl.hidden = false
    } finally {
        button.disabled = false
        $('.primary-btn__text', button).textContent = state.editingIndex ? '保存修改' : '保存账号'
    }
}

/* ────────────────────────── 授权弹窗 ────────────────────────── */

function openLoginDialog(account) {
    for (const chip of $$('#platform-picker .radio-chip')) {
        const input = $('input', chip)
        input.checked = input.value === 'both'
        chip.classList.toggle('is-active', input.checked)
    }
    state.jobEmail = account.email
    $('#dlg-login-title').textContent = `微软账号授权 · ACCOUNT_${account.index}`
    $('#dlg-login-sub').textContent = account.email
    $('#job-log').innerHTML = '<div class="log-empty">启动后这里会实时显示上游脚本的输出。</div>'
    $('#job-status').dataset.state = 'idle'
    $('.job-status__text').textContent = '等待开始'
    $('#job-time').textContent = ''
    $('#job-hint').hidden = true
    $('#remote-browser').hidden = true
    $('#verify-list').hidden = true
    $('#btn-stop-login').hidden = true
    $('#btn-start-login').disabled = false
    $('.primary-btn__text', $('#btn-start-login')).textContent = '启动浏览器授权'
    $('#dlg-login').showModal()

    // 已有任务则接管显示
    api(`/api/login/job?email=${encodeURIComponent(account.email)}`)
        .then(({ job }) => {
            if (!job) return
            renderJob(job)
            if (job.state === 'running') connectJobStream(account.email)
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
        textEl.textContent = `${job.desktopUrl ? '等待你在远程窗口登录' : '运行中'} · ${platformText}${job.fresh ? ' · 全新授权' : ''}`
        $('#job-time').textContent = `开始于 ${timeOf(job.startedAt)}`
        $('#btn-stop-login').hidden = false
        $('#btn-start-login').disabled = true
        $('.primary-btn__text', $('#btn-start-login')).textContent = job.desktopUrl ? '等待完成登录' : '运行中…'
    } else if (job.state === 'done' || job.state === 'partial') {
        textEl.textContent = job.state === 'done' ? `授权完成 · 会话已写入 ${platformText}` : `只完成 ${job.verification?.saved.join('、') || '部分平台'}`
        $('#job-time').textContent = timeOf(job.endedAt)
        $('#btn-stop-login').hidden = true
        $('#btn-start-login').disabled = false
        $('.primary-btn__text', $('#btn-start-login')).textContent = '再次授权'
        closeJobStream()
        refreshAccounts()
        refreshRuns()
    } else if (job.state === 'failed' || job.state === 'cancelled') {
        textEl.textContent =
            job.state === 'cancelled'
                ? '已终止，未写入新会话'
                : job.exitCode === 0
                  ? '进程结束，但会话未写入（未判定为成功）'
                  : `运行失败（退出码 ${job.exitCode ?? '—'}）`
        $('#job-time').textContent = timeOf(job.endedAt)
        $('#btn-stop-login').hidden = true
        $('#btn-start-login').disabled = false
        $('.primary-btn__text', $('#btn-start-login')).textContent = '重试'
        closeJobStream()
        refreshRuns()
    }

    renderJobLog(job.log || [])
}

function renderJobLog(lines) {
    const view = $('#job-log')
    if (!lines.length) {
        view.innerHTML = '<div class="log-empty">启动后这里会实时显示上游脚本的输出。</div>'
        return
    }
    view.innerHTML = lines
        .map(
            line => `<div class="log-line" data-level="${line.level}">
                <span class="log-line__time">${line.t ? timeOf(line.t) : ''}</span>
                <span class="log-line__level">${line.level}</span>
                <span class="log-line__msg">${escapeHtml(line.text)}</span>
            </div>`
        )
        .join('')
    view.scrollTop = view.scrollHeight
}

async function handleStartLogin() {
    if (!state.jobEmail) return
    const platform = $('input[name="platform"]:checked')?.value || 'both'
    const fresh = $('#opt-fresh').checked
    const button = $('#btn-start-login')
    button.disabled = true

    try {
        $('#job-log').innerHTML = ''
        $('#job-hint').hidden = true
        const { job } = await api('/api/login/start', {
            method: 'POST',
            body: { email: state.jobEmail, platform, fresh }
        })
        renderJob(job)
        connectJobStream(state.jobEmail)
        toast('info', '授权已启动，请按页面提示完成微软登录')
    } catch (error) {
        if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
        toast('error', error.message)
        button.disabled = false
    }
}

async function handleStopLogin() {
    if (!state.jobEmail) return
    try {
        await api('/api/login/stop', { method: 'POST', body: { email: state.jobEmail } })
        toast('info', '已请求终止，任务将被标记为“已终止”')
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
    $('#logs-hint').textContent = `共 ${state.feed.length} 行 · 仅显示微软账号授权过程`

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

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(LS.theme, theme)
}

/* ────────────────────────── 事件 ────────────────────────── */

function bindEvents() {
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
    $('#btn-close-form').addEventListener('click', () => {
        $('#account-editor').classList.remove('is-open')
        resetForm()
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
            if (event.target === dialog) dialog.close()
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

    $('#dash-manage-accounts').addEventListener('click', () => $('#tabs [data-tab="accounts"]').click())
    $('#dash-problems').addEventListener('click', () => { activityPanel.today(); $('#tabs [data-tab="logs"]').click() })

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
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = $$('#tabs .tab'), i = tabs.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
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
        localStorage.clear()
        state.botDir = ''
        state.accounts = null
        state.authenticated = false
        showUnlock()
        toast('info', '已退出，连接信息已从本机浏览器清除')
    })

    $('#btn-refresh').addEventListener('click', () => {
        refreshAccounts()
        refreshRuns()
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
                message: `将从 .env 移除 ${account.email} 的配置行（先备份为 .env.panel.bak）。已保存的会话不会删除。`,
                confirmText: '删除',
                danger: true
            })
            if (!ok) return
            try {
                const payload = await api(`/api/accounts/${index}`, { method: 'DELETE' })
                applyAccounts(payload)
                if (state.editingIndex === index) resetForm()
                toast('success', '账号已删除')
            } catch (error) {
                if (error.status === 401) return showUnlock('会话已过期，请重新输入访问密码')
                toast('error', error.message)
            }
        }
    })

    $('#account-form').addEventListener('submit', handleSaveAccount)
    $('#btn-reset').addEventListener('click', resetForm)

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

    $('#btn-save-control').addEventListener('click', async () => {
        try {
            const result = await api('/api/config', {
                method: 'PUT',
                body: { controlApi: $('#s-control-api').value.trim(), controlToken: $('#s-control-token').value.trim() }
            })
            state.control = result.control
            $('#s-control-token').value = ''
            await refreshState()
            const status = result.control?.status
            toast(status === 'online' ? 'success' : 'error', status === 'online' ? '签到接口已连通' : `签到接口${status === 'unauthorized' ? '令牌无效' : '不可用'}`)
        } catch (error) {
            toast('error', error.message)
        }
    })

    $('#s-panel-token').addEventListener('keydown', async event => {
        if (event.key !== 'Enter') return
        const value = $('#s-panel-token').value.trim()
        if (value.length < 8) return toast('error', '新密码至少 8 位，保存后重启仍然有效')
        try {
            await api('/api/auth/password', { method: 'POST', body: { token: value } })
            $('#s-panel-token').value = ''
            toast('success', '面板访问密码已更新')
        } catch (error) {
            toast('error', error.message)
        }
    })

    $('#btn-start-login').addEventListener('click', handleStartLogin)
    $('#btn-stop-login').addEventListener('click', handleStopLogin)
    $('#dlg-login').addEventListener('close', () => {
        closeJobStream()
        state.jobEmail = null
    })
    for (const chip of $$('.radio-chip')) {
        chip.addEventListener('click', () => {
            setTimeout(() => {
                for (const other of $$('.radio-chip')) other.classList.toggle('is-active', $('input', other).checked)
            }, 0)
        })
    }

    $('#log-filter').addEventListener('click', event => {
        const item = event.target.closest('.seg__item')
        if (!item) return
        state.logFilter = item.dataset.level
        for (const other of $$('.seg__item')) other.classList.toggle('is-active', other === item)
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
    applyTheme(localStorage.getItem(LS.theme) || 'light')
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
