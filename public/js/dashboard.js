export function trendSvg(trend) {
    const values = trend.filter(point => point.points != null)
    if (!values.length) return '<div class="dashboard-chart-empty"><span class="chart-empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 17 10 11l4 4 6-8M15 7h5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><strong>暂无 14 天积分趋势</strong><p>完成首轮签到后，将在这里自动绘制每日确认积分曲线。</p></div>'
    const max = Math.max(10, ...values.map(point => point.points)), min = Math.min(0, ...values.map(point => point.points))
    const baseY = 168
    const y = value => baseY - (value - min) / (max - min) * 136
    const x = i => 42 + i * 588 / Math.max(1, trend.length - 1)
    let line = '', area = '', segStart = null, lastX = null
    const flushArea = () => {
        if (segStart !== null && lastX !== null) {
            area += ` L${lastX},${baseY} L${segStart},${baseY} Z `
            segStart = null
            lastX = null
        }
    }
    for (let i = 0; i < trend.length; i++) {
        if (trend[i].points == null) { flushArea(); continue }
        const px = x(i), py = y(trend[i].points)
        if (segStart === null) {
            line += `M${px},${py} `
            area += `M${px},${py} `
            segStart = px
        } else {
            line += `L${px},${py} `
            area += `L${px},${py} `
        }
        lastX = px
    }
    flushArea()
    return `<svg viewBox="0 0 660 205" role="img" aria-label="最近14天确认积分趋势，未记录的日期断开显示">
        <defs><linearGradient id="trend-area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="chart-grad-top"/><stop offset="100%" class="chart-grad-bottom"/></linearGradient></defs>
        ${[0, .5, 1].map(v => `<line x1="42" x2="630" y1="${y(min + (max - min) * v)}" y2="${y(min + (max - min) * v)}" class="chart-grid"/><text x="32" y="${y(min + (max - min) * v) + 4}" text-anchor="end">${Math.round(min + (max - min) * v)}</text>`).join('')}
        ${area.trim() ? `<path d="${area.trim()}" class="chart-area"/>` : ''}
        <path d="${line.trim()}" fill="none" class="chart-series"/>
        ${trend.map((point, i) => point.points == null ? '' : `<circle cx="${x(i)}" cy="${y(point.points)}" r="3.5" class="chart-point"><title>${String(point.day).replace(/[<>&"]/g, '')}：${point.points} 分</title></circle>`).join('')}
        ${[0, 6, 13].filter(i => i < trend.length).map(i => `<text x="${x(i)}" y="194" text-anchor="middle">${String(trend[i].day).slice(5)}</text>`).join('')}</svg>`
}
const modes = { china: '国内热词 + 中文本地兜底', 'china-local': '中文本地词库', local: '上游本地词库', existing: '当前上游来源' }
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录'
export function createDashboard({ api, escapeHtml: esc, onUnauthorized }) {
    const $ = s => document.querySelector(s)
    let timer, active = false, generation = 0
    async function refresh() {
        const version = ++generation
        clearTimeout(timer)
        try {
            const data = await api('/api/dashboard')
            if (!active || generation !== version) return
            const saved = data.accounts.filter(account => account.savedSession).length
            $('#dash-attention').closest('.stat-card').dataset.color = data.attention ? 'red' : 'neutral'
            const balances = data.accounts.filter(account => account.balance != null)
            for (const [id, value] of Object.entries({ 'dash-accounts': data.accounts.length, 'dash-sessions': saved,
                'dash-points': data.todayPoints ?? '—', 'dash-balance': balances.length ? balances.reduce((n, a) => n + a.balance, 0) : '—', 'dash-attention': data.attention,
                'dash-updated': `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${data.timezone}`,
                'dash-source': modes[data.queryMode] || '当前来源',
                'dash-next': data.schedule.enabled && data.schedule.supported ? fmtTime(data.schedule.nextAt) : '未开启，需手动运行',
                'dash-schedule-last': data.schedule.last ? `${data.schedule.last.day} ${data.schedule.last.reason}` : '尚无定时触发记录',
                'dash-version': `面板 ${data.panelVersion} / 内核 ${data.upstreamVersion || '未连接'}`,
                'dash-balance-note': `${balances.length}/${data.accounts.length} 个账号已上报余额`,
                'dash-session-note': `${saved}/${data.accounts.length} 个账号已保存会话` })) $(`#${id}`).textContent = value
            $('#dash-trend').innerHTML = trendSvg(data.trend)
            $('#dash-trend-table').innerHTML = data.trend.map(day => `<tr><td>${esc(day.day)}</td><td class="num">${day.points ?? '未记录'}</td><td class="num">${day.runs}</td></tr>`).join('')
            $('#dash-account-body').innerHTML = data.accounts.length ? data.accounts.map(account => `<tr><td class="cell-email">${esc(account.email)}</td><td><span class="tag ${account.savedSession ? 'tag--ok' : 'tag--warn'}">${account.savedSession ? '已保存' : '待登录'}</span></td><td class="num">${account.todayPoints ?? '—'}</td><td class="num">${account.balance ?? '—'}</td><td class="cell-time">${fmtTime(account.balanceAt)}</td></tr>`).join('') : '<tr><td colspan="5" class="activity-table-empty">还没有账号，请前往「账号」页添加并登录。</td></tr>'
            $('#dash-error').hidden = true
        } catch (error) {
            if (error.status === 401) { stop(); onUnauthorized(); return }
            if (active) { $('#dash-error').textContent = `更新失败：${error.message}`; $('#dash-error').hidden = false }
        } finally { if (active && version === generation && !document.hidden) timer = setTimeout(refresh, 15000) }
    }
    function stop() { active = false; generation++; clearTimeout(timer) }
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (active) void refresh() })
    $('#dash-refresh').addEventListener('click', refresh)
    return { stop, refresh, open() { active = true; void refresh() } }
}
