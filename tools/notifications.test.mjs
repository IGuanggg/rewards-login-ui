import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { notificationConfig, notificationView, saveNotifications, notifyRun } from '../lib/notifications.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-notify-'))
const DEVICE_KEY = 'AbCdEfGh1234567890XyZ'
const SERVER = 'https://bark.example.com'

test('bark: 保存渠道配置并隐藏密钥', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    const view = saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: `${SERVER}/` })
    assert.equal(view.provider, 'bark')
    assert.equal(view.hasToken, true)
    assert.equal(view.server, SERVER, '末尾斜杠应被去掉')
    assert.equal('token' in view, false, '密钥不应回显')
    assert.equal(notificationConfig(panelFile).token, DEVICE_KEY)
})

test('bark: 启用时必须提供服务器地址', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    assert.throws(() => saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: '' }), error => error.status === 422 && /服务器地址/.test(error.message))
})

test('bark: 拒绝非 http(s) 协议', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    assert.throws(() => saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: 'ftp://bark.example.com' }), error => error.status === 422)
})

test('bark: 留空保留已存配置，填写则覆盖', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: SERVER })
    const kept = saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: '', server: '' })
    assert.equal(kept.server, SERVER)
    assert.equal(kept.hasToken, true)
    const replaced = saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: '', server: 'https://bark2.example.com' })
    assert.equal(replaced.server, 'https://bark2.example.com')
})

test('bark: 切换渠道后不保留服务器地址', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: SERVER })
    const view = saveNotifications(panelFile, { provider: 'pushplus', enabled: true, onlyProblems: false, token: 'abcdefgh12345678' })
    assert.equal(view.server, '')
})

test('bark: 推送请求体符合 Bark 接口', async () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: SERVER })
    let captured = null
    const fetcher = async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ code: 200, message: 'success' }) } }
    const result = await notifyRun(panelFile, { day: '2026-10-26', state: 'completed', points: 257, accounts: [1, 2] }, { fetcher })
    assert.equal(result.sent, true)
    assert.equal(captured.url, `${SERVER}/push`)
    assert.equal(captured.body.device_key, DEVICE_KEY)
    assert.equal(captured.body.title, 'Rewards 签到已完成')
    assert.match(captured.body.body, /257/)
    assert.equal(captured.body.group, 'Rewards 签到')
    assert.doesNotMatch(JSON.stringify(captured.body), /@|password|cookie/i, '摘要不得包含邮箱或凭据')
})

test('bark: 渠道拒绝时抛错并记录失败', async () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: SERVER })
    const fetcher = async () => ({ ok: true, json: async () => ({ code: 400, message: 'bad key' }) })
    await assert.rejects(() => notifyRun(panelFile, { day: '2026-10-26', state: 'failed', points: 0, accounts: [1] }, { fetcher }), /未接受消息/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notification-result.json'), 'utf8')).state, 'failed')
})

test('bark: 仅异常通知时跳过成功运行', async () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    saveNotifications(panelFile, { provider: 'bark', enabled: true, onlyProblems: true, token: DEVICE_KEY, server: SERVER })
    const fetcher = async () => { throw new Error('不应发起请求') }
    const result = await notifyRun(panelFile, { day: '2026-10-26', state: 'completed', points: 257, accounts: [1] }, { fetcher })
    assert.equal(result.skipped, true)
})

test('bark: 未配置服务器时跳过推送', async () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    fs.writeFileSync(path.join(dir, 'notifications.json'), JSON.stringify({ provider: 'bark', enabled: true, onlyProblems: false, token: DEVICE_KEY, server: '' }))
    const fetcher = async () => { throw new Error('不应发起请求') }
    const result = await notifyRun(panelFile, { day: '2026-10-26', state: 'completed', points: 257, accounts: [1] }, { fetcher })
    assert.equal(result.skipped, true)
})

test('其他渠道仍拒绝非法 provider', () => {
    const dir = tempDir(), panelFile = path.join(dir, 'config.json')
    assert.throws(() => saveNotifications(panelFile, { provider: 'telegram', enabled: true, onlyProblems: false, token: DEVICE_KEY }), error => error.status === 422)
})
