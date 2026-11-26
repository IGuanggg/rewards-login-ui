const PROVIDER_BADGE = {
    pushplus: 'PushPlus · HTML 卡片',
    serverchan: 'Server酱 · Markdown 报表',
    bark: 'Bark · iOS 分级通知'
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

function renderPreviewStage(stage, payload) {
    if (!stage || !payload) return
    if (payload.format === 'html') {
        stage.innerHTML = ''
        const frame = document.createElement('iframe')
        frame.className = 'notify-preview__frame'
        frame.setAttribute('sandbox', '')
        frame.setAttribute('title', 'PushPlus HTML 推送样式预览')
        frame.srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#f3f5f8;}</style></head><body>${payload.content}</body></html>`
        stage.appendChild(frame)
        return
    }
    if (payload.format === 'bark') {
        const urgent = payload.level === 'timeSensitive'
        stage.innerHTML = `
            <div class="notify-bark">
                <div class="notify-bark__banner">
                    <div class="notify-bark__app">
                        <span class="notify-bark__icon" aria-hidden="true">R</span>
                        <span class="notify-bark__group">${esc(payload.group || 'Rewards 签到')}</span>
                        ${urgent ? '<span class="notify-bark__urgent">重要提醒</span>' : ''}
                        <span class="notify-bark__time">现在</span>
                    </div>
                    <strong class="notify-bark__title">${esc(payload.title)}</strong>
                    <p class="notify-bark__subtitle">${esc(payload.subtitle || '')}</p>
                    <pre class="notify-bark__body">${esc(payload.body || '')}</pre>
                </div>
            </div>`
        return
    }
    const s = payload.summary || {}
    const rows = (s.accounts || []).map(acc => `
        <tr>
            <td>${acc.index}</td>
            <td class="mono">${esc(acc.label)}</td>
            <td><span class="tag ${acc.status === 'fail' ? 'tag--warn' : 'tag--ok'}">${esc(acc.statusText)}</span></td>
            <td class="num"><strong>${esc(acc.gainedText)}</strong></td>
            <td class="num">${esc(acc.balanceText)}</td>
        </tr>`).join('')
    stage.innerHTML = `
        <div class="notify-md">
            <div class="notify-md__title">${esc(payload.title)}</div>
            <blockquote class="notify-md__quote" style="border-left-color:${esc(s.meta?.accent || '#2563eb')}">
                <strong>${esc(s.meta?.label || '')}</strong> · <code>${esc(s.day || '')}</code>${s.duration ? ` · 耗时 <code>${esc(s.duration)}</code>` : ''}
            </blockquote>
            <div class="notify-md__kpis">
                <span>本轮积分 <code>${esc(s.pointsText || '—')}</code></span>
                <span>执行账号 <code>${s.accountCount || 0} 个</code></span>
                ${s.totalBalance != null ? `<span>汇总余额 <code>${esc(s.totalBalanceText)}</code></span>` : ''}
            </div>
            <div class="activity-table-wrap">
                <table class="activity-table notify-md__table">
                    <thead><tr><th>#</th><th>账号</th><th>状态</th><th class="num">本轮得分</th><th class="num">余额</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" class="activity-table-empty">暂无明细</td></tr>'}</tbody>
                </table>
            </div>
            <details class="notify-md__raw">
                <summary>查看发送的 Markdown 原文</summary>
                <pre>${esc(payload.content || '')}</pre>
            </details>
        </div>`
}

export function createNotifications({ api, onUnauthorized }) {
    const $ = s => document.querySelector(s)
    let busy = false, testing = false, data, previewState = 'completed', previewSeq = 0
    const isBark = () => $('#notification-provider').value === 'bark'

    function hasUnsavedChannelChanges() {
        if (!data) return false
        const provider = $('#notification-provider').value
        if (provider !== data.provider) return true
        if ($('#notification-token').value.trim()) return true
        if ($('#notification-clear').checked) return true
        if (provider === 'bark') {
            const currentServer = $('#notification-server').value.trim().replace(/\/+$/, '')
            const savedServer = String(data.server || '').trim().replace(/\/+$/, '')
            if (currentServer !== savedServer) return true
        }
        return false
    }

    function syncProvider() {
        const provider = $('#notification-provider').value
        const bark = provider === 'bark'
        const wrap = $('#notification-server-field')
        if (wrap) wrap.hidden = !bark
        const label = $('#notification-token-label')
        if (label) label.textContent = bark ? '设备密钥' : '渠道密钥'
        const input = $('#notification-token')
        const saved = Boolean(data?.hasToken && data.provider === provider)
        input.placeholder = bark
            ? (saved ? '已保存，留空保留' : '填入 Bark 设备密钥')
            : (saved ? '已保存，留空保留' : '填入 Token / SendKey')
        const badge = $('#notify-preview-badge')
        if (badge) badge.textContent = PROVIDER_BADGE[provider] || provider
        const dirty = hasUnsavedChannelChanges()
        const testBtn = $('#notification-test')
        if (testBtn) {
            testBtn.disabled = testing || dirty || !saved || (bark && !data?.server)
            testBtn.title = dirty
                ? '渠道、地址或密钥有未保存修改，请先点击「保存通知设置」后再发送测试'
                : !saved || (bark && !data?.server)
                  ? '请先填写并保存渠道密钥后再测试'
                  : ''
        }
    }

    async function refreshPreview() {
        const stage = $('#notify-preview-stage')
        if (!stage) return
        const provider = $('#notification-provider')?.value || 'pushplus'
        const seq = ++previewSeq
        try {
            const payload = await api(`/api/notifications/preview?provider=${encodeURIComponent(provider)}&state=${encodeURIComponent(previewState)}`)
            if (seq !== previewSeq) return
            renderPreviewStage(stage, payload)
        } catch (error) {
            if (seq !== previewSeq) return
            stage.innerHTML = `<p class="muted" style="padding:16px;text-align:center;">预览加载失败：${esc(error.message)}</p>`
        }
    }

    function statusNote() {
        if (!data) return ''
        const last = data.last
            ? `上次${data.last.test ? '测试' : ''}推送${data.last.state === 'sent' ? '成功' : '失败'}（${new Date(data.last.at).toLocaleString('zh-CN', { hour12: false })}）。`
            : ''
        const envHint = data.autoSupported === false ? '本机模式可手动测试推送，自动推送需 Docker 部署。' : ''
        const head = data.enabled ? '已开启自动推送。' : '未开启自动推送。'
        return [head, envHint, last].filter(Boolean).join(' ')
    }

    function render() {
        $('#notification-enabled').checked = Boolean(data.enabled)
        $('#notification-provider').value = data.provider || 'pushplus'
        $('#notification-onlyProblems').checked = Boolean(data.onlyProblems)
        $('#notification-token').value = ''
        $('#notification-server').value = data.server || ''
        $('#notification-clear').checked = false
        syncProvider()
        $('#notification-fields').disabled = data.supported === false
        void refreshPreview()
    }

    async function load() {
        if (busy) return
        busy = true
        try {
            data = await api('/api/notifications')
            render()
            const note = $('#notification-note')
            note.dataset.tone = data.last?.state === 'failed' ? 'bad' : 'muted'
            note.textContent = statusNote()
        } catch (error) {
            if (error.status === 401) onUnauthorized()
            else {
                $('#notification-note').dataset.tone = 'bad'
                $('#notification-note').textContent = `读取失败：${error.message}`
            }
        } finally {
            busy = false
        }
    }

    $('#notification-provider').addEventListener('change', () => {
        $('#notification-token').value = ''
        $('#notification-clear').checked = false
        syncProvider()
        void refreshPreview()
    })
    $('#notification-token').addEventListener('input', () => {
        if ($('#notification-token').value.trim()) $('#notification-clear').checked = false
        syncProvider()
    })
    $('#notification-clear').addEventListener('change', () => {
        if ($('#notification-clear').checked) $('#notification-token').value = ''
        syncProvider()
    })
    $('#notification-server').addEventListener('input', syncProvider)

    $('#notify-preview-states')?.addEventListener('click', event => {
        const btn = event.target.closest('[data-state]')
        if (!btn) return
        previewState = btn.dataset.state
        for (const item of document.querySelectorAll('#notify-preview-states [data-state]')) {
            item.classList.toggle('is-active', item === btn)
        }
        void refreshPreview()
    })

    $('#notification-test')?.addEventListener('click', async () => {
        if (testing || busy) return
        testing = true
        const btn = $('#notification-test')
        const note = $('#notification-note')
        btn.disabled = true
        btn.textContent = '发送中…'
        note.dataset.tone = 'muted'
        note.textContent = '正在向渠道发送测试推送…'
        try {
            const result = await api('/api/notifications/test', { method: 'POST', body: { state: previewState } })
            if (result.view) data = { ...data, ...result.view }
            note.dataset.tone = 'ok'
            note.textContent = `测试推送已发送（${PROVIDER_BADGE[result.provider] || result.provider}），请在客户端查收。`
        } catch (error) {
            if (error.status === 401) return onUnauthorized()
            note.dataset.tone = 'bad'
            note.textContent = `测试推送失败：${error.message}`
        } finally {
            testing = false
            btn.textContent = '发送测试推送'
            syncProvider()
        }
    })

    $('#notification-form').addEventListener('submit', async event => {
        event.preventDefault()
        if (busy) return
        busy = true
        const saveBtn = $('#notification-save')
        saveBtn.disabled = true
        try {
            const provider = $('#notification-provider').value
            const server = $('#notification-server').value.trim()
            const clearServer = provider === 'bark' && !server && Boolean(data?.provider === 'bark' && data?.server)
            data = await api('/api/notifications', {
                method: 'PUT',
                body: {
                    enabled: $('#notification-enabled').checked,
                    provider,
                    onlyProblems: $('#notification-onlyProblems').checked,
                    token: $('#notification-token').value,
                    server,
                    clearToken: $('#notification-clear').checked,
                    clearServer
                }
            })
            render()
            const note = $('#notification-note')
            note.dataset.tone = 'ok'
            note.textContent = `已保存。${data.hasToken ? '可点「发送测试推送」验证。' : ''}`
        } catch (error) {
            if (error.status === 401) onUnauthorized()
            else {
                $('#notification-note').dataset.tone = 'bad'
                $('#notification-note').textContent = `未保存：${error.message}`
            }
        } finally {
            busy = false
            saveBtn.disabled = false
        }
    })

    return { load }
}
