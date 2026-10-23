import fs from 'node:fs'
import path from 'node:path'

// The API otherwise caches .env on startup. Refresh only account fields, keeping
// API tokens and other process settings out of the editable account file.
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
}
