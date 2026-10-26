const LABELS = { running: '执行中', completed: '已完成', processed: '已执行', partial: '部分完成',
    failed: '失败', skipped: '已跳过', already_done: '此前已完成', incomplete: '未确认完成',
    cancelled: '已终止', interrupted: '记录中断' }
const PLATFORMS = { MOBILE: '移动端', DESKTOP: '桌面端', MAIN: '通用' }

export function createActivityPanel({ api, escapeHtml: esc, timeOf, onUnauthorized }) {
    const $ = selector => document.querySelector(selector)
    const state = { active: false, busy: false, day: '', runId: '', timer: null, revision: '', tasksKey: '', logs: [], nextBefore: null, history: false, followLatest: true, logRequest: 0 }
    const tone = value => ['completed', 'processed'].includes(value) ? 'tag--ok'
        : ['failed', 'partial', 'incomplete', 'interrupted'].includes(value) ? 'tag--warn' : 'tag--accent'
    const statusTag = value => `<span class="tag ${tone(value)}">${esc(LABELS[value] || value)}</span>`
    const error = problem => {
        if (problem.status === 401) { stop(); onUnauthorized(); return }
        $('#activity-note').textContent = `读取失败：${problem.message}`
    }
    function stop() {
        state.active = false
        clearTimeout(state.timer)
    }
    function renderLogs() {
        const output = $('#activity-log-output')
        const stick = output.scrollHeight - output.scrollTop - output.clientHeight < 50
        output.innerHTML = state.logs.length ? state.logs.map(line => `<div class="log-line" data-level="${esc(line.level)}">
            <span class="log-line__time">${timeOf(line.at)}</span><span class="log-line__level">${esc(line.level)}</span>
            <span class="log-line__msg">${esc([line.account, line.title && `[${line.title}]`, line.message].filter(Boolean).join(' '))}</span></div>`).join('')
            : '<div class="log-empty">这一轮暂无匹配的签到输出。</div>'
        $('#activity-log-older').hidden = !state.nextBefore
        $('#activity-log-latest').hidden = !state.history
        if (stick) output.scrollTop = output.scrollHeight
    }
    async function loadLogs(older = false) {
        const id = state.runId
        if (!id || !$('#activity-raw').open) return
        const level = $('#activity-log-level').value
        state.history = older
        const request = ++state.logRequest
        const before = older && state.nextBefore ? `&before=${state.nextBefore}` : ''
        const data = await api(`/api/activity/logs?id=${encodeURIComponent(id)}&level=${level}${before}`)
        if (request !== state.logRequest || id !== state.runId || level !== $('#activity-log-level').value) return
        state.logs = data.logs
        state.history = older
        state.nextBefore = data.nextBefore
        renderLogs()
    }
    async function loadDetail() {
        const id = state.runId
        if (!id) return
        const { run, tasks } = await api(`/api/activity/run?id=${encodeURIComponent(id)}`)
        if (id !== state.runId || !state.active) return
        $('#activity-run-state').textContent = LABELS[run.state] || run.state
        $('#activity-run-state').className = `tag ${tone(run.state)}`
        const elapsed = Math.max(0, Math.floor(((run.endedAt || Date.now()) - run.startedAt) / 1000))
        $('#activity-duration').textContent = `${run.endedAt ? '用时' : '已运行'} ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
        $('#activity-accounts').textContent = (run.accounts || []).map(account => `${account.email} · 获得 ${account.collectedPoints ?? '—'} 积分${account.error ? ` · ${account.error}` : ''}`).join('；')
        const key = JSON.stringify([id, tasks])
        if (key !== state.tasksKey) {
            state.tasksKey = key
            $('#activity-task-list').innerHTML = tasks.length ? tasks.map(task => `<tr>
                <td>${timeOf(task.startedAt)}</td><td class="activity-account">${esc(task.account || '—')}</td>
                <td><strong>${esc(task.label)}</strong><small>${esc(task.message)}</small></td>
                <td>${esc(PLATFORMS[task.platform] || task.platform)}</td><td>${statusTag(task.state)}</td><td>${task.points ?? '—'}</td></tr>`).join('')
                : '<tr><td colspan="6" class="activity-table-empty">尚未收到任务明细。启动检查和报错可以在原始日志中查看。</td></tr>'
        }
        const revision = `${id}:${run.revision}:${run.state}:${$('#activity-log-level').value}`
        if (revision !== state.revision && $('#activity-raw').open && !state.history) { await loadLogs(); state.revision = revision }
    }
    async function refresh() {
        if (!state.active || state.busy || document.visibilityState === 'hidden') return
        clearTimeout(state.timer)
        state.busy = true
        const requestedDay = state.day
        try {
            const data = await api(`/api/activity${requestedDay ? `?day=${requestedDay}` : ''}`)
            if (!state.active || state.day !== requestedDay) return
            state.day = data.day
            $('#activity-day').value = data.day
            $('#activity-runs').textContent = data.summary.runs
            $('#activity-tasks').textContent = data.summary.tasks
            $('#activity-points').textContent = data.summary.points ?? '—'
            $('#activity-attention').textContent = (data.summary.attention || 0) + (data.summary.failedRuns || 0)
            $('#activity-note').textContent = `${data.day === data.today ? '今天' : data.day} · ${data.timezone} · 按启动日期归档，保留 ${data.retentionDays} 天。积分仅显示脚本明确汇报的值；“—”表示未汇报。`
            $('#activity-empty').hidden = data.runs.length > 0
            $('#activity-detail').hidden = !data.runs.length
            const previous = state.runId
            if (state.followLatest || !data.runs.some(run => run.id === state.runId)) state.runId = data.runs[0]?.id || ''
            const options = data.runs.map(run => `<option value="${esc(run.id)}">${timeOf(run.startedAt)} · ${esc(LABELS[run.state] || run.state)} · ${run.points ?? '—'} 积分</option>`).join('')
            const select = $('#activity-run-select')
            if (select.innerHTML !== options) { select.innerHTML = options; select.value = state.runId }
            if (previous !== state.runId) { state.logs = []; state.nextBefore = null; state.revision = ''; state.tasksKey = ''; state.history = false }
            if (state.runId) await loadDetail()
        } catch (problem) { error(problem) }
        finally {
            state.busy = false
            if (state.active) state.timer = setTimeout(refresh, 3000)
        }
    }
    $('#activity-day').addEventListener('change', () => { state.day = $('#activity-day').value; state.runId = ''; state.followLatest = true; void refresh() })
    $('#activity-today').addEventListener('click', () => { state.day = ''; state.runId = ''; state.followLatest = true; void refresh() })
    $('#activity-refresh').addEventListener('click', () => { void refresh() })
    $('#activity-run-select').addEventListener('change', () => {
        state.runId = $('#activity-run-select').value
        state.followLatest = false
        state.logs = []; state.nextBefore = null; state.revision = ''; state.history = false
        void loadDetail().catch(error)
    })
    $('#activity-raw').addEventListener('toggle', () => { if ($('#activity-raw').open) void loadLogs().catch(error) })
    $('#activity-log-level').addEventListener('change', () => { void loadLogs().catch(error) })
    $('#activity-log-older').addEventListener('click', () => { void loadLogs(true).catch(error) })
    $('#activity-log-latest').addEventListener('click', () => { void loadLogs().catch(error) })
    document.addEventListener('visibilitychange', () => { if (state.active && document.visibilityState === 'visible') void refresh() })
    return { open() { state.active = true; void refresh() }, today() { state.day = ''; state.runId = ''; state.followLatest = true },
        selectRun(run) { state.day = run.day; state.runId = run.id; state.followLatest = false; state.logs = []; state.nextBefore = null; state.revision = ''; state.history = false }, stop }
}
