export function createTaskSettings({ api, escapeHtml: esc, onUnauthorized, onSaved }) {
    const $ = selector => document.querySelector(selector)
    let data, busy = false, autoTimer = null, queuedManual = false
    let fadeTimer = null
    function message(text, bad = false) {
        const note = $('#task-settings-note')
        clearTimeout(fadeTimer)
        note.textContent = text; note.dataset.tone = bad ? 'bad' : 'ok'
        if (text && !bad) fadeTimer = setTimeout(() => { note.textContent = '' }, 2500)
    }
    function renderWorkers() {
        $('#task-options').innerHTML = data.workers.map(worker => `<label class="task-option"><input type="checkbox" data-worker="${esc(worker.key)}" ${worker.enabled ? 'checked' : ''}><span>${esc(worker.label)}</span></label>`).join('')
    }
    function render() {
        renderWorkers()
        for (const key of ['searchDelay', 'accountDelay', 'readDelay', 'taskDelay']) {
            for (const edge of ['min', 'max']) {
                const el = $(`#task-${key}-${edge}`)
                if (el) {
                    el.value = data[key]?.[edge] ?? ''
                    if (key === 'taskDelay') el.disabled = !data.v5Supported
                }
            }
        }
        const modeEl = $('#task-rewards-mode')
        if (modeEl) {
            modeEl.value = data.rewardsMode || 'browser'
            modeEl.disabled = !data.v5Supported
        }
        const streakEl = $('#task-streak-protection')
        if (streakEl) {
            streakEl.checked = Boolean(data.ensureStreakProtection)
            streakEl.disabled = !data.v5Supported
        }
        for (const option of $('#task-query-mode').options) if (['china', 'china-local'].includes(option.value)) option.disabled = !data.chinaSupported
        $('#task-china-support').textContent = data.chinaSupported ? '' : '当前内核需升级镜像后启用国内词源。'
        $('#task-china-preset').disabled = !data.chinaSupported
        $('#task-query-mode').value = data.queryMode
        $('#task-stop-warning').checked = data.stopOnWarning
        $('#task-skip-empty').checked = data.skipNonPointTasks
        $('#task-schedule-enabled').checked = data.schedule.enabled
        $('#task-schedule-time').value = data.schedule.runAt
        $('#task-schedule-zone').textContent = data.schedule.timezone
        $('#task-schedule-fields').disabled = !data.schedulingSupported
        $('#task-schedule-unsupported').hidden = data.schedulingSupported
        $('#task-settings-fields').disabled = false
    }
    function savedBody(overrides = {}) {
        return {
            workers: Object.fromEntries((data.workers || []).map(worker => [worker.key, worker.enabled])),
            searchDelay: { min: data.searchDelay?.min, max: data.searchDelay?.max },
            accountDelay: { min: data.accountDelay?.min, max: data.accountDelay?.max },
            readDelay: { min: data.readDelay?.min, max: data.readDelay?.max },
            ...(data.v5Supported ? {
                rewardsMode: data.rewardsMode || 'api',
                ensureStreakProtection: Boolean(data.ensureStreakProtection),
                taskDelay: { min: data.taskDelay?.min, max: data.taskDelay?.max }
            } : {}),
            queryMode: data.queryMode,
            stopOnWarning: Boolean(data.stopOnWarning),
            skipNonPointTasks: Boolean(data.skipNonPointTasks),
            ...(data.schedulingSupported ? { schedule: { enabled: Boolean(data.schedule?.enabled), runAt: data.schedule?.runAt || '09:00' } } : {}),
            ...overrides
        }
    }
    function formBody() {
        return {
            workers: Object.fromEntries([...document.querySelectorAll('[data-worker]')].map(input => [input.dataset.worker, input.checked])),
            searchDelay: { min: Number($('#task-searchDelay-min').value), max: Number($('#task-searchDelay-max').value) },
            accountDelay: { min: Number($('#task-accountDelay-min').value), max: Number($('#task-accountDelay-max').value) },
            readDelay: { min: Number($('#task-readDelay-min').value), max: Number($('#task-readDelay-max').value) },
            ...(data?.v5Supported ? {
                rewardsMode: $('#task-rewards-mode')?.value || 'api',
                ensureStreakProtection: Boolean($('#task-streak-protection')?.checked),
                taskDelay: { min: Number($('#task-taskDelay-min').value), max: Number($('#task-taskDelay-max').value) }
            } : {}),
            queryMode: $('#task-query-mode').value,
            stopOnWarning: $('#task-stop-warning').checked,
            skipNonPointTasks: $('#task-skip-empty').checked,
            ...(data.schedulingSupported ? { schedule: { enabled: $('#task-schedule-enabled').checked, runAt: $('#task-schedule-time').value } } : {})
        }
    }
    async function load() {
        if (busy) return
        clearTimeout(autoTimer)
        busy = true
        $('#task-settings-fields').disabled = true
        message('读取中…')
        try { data = await api('/api/task-settings'); render(); message('') }
        catch (error) { if (error.status === 401) onUnauthorized(); else message(`读取失败：${error.message}`, true) }
        finally { busy = false }
    }
    async function save({ mode = 'manual', payload = null } = {}) {
        if (!data) return
        if (busy) {
            if (mode === 'manual') queuedManual = true
            return
        }
        busy = true
        const isManual = mode === 'manual'
        const isWorkers = mode === 'workers'
        const button = $('#task-settings-save')
        const presetBtn = $('#task-china-preset')
        const label = button.querySelector('.liquid-btn__text') || button
        if (isManual) { button.disabled = true; label.textContent = '保存中…' }
        if (mode === 'preset' && presetBtn) presetBtn.disabled = true
        const reqBody = payload || (isWorkers
            ? savedBody({ workers: Object.fromEntries([...document.querySelectorAll('[data-worker]')].map(input => [input.dataset.worker, input.checked])) })
            : formBody())
        try {
            data = await api('/api/task-settings', { method: 'PUT', body: reqBody })
            if (isWorkers) renderWorkers()
            else render()
            message(mode === 'preset' ? '已套用国区建议并保存' : isWorkers ? '任务开关已保存' : '已保存')
            onSaved()
        } catch (error) {
            if (error.status === 401) onUnauthorized()
            else {
                if (isWorkers) renderWorkers()
                message(`未保存：${error.message}`, true)
            }
        } finally {
            busy = false
            if (isManual) { button.disabled = false; label.textContent = '保存签到设置' }
            if (mode === 'preset' && presetBtn) presetBtn.disabled = !data?.chinaSupported
            if (queuedManual) {
                queuedManual = false
                void save({ mode: 'manual' })
            }
        }
    }
    $('#task-settings-reload').addEventListener('click', load)
    // 勾选任务即时保存，仅提交任务开关，不动其他未保存修改
    $('#task-options').addEventListener('change', () => { clearTimeout(autoTimer); autoTimer = setTimeout(() => void save({ mode: 'workers' }), 400) })
    $('#task-china-preset').addEventListener('click', () => {
        if (!data?.chinaSupported || busy) return
        clearTimeout(autoTimer)
        const workers = Object.fromEntries((data.workers || []).map(worker => [worker.key, worker.enabled]))
        for (const key of ['doBonusSearches', 'doVisualSearch']) if (key in workers) workers[key] = false
        if (!Object.values(workers).some(Boolean)) {
            for (const fallback of ['doDailySet', 'doDesktopSearch', 'doMobileSearch']) {
                if (fallback in workers) workers[fallback] = true
            }
            if (!Object.values(workers).some(Boolean)) {
                const first = Object.keys(workers)[0]
                if (first) workers[first] = true
            }
        }
        const preset = savedBody({
            workers,
            queryMode: 'china',
            searchDelay: { min: 120, max: 240 },
            readDelay: { min: 60, max: 120 },
            stopOnWarning: true,
            skipNonPointTasks: true,
            ...(data.v5Supported ? { rewardsMode: 'api', ensureStreakProtection: true, taskDelay: { min: 15, max: 30 } } : {})
        })
        void save({ mode: 'preset', payload: preset })
    })
    $('#task-settings-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(autoTimer); void save({ mode: 'manual' }) })
    return { load }
}
