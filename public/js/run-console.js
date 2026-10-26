const ACTIVE = new Set(['starting', 'running', 'stopping'])
const LABELS = { completed: '本轮已完成', partial: '本轮部分完成', failed: '本轮运行失败', cancelled: '本轮已停止', interrupted: '上次运行被中断' }
export function waitMessage(delay, now = Date.now()) {
    if (!delay || !Number.isFinite(delay.seconds)) return null
    const since = typeof delay.sinceTs === 'number' ? delay.sinceTs : Date.parse(delay.sinceTs)
    if (!Number.isFinite(since)) return '正在等待下一步，等待起点尚未上报'
    const left = Math.max(0, Math.ceil((since + delay.seconds * 1000 - now) / 1000))
    return left ? `按设定间隔等待，还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒${delay.nextEmail ? `，随后切换到 ${delay.nextEmail}` : ''}` : '间隔已结束，等待脚本上报下一步'
}

export function elapsed(start, end = Date.now()) {
    const ms = Number.isFinite(Number(start)) ? Number(start) : Date.parse(start)
    if (!ms) return '—'
    const seconds = Math.max(0, Math.floor((end - ms) / 1000))
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function runView(info, { pending = null, error = null } = {}) {
    const live = info?.state || 'unknown'
    const active = ACTIVE.has(live) || Boolean(pending)
    const latest = info?.latest
    const sameRun = latest && (!info.startedAt || Math.abs(latest.run.startedAt - Date.parse(info.startedAt)) < 15000)
    const tasks = sameRun ? latest?.tasks || [] : []
    const current = tasks.filter(task => task.state === 'running').sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const failed = latest?.tasks?.find(task => ['failed', 'partial', 'incomplete'].includes(task.state))
    const accountError = latest?.run?.accounts?.find(account => account.error)
    const failure = accountError?.error || failed?.message || info?.lastExit?.error || ''
    const loginError = /login|sign.?in|authenticate|authentication|verification|captcha|登录|验证|会话/i.test(failure)
    const newerExit = info?.lastExit && (!latest || Date.parse(info.lastExit.at) > (latest.run.endedAt || latest.run.updatedAt) + 15000)
    let view = {
        active, stopDisabled: !active || pending === 'stop' || live === 'stopping',
        startDisabled: active || live !== 'idle' || Boolean(info?.authorization) || !info?.readiness?.ready,
        badge: '待运行', title: '准备好，开始今天的签到', tone: 'idle',
        description: `一键运行全部 ${info?.readiness?.accounts || 0} 个账号；任务和积分会自动记入运行记录。`,
        account: active ? info?.run?.currentAccount || latest?.run?.currentAccount || '等待账号信息' : latest?.run?.currentAccount || '全部账号',
        task: active ? current?.label || (info?.run?.pendingDelay ? '等待下一步' : '初始化 / 等待任务信息') : '等待下一次运行',
        duration: active ? elapsed(info?.startedAt || latest?.run?.startedAt) : latest ? elapsed(latest.run.startedAt, latest.run.endedAt || latest.run.updatedAt) : '—',
        points: (active ? sameRun ? latest?.run?.points : null : latest?.run?.points) ?? null,
        hint: '第一次使用：添加账号 → 登录账号 → 一键运行签到。', action: null, actionLabel: '', email: null
    }
    if (active) {
        const stopping = pending === 'stop' || live === 'stopping'
        view = { ...view, badge: stopping ? '正在停止' : live === 'running' && !pending ? '正在运行' : '正在启动',
            title: stopping ? '正在结束本轮签到' : '签到正在进行', tone: 'running',
            description: stopping ? '正在关闭脚本并保存记录，请稍等。停止通常需要几秒钟。' : info?.run?.pendingDelay ? '脚本正在按设定间隔等待，状态会自动更新。' : '脚本在服务器后台运行，关闭页面也会继续。',
            hint: '可以随时停止；已完成的任务和已获得的积分会保留。' }
        if (!stopping) {
            const waiting = waitMessage(info?.run?.pendingDelay)
            const progress = sameRun ? info?.progress : null
            if (waiting) { view.task = '正常等待'; view.description = waiting }
            else if (progress) {
                const phase = /login|sign.?in|authentication|登录|验证/i.test(progress.title + ' ' + progress.message) ? '账号登录'
                    : progress.title === 'PANEL-QUERY' ? '准备国内搜索词' : null
                if (phase) view.task = phase
                view.description = `${progress.title === 'PANEL-QUERY' ? progress.message.slice(0, 180) : `正在处理${phase || view.task}，具体输出可在任务记录中查看`} · 距上次进展 ${elapsed(progress.at)}`
            }
        }
    } else if (info?.authorization) {
        view = { ...view, badge: '等待登录', title: '先完成正在进行的账号登录', tone: 'attention',
            description: '账号登录和签到共用浏览器，请完成或结束登录后再运行。',
            hint: '远程浏览器中的验证码或确认操作需要你本人完成。', action: info.authorization.desktopUrl ? 'desktop' : 'login',
            actionLabel: info.authorization.desktopUrl ? '继续远程登录' : '查看登录进度', email: info.authorization.email }
    } else if (!info || live === 'unknown') {
        const configure = ['unconfigured', 'unauthorized'].includes(info?.control?.status)
        view = { ...view, badge: '状态未连接', title: '暂时无法读取签到状态', tone: 'attention',
            description: configure ? '签到服务尚未配置或令牌无效，请打开环境与设置修复连接。' : '请检查签到服务是否在线，然后重新获取状态。', hint: '如果仍然失败，请打开环境与设置查看连接情况。', action: configure ? 'settings' : 'refresh', actionLabel: configure ? '检查环境' : '重新连接' }
    } else if (!info.readiness?.ready) {
        view = { ...view, badge: '需要准备', title: info.readiness?.action === 'accounts' ? '先添加你的微软账号' : info.readiness?.action === 'login' ? '先完成账号登录' : '签到环境还未就绪', tone: 'attention',
            description: info.readiness?.error || '请检查账号和环境配置。', action: info.readiness?.action,
            actionLabel: { accounts: '添加账号', login: '去登录账号', settings: '检查环境' }[info.readiness?.action] || '检查环境',
            email: info.readiness?.loginRequired?.[0]?.email }
    } else if (newerExit) {
        view = { ...view, badge: '需要检查', title: '上次启动未生成完整记录', tone: 'attention', points: null,
            description: `脚本已退出${info.lastExit.code != null ? `（退出码 ${info.lastExit.code}）` : ''}，请查看运行记录或检查环境后重试。`,
            hint: failure || '启动成功只代表进程已创建，任务结果以运行记录为准。', action: 'settings', actionLabel: '检查环境' }
    } else if (latest) {
        const done = latest.run.state === 'completed'
        view = { ...view, badge: done ? '已完成' : latest.run.state === 'running' ? '正在保存记录' : '需要关注', title: LABELS[latest.run.state] || '正在确认上次运行结果', tone: done ? 'success' : 'attention',
            task: done ? '本轮任务已结束' : failed?.label || '查看本轮任务结果',
            description: done ? '可以查看具体任务、积分和耗时，也可以手动再次运行。' : latest.run.state === 'cancelled' ? '本轮已停止，已完成的结果已经保存。需要时可以再次运行。' : '部分任务可能没有完成，请查看具体原因后再重试。',
            hint: done ? '脚本会自行判断已完成的任务；可获得的积分以微软实际记录为准。' : failure ? `最近的问题：${failure}` : '打开运行记录，可以逐项查看成功、跳过和失败的任务。',
            action: loginError ? 'login' : 'logs', actionLabel: loginError ? '重新登录账号' : '查看本轮记录', email: accountError?.email || failed?.account }
    }
    if (error) view = { ...view, tone: 'attention', hint: error.message, action: error.action || 'refresh', actionLabel: { login: '去登录账号', accounts: '添加账号', settings: '检查环境' }[error.action] || '刷新状态', email: error.email || view.email }
    return view
}

export function createRunConsole({ api, onUnauthorized, onStart, onAction }) {
    const $ = selector => document.querySelector(selector)
    let info, pending = null, error = null, timer, tick, active = false, fetching = false, queued = false, epoch = 0
    function render() {
        const view = runView(info, { pending, error })
        $('#run-console').dataset.tone = view.tone
        for (const [id, value] of Object.entries({ 'run-badge': view.badge, 'run-title': view.title, 'run-description': view.description, 'run-current-account': view.account, 'run-current-task': view.task, 'run-elapsed': view.duration, 'run-earned': view.points == null ? '待确认' : `${view.points} 分`, 'run-guidance': view.hint })) $( `#${id}`).textContent = value
        const start = $('#btn-run-all')
        start.disabled = view.startDisabled
        start.classList.toggle('is-loading', pending === 'start' || info?.state === 'starting')
        start.setAttribute('aria-busy', String(pending === 'start' || info?.state === 'starting'))
        start.querySelector('.liquid-btn__text').textContent = pending === 'start' ? '正在启动…' : view.active ? '签到进行中' : '一键运行签到'
        $('#btn-stop-run').hidden = !view.active
        $('#btn-stop-run').disabled = view.stopDisabled
        $('#btn-stop-run').textContent = view.stopDisabled ? '正在停止…' : '停止运行'
        $('#run-next-action').hidden = !view.action
        $('#run-next-action').textContent = view.actionLabel
        $('#run-next-action').onclick = () => view.action === 'refresh' ? refresh(true) : onAction(view.action, view.email, info)
        const schedule = info?.schedule
        $('#run-schedule').textContent = schedule?.enabled ? `定时签到：每天 ${schedule.runAt}（${schedule.timezone}）· 忙碌时跳过` : '定时签到未开启 · 当前需手动运行'
        for (const button of document.querySelectorAll('#account-list [data-act="run"]')) button.disabled = view.active || Boolean(info?.authorization) || info?.state !== 'idle'
    }
    async function refresh(clearError = false) {
        if (!active) return
        if (clearError) error = null
        if (fetching) { queued = true; return }
        clearTimeout(timer)
        fetching = true
        const version = epoch
        try {
            const next = await api('/api/control/status')
            if (!active || version !== epoch) return
            info = next
        } catch (err) {
            if (err.status === 401) { stop(); onUnauthorized(); return }
            if (version === epoch) { info = null; error = { message: `获取运行状态失败：${err.message}` } }
        } finally {
            fetching = false
            if (active && queued) { queued = false; void refresh() }
            else if (active && version === epoch) {
                render()
                if (!document.hidden) timer = setTimeout(() => refresh(), ACTIVE.has(info?.state) || info?.authorization ? 3000 : 10000)
            }
        }
    }
    async function start(index = null) {
        if (pending || ACTIVE.has(info?.state)) return
        epoch++; pending = 'start'; error = null; render()
        try {
            await api('/api/control/start', { method: 'POST', body: { payload: index == null ? {} : { accountIndex: index } } })
            info = { ...info, state: 'starting', startedAt: Date.now(), latest: null, run: {} }
            onStart(index)
        } catch (err) {
            if (err.status === 401) { stop(); onUnauthorized(); return }
            error = { message: `未能启动：${err.message}`, action: err.body?.action, email: err.body?.readiness?.loginRequired?.[0]?.email }
        } finally { epoch++; pending = null; render(); void refresh() }
    }
    async function stopRun() {
        if (pending) return
        epoch++; pending = 'stop'; error = null; render()
        try {
            await api('/api/control/stop', { method: 'POST', body: {} })
            info = { ...info, state: 'stopping' }
        } catch (err) {
            if (err.status === 401) { stop(); onUnauthorized(); return }
            error = { message: `停止请求未确认：${err.message}。请刷新状态确认脚本是否仍在运行。` }
        } finally { epoch++; pending = null; render(); void refresh() }
    }
    function stop() { active = false; epoch++; queued = false; clearTimeout(timer); clearInterval(tick) }
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (active) void refresh() })
    $('#btn-run-all').addEventListener('click', () => start())
    $('#btn-stop-run').addEventListener('click', stopRun)
    $('#btn-run-records').addEventListener('click', () => onAction('logs', null, info))
    return { start, refresh, render, stop, open() { active = true; clearInterval(tick); tick = setInterval(() => { if (!document.hidden && ACTIVE.has(info?.state)) render() }, 1000); void refresh() } }
}
