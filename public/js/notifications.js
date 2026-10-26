export function createNotifications({ api, onUnauthorized }) {
    const $ = s => document.querySelector(s)
    let busy = false, data
    const isBark = () => $('#notification-provider').value === 'bark'
    function syncProvider() {
        const bark = isBark()
        const wrap = $('#notification-server-field')
        if (wrap) wrap.hidden = !bark
        const label = $('#notification-token-label')
        if (label) label.textContent = bark ? '设备密钥' : '渠道密钥'
        const input = $('#notification-token')
        const saved = bark ? data && data.hasToken : data && data.hasToken
        input.placeholder = bark
            ? (saved ? '已保存设备密钥，留空保留；填写可替换' : '填入 Bark 设备密钥')
            : (saved ? '已保存密钥，留空保留；填写可替换' : '填入 Token / SendKey')
    }
    function render() {
        $('#notification-enabled').checked = data.enabled
        $('#notification-provider').value = data.provider
        $('#notification-onlyProblems').checked = data.onlyProblems
        $('#notification-token').value = ''
        $('#notification-server').value = data.server || ''
        $('#notification-clear').checked = false
        syncProvider()
        $('#notification-fields').disabled = !data.supported
    }
    async function load() {
        if (busy) return
        busy = true
        try {
            data = await api('/api/notifications'); render()
            const last = data.last ? ` 上次发送${data.last.state === 'sent' ? '已被渠道接受' : '失败，请检查密钥和渠道配额'}（${new Date(data.last.at).toLocaleString('zh-CN')}）。` : ''
            $('#notification-note').textContent = (!data.supported ? '本地预览不支持通知。' : data.enabled ? '已开启。' : '') + last
        }
        catch (error) { if (error.status === 401) onUnauthorized(); else $('#notification-note').textContent = `读取失败：${error.message}` }
        finally { busy = false }
    }
    $('#notification-provider').addEventListener('change', () => { $('#notification-token').value = ''; syncProvider() })
    $('#notification-form').addEventListener('submit', async event => {
        event.preventDefault()
        if (busy) return
        busy = true; $('#notification-save').disabled = true
        try {
            data = await api('/api/notifications', { method: 'PUT', body: { enabled: $('#notification-enabled').checked,
                provider: $('#notification-provider').value, onlyProblems: $('#notification-onlyProblems').checked,
                token: $('#notification-token').value, server: $('#notification-server').value,
                clearToken: $('#notification-clear').checked } })
            render(); $('#notification-note').textContent = '已保存'
        } catch (error) { if (error.status === 401) onUnauthorized(); else $('#notification-note').textContent = `未保存：${error.message}` }
        finally { busy = false; $('#notification-save').disabled = false }
    })
    return { load }
}
