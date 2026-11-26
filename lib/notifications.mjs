import fs from 'node:fs'
import path from 'node:path'

const fileFor = panelFile => path.join(path.dirname(panelFile), 'notifications.json')
const PROVIDERS = ['pushplus', 'serverchan', 'bark']
const DEFAULT_CONFIG = { provider: 'pushplus', enabled: false, onlyProblems: false, token: '', server: '' }

const STATE_META = {
    completed: { label: '已完成', headline: '本轮签到已完成', accent: '#059669', soft: '#ecfdf5', border: '#a7f3d0', icon: '✓', urgent: false },
    partial: { label: '部分完成', headline: '本轮签到部分完成', accent: '#d97706', soft: '#fffbeb', border: '#fde68a', icon: '!', urgent: true },
    failed: { label: '运行失败', headline: '本轮签到运行失败', accent: '#dc2626', soft: '#fef2f2', border: '#fecaca', icon: '✕', urgent: true },
    interrupted: { label: '运行中断', headline: '本轮签到运行中断', accent: '#dc2626', soft: '#fef2f2', border: '#fecaca', icon: '!', urgent: true },
    cancelled: { label: '已停止', headline: '本轮签到已手动停止', accent: '#475569', soft: '#f1f5f9', border: '#cbd5e1', icon: '■', urgent: false }
}

const escHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const escMd = value => String(value ?? '').replace(/[|\\`*_{}[\]()#+\-.!]/g, ch => `\\${ch}`)
const fmtNum = value => Number(value).toLocaleString('en-US')

// 摘要保留账号可辨识度（隐藏邮箱主体，不泄露完整地址、原始日志、Cookie 或登录码）
export function maskAccountLabel(account, index = 0) {
    if (!account || typeof account !== 'object') return `账号 ${index + 1}`
    const text = String(account.email || '').trim()
    if (!text) return `账号 ${index + 1}`
    const at = text.lastIndexOf('@')
    if (at <= 0) return `${text.slice(0, Math.min(2, text.length))}***`
    const local = text.slice(0, at)
    const keep = local.length <= 2 ? 1 : 3
    return `${local.slice(0, keep)}***${text.slice(at)}`
}

function formatDuration(startedAt, endedAt) {
    const start = Number(startedAt), end = Number(endedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    const totalSec = Math.floor((end - start) / 1000)
    const min = Math.floor(totalSec / 60), sec = totalSec % 60
    return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`
}

function summarizeRun(run, { test = false } = {}) {
    const meta = STATE_META[run?.state] || { label: '已结束', headline: '本轮签到已结束', accent: '#2563eb', soft: '#eff6ff', border: '#bfdbfe', icon: '•', urgent: false }
    const day = String(run?.day || new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Shanghai' }).format(Date.now()))
    const duration = formatDuration(run?.startedAt, run?.endedAt)
    const rawAccounts = Array.isArray(run?.accounts) ? run.accounts : []
    const accounts = rawAccounts.map((item, idx) => {
        const obj = item && typeof item === 'object' ? item : {}
        const gained = Number.isFinite(obj.collectedPoints) ? obj.collectedPoints : null
        const balance = Number.isFinite(obj.finalPoints) ? obj.finalPoints : null
        const failed = obj.success === false || Boolean(obj.error)
        const ok = obj.success === true && !obj.error
        const status = failed ? 'fail' : ok ? 'ok' : gained != null ? 'ok' : 'pending'
        const statusText = failed ? '待排查' : ok ? '正常' : gained != null ? '已记分' : '待确认'
        const gainedText = gained != null ? (gained > 0 ? `+${fmtNum(gained)} 分` : '0 分') : failed ? '未得分' : '待确认'
        return {
            index: idx + 1,
            label: maskAccountLabel(item, idx),
            status,
            statusText,
            gained,
            gainedText,
            balance,
            balanceText: balance != null ? fmtNum(balance) : '—'
        }
    })
    const points = Number.isFinite(run?.points) ? run.points : null
    const pointsText = points == null ? '待确认' : points > 0 ? `+${fmtNum(points)} 分` : `${fmtNum(points)} 分`
    const pointsShort = points == null ? '积分待确认' : points > 0 ? `+${fmtNum(points)} 分` : `${fmtNum(points)} 分`
    const balances = accounts.filter(a => a.balance != null)
    const totalBalance = balances.length ? balances.reduce((sum, a) => sum + a.balance, 0) : null
    const failCount = accounts.filter(a => a.status === 'fail').length
    const okCount = accounts.filter(a => a.status === 'ok').length
    const taskSummary = run?.taskSummary && typeof run.taskSummary === 'object' ? run.taskSummary : null
    const titlePrefix = test ? '【测试推送】' : ''
    const title = `${titlePrefix}Rewards 签到${meta.label}`
    return {
        test,
        meta,
        title,
        day,
        duration,
        points,
        pointsText,
        pointsShort,
        accounts,
        accountCount: accounts.length,
        okCount,
        failCount,
        totalBalance,
        totalBalanceText: totalBalance != null ? fmtNum(totalBalance) : '—',
        taskSummary
    }
}

function renderPushPlusHtml(s) {
    const kpiThirdLabel = s.totalBalance != null ? '汇总余额' : '本轮耗时'
    const kpiThirdValue = s.totalBalance != null ? s.totalBalanceText : (s.duration || '—')
    const accountSummary = s.accountCount
        ? (s.failCount ? `${s.failCount} 异常 / ${s.accountCount}` : `${s.accountCount} 个账号`)
        : '0 个账号'

    const taskBar = s.taskSummary && s.taskSummary.total > 0
        ? `<div style="margin:0 18px 14px;padding:9px 12px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;font-size:12px;color:#475569;">
            任务汇总：已完成 <strong style="color:#059669;">${s.taskSummary.completed || 0}</strong>　·　已跳过 <strong>${s.taskSummary.skipped || 0}</strong>　·　待关注 <strong style="color:${s.taskSummary.attention ? '#dc2626' : '#0f172a'};">${s.taskSummary.attention || 0}</strong>
           </div>`
        : ''

    const accountRows = s.accounts.length
        ? s.accounts.map((acc, idx) => {
            const dotColor = acc.status === 'fail' ? '#dc2626' : acc.status === 'ok' ? '#059669' : '#94a3b8'
            const pillBg = acc.status === 'fail' ? '#fef2f2' : acc.gained > 0 ? '#eff6ff' : '#f1f5f9'
            const pillFg = acc.status === 'fail' ? '#dc2626' : acc.gained > 0 ? '#2563eb' : '#475569'
            const borderTop = idx === 0 ? '' : 'border-top:1px solid #f1f5f9;'
            return `<tr>
                <td style="padding:10px 0;${borderTop}vertical-align:middle;">
                    <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dotColor};margin-right:8px;vertical-align:middle;"></span>
                    <span style="font-family:ui-monospace,Consolas,monospace;font-size:13px;font-weight:600;color:#0f172a;vertical-align:middle;">${escHtml(acc.label)}</span>
                    ${acc.status === 'fail' ? '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:#fef2f2;color:#dc2626;font-size:10px;font-weight:600;vertical-align:middle;">待排查</span>' : ''}
                </td>
                <td style="padding:10px 0;${borderTop}text-align:right;vertical-align:middle;white-space:nowrap;">
                    <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${pillBg};color:${pillFg};font-size:12px;font-weight:700;">${escHtml(acc.gainedText)}</span>
                    ${acc.balance != null ? `<div style="margin-top:3px;font-size:11px;color:#64748b;">余额 ${escHtml(acc.balanceText)}</div>` : ''}
                </td>
            </tr>`
        }).join('')
        : '<tr><td colspan="2" style="padding:14px 0;text-align:center;font-size:12px;color:#64748b;">本轮暂无逐账号明细上报</td></tr>'

    return `<div style="max-width:560px;margin:0 auto;padding:12px;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#0f172a;line-height:1.5;">
        <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
            <div style="height:4px;background:${s.meta.accent};"></div>
            <div style="padding:18px 18px 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                    <tr>
                        <td style="vertical-align:top;">
                            <div style="font-size:10px;font-weight:700;letter-spacing:1.2px;color:#64748b;margin-bottom:4px;">${s.test ? 'TEST PUSH · ' : ''}REWARDS CONSOLE</div>
                            <div style="font-size:18px;font-weight:700;color:#0f172a;">${escHtml(s.meta.headline)}</div>
                            <div style="font-size:12px;color:#64748b;margin-top:4px;">${escHtml(s.day)}${s.duration ? `　·　耗时 ${escHtml(s.duration)}` : ''}</div>
                        </td>
                        <td style="vertical-align:top;text-align:right;white-space:nowrap;">
                            <span style="display:inline-block;padding:4px 11px;border-radius:999px;background:${s.meta.soft};border:1px solid ${s.meta.border};color:${s.meta.accent};font-size:12px;font-weight:700;">${escHtml(s.meta.icon)} ${escHtml(s.meta.label)}</span>
                        </td>
                    </tr>
                </table>
            </div>
            <div style="padding:0 18px 14px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                    <tr>
                        <td width="34%" style="padding:12px 10px;text-align:center;border-right:1px solid #e2e8f0;">
                            <div style="font-size:11px;color:#64748b;margin-bottom:4px;">本轮确认积分</div>
                            <div style="font-size:19px;font-weight:700;color:#2563eb;">${escHtml(s.pointsText)}</div>
                        </td>
                        <td width="33%" style="padding:12px 10px;text-align:center;border-right:1px solid #e2e8f0;">
                            <div style="font-size:11px;color:#64748b;margin-bottom:4px;">执行账号</div>
                            <div style="font-size:16px;font-weight:700;color:${s.failCount ? '#dc2626' : '#0f172a'};">${escHtml(accountSummary)}</div>
                        </td>
                        <td width="33%" style="padding:12px 10px;text-align:center;">
                            <div style="font-size:11px;color:#64748b;margin-bottom:4px;">${escHtml(kpiThirdLabel)}</div>
                            <div style="font-size:16px;font-weight:700;color:#0f172a;">${escHtml(kpiThirdValue)}</div>
                        </td>
                    </tr>
                </table>
            </div>
            ${taskBar}
            <div style="padding:2px 18px 14px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;color:#64748b;margin-bottom:6px;">账号明细</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                    ${accountRows}
                </table>
            </div>
            <div style="padding:10px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;">
                ${s.test ? '这是一条测试推送，用于确认渠道连通性与展示样式。' : 'Rewards 控制台自动推送 · 打开面板可查看完整任务明细与日志。'}
            </div>
        </div>
    </div>`
}

function renderServerChanMarkdown(s) {
    const headerMeta = [
        `**${s.meta.label}**`,
        `\`${s.day}\``,
        ...(s.duration ? [`耗时 \`${s.duration}\``] : [])
    ].join('　·　')

    const summaryItems = [
        `- **本轮确认积分**：\`${s.pointsText}\``,
        `- **执行账号**：\`${s.accountCount} 个\`${s.failCount ? `（${s.failCount} 个待排查）` : ''}`,
        ...(s.totalBalance != null ? [`- **汇总余额**：\`${s.totalBalanceText}\``] : []),
        ...(s.taskSummary && s.taskSummary.total > 0 ? [`- **任务统计**：完成 \`${s.taskSummary.completed || 0}\` · 跳过 \`${s.taskSummary.skipped || 0}\` · 待关注 \`${s.taskSummary.attention || 0}\``] : [])
    ]

    const tableRows = s.accounts.length
        ? [
            '### 账号明细',
            '| # | 账号 | 状态 | 本轮得分 | 当前余额 |',
            '| :-: | :--- | :-: | ---: | ---: |',
            ...s.accounts.map(acc => `| ${acc.index} | \`${acc.label.replace(/`/g, '')}\` | ${acc.statusText} | **${escMd(acc.gainedText)}** | ${acc.balanceText} |`)
        ]
        : ['> 本轮暂无逐账号明细上报']

    return [
        `> ${headerMeta}`,
        '',
        '### 本轮概览',
        ...summaryItems,
        '',
        ...tableRows,
        '',
        '---',
        s.test ? '*Rewards 控制台测试推送 · 渠道连通性与样式验证正常*' : '*Rewards 控制台自动推送 · 打开控制台可查看逐项任务明细*'
    ].join('\n')
}

function renderBarkPayload(s) {
    const subtitleParts = [s.day, `本轮 ${s.pointsShort}`, `${s.accountCount} 个账号`]
    if (s.duration) subtitleParts.push(s.duration)
    const subtitle = subtitleParts.join(' · ')

    const summaryLine = s.totalBalance != null
        ? `本轮积分：${s.pointsText}  |  总余额：${s.totalBalanceText}`
        : `本轮积分：${s.pointsText}  |  账号数：${s.accountCount} 个`

    const taskLine = s.taskSummary && s.taskSummary.total > 0
        ? `任务统计：完成 ${s.taskSummary.completed || 0} · 跳过 ${s.taskSummary.skipped || 0} · 待关注 ${s.taskSummary.attention || 0}`
        : null

    const accountBlocks = s.accounts.map(acc => {
        const mark = acc.status === 'fail' ? '!' : acc.status === 'ok' ? '✓' : '·'
        const bal = acc.balance != null ? `  ·  余额 ${acc.balanceText}` : ''
        const warn = acc.status === 'fail' ? '  [待排查]' : ''
        return `${acc.index}. ${acc.label}\n   ${mark} ${acc.gainedText}${bal}${warn}`
    })

    const body = [
        summaryLine,
        ...(s.duration ? [`执行耗时：${s.duration}`] : []),
        ...(taskLine ? [taskLine] : []),
        ...(accountBlocks.length ? ['──────────────', ...accountBlocks] : []),
        '──────────────',
        s.test ? '测试推送正常 · 打开控制台可随时调整通知策略' : '打开 Rewards 控制台查看任务明细'
    ].join('\n')

    return {
        title: s.title,
        subtitle,
        body,
        group: 'Rewards 签到',
        level: s.meta.urgent ? 'timeSensitive' : 'active'
    }
}

export function formatRunNotification(provider, run, options = {}) {
    const summary = summarizeRun(run, options)
    if (provider === 'bark') {
        const payload = renderBarkPayload(summary)
        return { provider, format: 'bark', ...payload, summary }
    }
    if (provider === 'serverchan') {
        return { provider, format: 'markdown', title: summary.title, content: renderServerChanMarkdown(summary), summary }
    }
    return { provider: 'pushplus', format: 'html', title: summary.title, content: renderPushPlusHtml(summary), summary }
}

export function samplePreviewRun(state = 'completed') {
    const valid = ['completed', 'partial', 'failed'].includes(state) ? state : 'completed'
    const now = Date.now()
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Shanghai' }).format(now)
    const accounts = valid === 'completed'
        ? [
            { email: 'daily.user@outlook.com', success: true, collectedPoints: 165, finalPoints: 8420 },
            { email: 'backup.acc@outlook.com', success: true, collectedPoints: 150, finalPoints: 6180 }
        ]
        : valid === 'partial'
          ? [
              { email: 'daily.user@outlook.com', success: true, collectedPoints: 165, finalPoints: 8420 },
              { email: 'backup.acc@outlook.com', success: false, collectedPoints: 0, finalPoints: 6030, error: '需要重新验证' }
          ]
          : [
              { email: 'daily.user@outlook.com', success: false, collectedPoints: null, finalPoints: 8255, error: '会话失效' },
              { email: 'backup.acc@outlook.com', success: false, collectedPoints: null, finalPoints: 6030, error: '网络超时' }
          ]
    const points = valid === 'completed' ? 315 : valid === 'partial' ? 165 : 0
    const taskSummary = valid === 'completed'
        ? { total: 14, completed: 12, skipped: 2, attention: 0 }
        : valid === 'partial'
          ? { total: 14, completed: 9, skipped: 3, attention: 2 }
          : { total: 6, completed: 0, skipped: 1, attention: 5 }
    return {
        day,
        state: valid,
        startedAt: now - 512000,
        endedAt: now,
        points,
        accounts,
        taskSummary
    }
}

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

async function deliver(config, formatted, fetcher) {
    if (config.provider === 'bark') {
        const response = await fetcher(`${config.server}/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_key: config.token,
                title: formatted.title,
                subtitle: formatted.subtitle,
                body: formatted.body,
                group: formatted.group,
                level: formatted.level
            }),
            signal: AbortSignal.timeout(8000),
            redirect: 'error'
        })
        if (!response.ok) throw new Error('通知渠道请求失败，请检查通知设置')
        const result = await response.json()
        if (Number(result.code) !== 200) throw new Error('通知渠道未接受消息，请检查密钥或渠道配额')
        return
    }
    const url = config.provider === 'serverchan' ? `https://sctapi.ft07.com/${config.token}.send` : 'https://www.pushplus.plus/send'
    const body = config.provider === 'serverchan'
        ? { title: formatted.title, desp: formatted.content }
        : { token: config.token, title: formatted.title, content: formatted.content, template: 'html' }
    const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: 'error'
    })
    if (!response.ok) throw new Error('通知渠道请求失败，请检查通知设置')
    const result = await response.json()
    if (config.provider === 'pushplus' ? Number(result.code) !== 200 : Number(result.code) !== 0) throw new Error('通知渠道未接受消息，请检查密钥或渠道配额')
}

export async function notifyRun(panelFile, run, { fetcher = fetch } = {}) {
    const config = notificationConfig(panelFile)
    if (!config.enabled || !config.token || (config.provider === 'bark' && !config.server) || (config.onlyProblems && ['completed', 'cancelled'].includes(run.state))) return { skipped: true }
    const formatted = formatRunNotification(config.provider, run)
    const resultFile = path.join(path.dirname(panelFile), 'notification-result.json')
    try {
        await deliver(config, formatted, fetcher)
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'sent' }), { mode: 0o600 })
        return { sent: true }
    } catch (error) {
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'failed' }), { mode: 0o600 })
        throw error
    }
}

export async function sendTestNotification(panelFile, { state = 'completed', fetcher = fetch } = {}) {
    const config = notificationConfig(panelFile)
    if (!config.token) throw Object.assign(new Error('请先填写并保存通知渠道密钥，再发送测试推送。'), { status: 422 })
    if (config.provider === 'bark' && !config.server) throw Object.assign(new Error('请先填写并保存 Bark 服务器地址，再发送测试推送。'), { status: 422 })
    const formatted = formatRunNotification(config.provider, samplePreviewRun(state), { test: true })
    const resultFile = path.join(path.dirname(panelFile), 'notification-result.json')
    try {
        await deliver(config, formatted, fetcher)
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'sent', test: true }), { mode: 0o600 })
        return { sent: true, provider: config.provider, view: notificationView(panelFile) }
    } catch (error) {
        fs.writeFileSync(resultFile, JSON.stringify({ at: Date.now(), state: 'failed', test: true }), { mode: 0o600 })
        throw Object.assign(new Error(error.message || '测试推送失败'), { status: 502 })
    }
}
