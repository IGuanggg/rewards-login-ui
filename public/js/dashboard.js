export function trendSvg(trend) {
    const values = trend.filter(point => point.points != null)
    if (!values.length) return '<div class="dashboard-chart-empty"><strong>暂无积分记录</strong><p>完成一次签到后显示趋势。</p></div>'
    const max = Math.max(10, ...values.map(point => point.points)), min = Math.min(0, ...values.map(point => point.points))
    const y = value => 165 - (value - min) / (max - min) * 135
    const x = i => 40 + i * 590 / Math.max(1, trend.length - 1)
    let line = '', connected = false
    for (let i = 0; i < trend.length; i++) {
        if (trend[i].points == null) { connected = false; continue }
        line += `${connected ? 'L' : 'M'}${x(i)},${y(trend[i].points)} `; connected = true
    }
    return `<svg viewBox="0 0 660 205" role="img" aria-label="最近14天确认积分趋势，未记录的日期断开显示">
        ${[0, .5, 1].map(v => `<line x1="40" x2="630" y1="${y(min + (max - min) * v)}" y2="${y(min + (max - min) * v)}" class="chart-grid"/><text x="30" y="${y(min + (max - min) * v) + 4}" text-anchor="end">${Math.round(min + (max - min) * v)}</text>`).join('')}
        <path d="${line}" fill="none" class="chart-series"/>
        ${trend.map((point, i) => point.points == null ? '' : `<circle cx="${x(i)}" cy="${y(point.points)}" r="3" class="chart-point"><title>${point.day}：${point.points} 分</title></circle>`).join('')}
        ${[0, 6, 13].filter(i => i < trend.length).map(i => `<text x="${x(i)}" y="193" text-anchor="middle">${trend[i].day.slice(5)}</text>`).join('')}</svg>`
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
            $('#dash-attention-metric').dataset.tone = data.attention ? 'attention' : 'neutral'
            const balances = data.accounts.filter(account => account.balance != null)
            for (const [id, value] of Object.entries({ 'dash-accounts': data.accounts.length, 'dash-sessions': saved,
                'dash-points': data.todayPoints ?? '—', 'dash-balance': balances.length ? balances.reduce((n, a) => n + a.balance, 0) : '—', 'dash-attention': data.attention,
                'dash-updated': `${data.today} · 更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: data.timezone })}`,
                'dash-source': modes[data.queryMode] || '当前来源',
                'dash-next': data.schedule.enabled && data.schedule.supported ? fmtTime(data.schedule.nextAt) : '未开启，需手动运行',
                'dash-schedule-last': data.schedule.last ? `${data.schedule.last.day} ${data.schedule.last.reason}` : '尚无定时触发记录',
                'dash-version': `面板 ${data.panelVersion} / 内核 ${data.upstreamVersion || '未连接'}`,
                'dash-balance-note': `${balances.length}/${data.accounts.length} 个账号已上报余额` })) $(`#${id}`).textContent = value
            $('#dash-trend').innerHTML = trendSvg(data.trend)
            $('#dash-trend-table').innerHTML = data.trend.map(day => `<tr><td>${day.day}</td><td>${day.points ?? '未记录'}</td><td>${day.runs}</td></tr>`).join('')
            $('#dash-account-body').innerHTML = data.accounts.length ? data.accounts.map(account => `<tr><td>${esc(account.email)}</td><td>${account.savedSession ? '已保存' : '待登录'}</td><td>${account.todayPoints ?? '待确认'}</td><td>${account.balance ?? '待确认'}</td><td>${fmtTime(account.balanceAt)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">还没有账号，请到账号页添加并登录。</td></tr>'
            $('#dash-error').hidden = true
        } catch (error) {
            if (error.status === 401) { stop(); onUnauthorized(); return }
            if (active) { $('#dash-error').textContent = `更新失败：${error.message}。仍显示上次数据，可稍后重试。`; $('#dash-error').hidden = false }
        } finally { if (active && version === generation && !document.hidden) timer = setTimeout(refresh, 15000) }
    }
    function stop() { active = false; generation++; clearTimeout(timer) }
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (active) void refresh() })
    $('#dash-refresh').addEventListener('click', refresh)
    return { stop, refresh, open() { active = true; void refresh() } }
}
