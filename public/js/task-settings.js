export function createTaskSettings({ api, escapeHtml: esc, onUnauthorized, onSaved }) {
    const $ = selector => document.querySelector(selector)
    let data, busy = false
    function message(text, bad = false) { $('#task-settings-note').textContent = text; $('#task-settings-note').dataset.tone = bad ? 'bad' : 'ok' }
    function render() {
        $('#task-options').innerHTML = data.workers.map(worker => `<label class="task-option"><input type="checkbox" data-worker="${esc(worker.key)}" ${worker.enabled ? 'checked' : ''}><span>${esc(worker.label)}</span></label>`).join('')
        for (const key of ['searchDelay', 'accountDelay', 'readDelay']) for (const edge of ['min', 'max']) $(`#task-${key}-${edge}`).value = data[key][edge] ?? ''
        for (const option of $('#task-query-mode').options) if (['china', 'china-local'].includes(option.value)) option.disabled = !data.chinaSupported
        $('#task-china-support').textContent = data.chinaSupported ? '国区适配已安装。' : '当前内核需升级镜像后启用国内词源。'
        $('#task-china-preset').disabled = !data.chinaSupported
        $('#task-query-mode').value = data.queryMode
        $('#task-stop-warning').checked = data.stopOnWarning
        $('#task-skip-empty').checked = data.skipNonPointTasks
        $('#task-schedule-enabled').checked = data.schedule.enabled
        $('#task-schedule-time').value = data.schedule.runAt
        $('#task-schedule-zone').textContent = `时区：${data.schedule.timezone}。每个自然日定时触发一次；到点忙碌时跳过，不补跑。`
        $('#task-schedule-fields').disabled = !data.schedulingSupported
        $('#task-schedule-unsupported').hidden = data.schedulingSupported
        $('#task-settings-fields').disabled = false
    }
    async function load() {
        if (busy) return
        busy = true
        $('#task-settings-fields').disabled = true
        message('正在读取当前脚本设置…')
        try { data = await api('/api/task-settings'); render(); message('设置作用于所有账号，保存后从下一次签到开始生效。') }
        catch (error) { if (error.status === 401) onUnauthorized(); else message(`读取失败：${error.message}。请点击重新读取。`, true) }
        finally { busy = false }
    }
    $('#task-settings-reload').addEventListener('click', load)
    $('#task-china-preset').addEventListener('click', () => {
        if (!data?.chinaSupported) return
        $('#task-query-mode').value = 'china'
        for (const [key, range] of Object.entries({ searchDelay: [120, 240], readDelay: [60, 120] })) {
            $(`#task-${key}-min`).value = range[0]; $(`#task-${key}-max`).value = range[1]
        }
        $('#task-stop-warning').checked = true; $('#task-skip-empty').checked = true
        for (const key of ['doBonusSearches', 'doVisualSearch']) { const input = document.querySelector(`[data-worker="${key}"]`); if (input) input.checked = false }
        message('已填入国内词源和较慢间隔，点击保存后生效。间隔影响耗时，不保证获得积分。')
    })
    $('#task-settings-form').addEventListener('submit', async event => {
        event.preventDefault()
        if (busy || !data) return
        busy = true
        const button = $('#task-settings-save')
        button.disabled = true; button.textContent = '正在保存…'
        const body = { workers: Object.fromEntries([...document.querySelectorAll('[data-worker]')].map(input => [input.dataset.worker, input.checked])),
            searchDelay: { min: Number($('#task-searchDelay-min').value), max: Number($('#task-searchDelay-max').value) },
            accountDelay: { min: Number($('#task-accountDelay-min').value), max: Number($('#task-accountDelay-max').value) },
            readDelay: { min: Number($('#task-readDelay-min').value), max: Number($('#task-readDelay-max').value) },
            queryMode: $('#task-query-mode').value, stopOnWarning: $('#task-stop-warning').checked, skipNonPointTasks: $('#task-skip-empty').checked,
            ...(data.schedulingSupported ? { schedule: { enabled: $('#task-schedule-enabled').checked, runAt: $('#task-schedule-time').value } } : {}) }
        try { data = await api('/api/task-settings', { method: 'PUT', body }); render(); message('已保存。任务设置在下次运行生效，定时设置无需重启容器。'); onSaved() }
        catch (error) { if (error.status === 401) onUnauthorized(); else message(`未保存：${error.message}`, true) }
        finally { busy = false; button.disabled = false; button.textContent = '保存签到设置' }
    })
    return { load }
}
