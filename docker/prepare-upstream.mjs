import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('Upstream root is required')
const file = path.join(root, 'scripts/api/server.js')
const source = fs.readFileSync(file, 'utf8')
if (source.includes('panel-accounts-env.mjs')) throw new Error('Upstream already patched; build from clean pinned source')
const anchor = '        // index\n'
if (source.split(anchor).length !== 2) throw new Error('Upstream API changed; review account refresh integration before building')
const queryFile = path.join(root, 'dist/functions/QueryEngine.js')
const query = fs.readFileSync(queryFile, 'utf8')
const utilsFile = path.join(root, 'dist/util/Utils.js')
const utils = fs.readFileSync(utilsFile, 'utf8')
const waitAnchor = 'async wait(time) {'
if (utils.split(waitAnchor).length !== 2) throw new Error('Upstream wait implementation changed; review progress adapter before building')
const queryAnchor = 'async queryManager(options = {}) {'
const localAnchor = 'getLocalQueryList() {'
if (query.split(queryAnchor).length !== 2 || query.split(localAnchor).length !== 2) throw new Error('Upstream query engine changed; review China adapter before building')
fs.copyFileSync(fileURLToPath(new URL('../lib/china-queries.mjs', import.meta.url)), path.join(root, 'dist/functions/panel-china.mjs'))
const inject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) {
            const { chinaTopics } = await import('./panel-china.mjs');
            const topics = await chinaTopics({ offline: process.env.PANEL_QUERY_MODE === 'china-local',
                report: message => this.bot.logger.info(this.bot.isMobile, 'PANEL-QUERY', message) });
            return options.shuffle ? this.bot.utils.shuffleArray(topics) : topics;
        }
`
// Local queries used by activities also receive the offline Chinese list.
const localInject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) return ${JSON.stringify((await import('../lib/china-queries.mjs')).LOCAL_TOPICS)};
`
fs.writeFileSync(queryFile, query.replace(queryAnchor, queryAnchor + inject).replace(localAnchor, localAnchor + localInject))
fs.writeFileSync(utilsFile, utils.replace(waitAnchor, waitAnchor + `
        const panelMs = typeof time === 'string' ? this.stringToNumber(time) : time;
        if (Number.isFinite(panelMs) && panelMs >= 30000) console.log('__PANEL_WAIT__' + JSON.stringify({ seconds: Math.ceil(panelMs / 1000), sinceTs: Date.now() }));
`))
fs.writeFileSync(path.join(root, 'scripts/api/panel-china-version.json'), JSON.stringify({ version: 1 }))
fs.copyFileSync(fileURLToPath(new URL('./accounts-env.mjs', import.meta.url)), path.join(root, 'scripts/api/panel-accounts-env.mjs'))
fs.writeFileSync(file, "import { refreshAccountEnv } from './panel-accounts-env.mjs'\n" + source.replace(anchor, '        refreshAccountEnv(projectRoot)\n' + anchor))
