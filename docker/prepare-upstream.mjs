import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('Upstream root is required')
const file = path.join(root, 'scripts/api/server.js')
const source = fs.readFileSync(file, 'utf8')
const anchor = '        // index\n'
if (source.split(anchor).length !== 2) throw new Error('Upstream API changed; review account refresh integration before building')
fs.copyFileSync(fileURLToPath(new URL('./accounts-env.mjs', import.meta.url)), path.join(root, 'scripts/api/panel-accounts-env.mjs'))
fs.writeFileSync(file, "import { refreshAccountEnv } from './panel-accounts-env.mjs'\n" + source.replace(anchor, '        refreshAccountEnv(projectRoot)\n' + anchor))
