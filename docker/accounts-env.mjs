import fs from 'node:fs'
import path from 'node:path'

// Refresh account fields and the validated query profile for each API request.
// Keep API tokens and other process settings out of the editable account file.
export function refreshAccountEnv(projectRoot) {
    const raw = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')
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
    try {
        const mode = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')).panelQueryMode
        process.env.PANEL_QUERY_MODE = ['china', 'china-local'].includes(mode) ? mode : 'existing'
    } catch { process.env.PANEL_QUERY_MODE = 'existing' }
}
