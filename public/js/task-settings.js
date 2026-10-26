export function createTaskSettings({ api, escapeHtml: esc, onUnauthorized, onSaved }) {
    const $ = selector => document.querySelector(selector)
    let data, busy = false, autoTimer = null
    let fadeTimer = null
    function message(text, bad = false) {
        const note = $('#task-settings-note')
        clearTimeout(fadeTimer)
        note.textContent = text; note.dataset.tone = bad ? 'bad' : 'ok'
        if (text && !bad) fadeTimer = setTimeout(() => { note.textContent = '' }, 2500)
    }
    function render() {
        $('#task-options').innerHTML = data.workers.map(worker => `<label class="task-option"><input type="checkbox" data-worker="${esc(worker.key)}" ${worker.enabled ? 'checked' : ''}><span>${esc(worker.label)}</span></label>`).join('')
        for (const key of ['searchDelay', 'accountDelay', 'readDelay']) for (const edge of ['min', 'max']) $(`#task-${key}-${edge}`).value = data[key][edge] ?? ''
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
    function body() {
        return { workers: Object.fromEntries([...document.querySelectorAll('[data-worker]')].map(input => [input.dataset.worker, input.checked])),
            searchDelay: { min: Number($('#task-searchDelay-min').value), max: Number($('#task-searchDelay-max').value) },
            accountDelay: { min: Number($('#task-accountDelay-min').value), max: Number($('#task-accountDelay-max').value) },
            readDelay: { min: Number($('#task-readDelay-min').value), max: Number($('#task-readDelay-max').value) },
            queryMode: $('#task-query-mode').value, stopOnWarning: $('#task-stop-warning').checked, skipNonPointTasks: $('#task-skip-empty').checked,
            ...(data.schedulingSupported ? { schedule: { enabled: $('#task-schedule-enabled').checked, runAt: $('#task-schedule-time').value } } : {}) }
    }
    async function load() {
        if (busy) return
        busy = true
        $('#task-settings-fields').disabled = true
        message('读取中…')
        try { data = await api('/api/task-settings'); render(); message('') }
        catch (error) { if (error.status === 401) onUnauthorized(); else message(`读取失败：${error.message}`, true) }
        finally { busy = false }
    }
    async function save({ auto = false } = {}) {
        if (busy || !data) return
        busy = true
        const button = $('#task-settings-save')
        if (!auto) { button.disabled = true; button.textContent = '保存中…' }
        try { data = await api('/api/task-settings', { method: 'PUT', body: body() }); if (!auto) render(); message('已保存'); onSaved() }
        catch (error) { if (error.status === 401) onUnauthorized(); else message(`未保存：${error.message}`, true) }
        finally { busy = false; if (!auto) { button.disabled = false; button.textContent = '保存签到设置' } }
    }
    $('#task-settings-reload').addEventListener('click', load)
    // 勾选任务即时保存，不必再点按钮
    $('#task-options').addEventListener('change', () => { clearTimeout(autoTimer); autoTimer = setTimeout(() => save({ auto: true }), 400) })
    $('#task-china-preset').addEventListener('click', () => {
        if (!data?.chinaSupported) return
        $('#task-query-mode').value = 'china'
        for (const [key, range] of Object.entries({ searchDelay: [120, 240], readDelay: [60, 120] })) {
            $(`#task-${key}-min`).value = range[0]; $(`#task-${key}-max`).value = range[1]
        }
        $('#task-stop-warning').checked = true; $('#task-skip-empty').checked = true
        for (const key of ['doBonusSearches', 'doVisualSearch']) { const input = document.querySelector(`[data-worker="${key}"]`); if (input) input.checked = false }
        save({ auto: true })
    })
    $('#task-settings-form').addEventListener('submit', event => { event.preventDefault(); save() })
    return { load }
}
