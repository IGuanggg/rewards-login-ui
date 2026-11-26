import fs from 'node:fs'
import path from 'node:path'

// 每次 Control API 请求前刷新账号环境变量和国区词源模式，不触碰 API_TOKEN 等进程配置。
export function refreshAccountEnv(projectRoot) {
    const envFile = path.join(projectRoot, '.env')
    const raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : ''
    const accounts = {}
    for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*(ACCOUNT_[1-9]\d*_[A-Z0-9_]+)\s*=(.*)$/.exec(line)
        if (!match) continue
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        accounts[match[1]] = value
    }
    for (const key of Object.keys(process.env)) if (/^ACCOUNT_[1-9]\d*_/.test(key)) delete process.env[key]
    Object.assign(process.env, accounts)

    let mode = null
    const panelConfig = process.env.PANEL_CONFIG
    if (panelConfig) {
        try {
            const qm = JSON.parse(fs.readFileSync(path.join(path.dirname(panelConfig), 'query-mode.json'), 'utf8'))?.mode
            if (['china', 'china-local', 'existing'].includes(qm)) mode = qm
        } catch {}
    }
    if (!mode) {
        try {
            mode = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')).panelQueryMode
        } catch {}
    }
    process.env.PANEL_QUERY_MODE = ['china', 'china-local'].includes(mode) ? mode : 'existing'
}
