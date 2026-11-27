import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('Upstream root is required')

const { LOCAL_TOPICS } = await import('../lib/china-queries.mjs')
const chinaSource = fileURLToPath(new URL('../lib/china-queries.mjs', import.meta.url))
const envHelperSource = fileURLToPath(new URL('./accounts-env.mjs', import.meta.url))

const v5Server = path.join(root, 'dist/control-api/server.js')
const v4Server = path.join(root, 'scripts/api/server.js')

if (fs.existsSync(v5Server)) {
    // ── 上游 v5.0.0 适配 ──
    const apiSource = fs.readFileSync(v5Server, 'utf8')
    if (apiSource.includes('panel-accounts-env.mjs')) throw new Error('Upstream already patched; build from clean pinned source')
    const apiAnchor = 'async function requestHandler(req, res) {'
    if (apiSource.split(apiAnchor).length !== 2) throw new Error('Upstream v5 control-api changed; review account refresh integration')

    const queryEngineFile = path.join(root, 'dist/rewards/shared/query/QueryEngine.js')
    const querySourcesFile = path.join(root, 'dist/rewards/shared/query/QuerySources.js')
    const utilsFile = path.join(root, 'dist/util/Utils.js')

    const queryEngine = fs.readFileSync(queryEngineFile, 'utf8')
    const querySources = fs.readFileSync(querySourcesFile, 'utf8')
    const utils = fs.readFileSync(utilsFile, 'utf8')

    const fetchAnchor = 'async fetchTopics(options = {}) {'
    const localAnchor = "getLocalQueryList(language = 'en') {"
    const waitAnchor = 'async wait(time, signal = this.getSignal()) {'

    if (queryEngine.split(fetchAnchor).length !== 2) throw new Error('Upstream v5 QueryEngine changed; review China adapter')
    if (querySources.split(localAnchor).length !== 2) throw new Error('Upstream v5 QuerySources changed; review China adapter')
    if (utils.split(waitAnchor).length !== 2) throw new Error('Upstream v5 Utils.wait changed; review progress adapter')

    const queryDir = path.dirname(queryEngineFile)
    fs.copyFileSync(chinaSource, path.join(queryDir, 'panel-china.mjs'))
    fs.writeFileSync(path.join(queryDir, 'panel-china-version.json'), JSON.stringify({ version: 2, upstream: 'v5' }))

    const fetchInject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) {
            const { chinaTopics } = await import('./panel-china.mjs');
            const offline = process.env.PANEL_QUERY_MODE === 'china-local';
            const words = await chinaTopics({ offline, report: message => this.bot.logger.info(this.bot.isMobile, 'PANEL-QUERY', message) });
            const topics = words.map((text, sourceRank) => ({ text, source: offline ? 'panel.china-local' : 'panel.china', sourceUrl: 'panel://china-queries', kind: 'trend', language: 'zh', country: 'CN', sourceRank }));
            return options.shuffle ? this.bot.utils.shuffleArray(topics) : topics;
        }
`
    const localInject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) {
            return ${JSON.stringify(LOCAL_TOPICS)}.map((text, sourceRank) => ({ text, source: 'local', sourceUrl: 'src/data/search-queries.json', kind: 'evergreen', language: 'zh', country: 'CN', sourceRank }));
        }
`
    const waitInject = `
        const panelMs = typeof time === 'string' ? this.parseDuration(time) : time;
        if (Number.isFinite(panelMs) && panelMs >= 30000) console.log('__PANEL_WAIT__' + JSON.stringify({ seconds: Math.ceil(panelMs / 1000), sinceTs: Date.now() }));
`

    fs.writeFileSync(queryEngineFile, queryEngine.replace(fetchAnchor, fetchAnchor + fetchInject))
    fs.writeFileSync(querySourcesFile, querySources.replace(localAnchor, localAnchor + localInject))
    fs.writeFileSync(utilsFile, utils.replace(waitAnchor, waitAnchor + waitInject))

    // 国内网络访问 www.bing.com 会 302 到 cn.bing.com，允许纯接口模式在 cn.bing.com 上继续完成搜索与上报
    const bingClientFile = path.join(root, 'dist/rewards/shared/http/BingClient.js')
    if (fs.existsSync(bingClientFile)) {
        const bingClient = fs.readFileSync(bingClientFile, 'utf8')
        const reqOriginAnchor = 'if (new URL(config.url).origin !== urls_1.URLs.bing.origin)'
        const resOriginAnchor = 'if (new URL(response.url).origin !== urls_1.URLs.bing.origin)'
        if (bingClient.split(reqOriginAnchor).length !== 2 || bingClient.split(resOriginAnchor).length !== 2) {
            throw new Error('Upstream v5 BingClient changed; review cn.bing.com adapter')
        }
        fs.writeFileSync(
            bingClientFile,
            bingClient
                .replace(reqOriginAnchor, "if (![urls_1.URLs.bing.origin, 'https://cn.bing.com'].includes(new URL(config.url).origin))")
                .replace(resOriginAnchor, "if (![urls_1.URLs.bing.origin, 'https://cn.bing.com'].includes(new URL(response.url).origin))")
        )
    }

    const bingSearchApiFile = path.join(root, 'dist/rewards/api/search/BingSearchApi.js')
    if (fs.existsSync(bingSearchApiFile)) {
        const bingSearchApi = fs.readFileSync(bingSearchApiFile, 'utf8').replace(/\r\n/g, '\n')
        const reportAnchor = [
            '        const reportUrl = `${urls_1.URLs.bing.origin}/rewardsapp/reportActivity?${params.toString()}`;',
            '        const reportResponse = await this.client.request({',
            '            url: reportUrl,',
            "            method: 'POST',",
            '            headers: {',
            "                Accept: '*/*',",
            "                'Content-Type': 'application/x-www-form-urlencoded',",
            '                Referer: searchUrl,',
            '                Origin: urls_1.URLs.bing.origin,',
            "                'X-Requested-With': 'XMLHttpRequest'",
            '            },',
            "            data: new URLSearchParams({ url: searchUrl, V: 'web' }).toString(),"
        ].join('\n')
        if (bingSearchApi.split(reportAnchor).length !== 2) {
            throw new Error('Upstream v5 BingSearchApi changed; review cn.bing.com reportActivity adapter')
        }
        const reportReplacement = [
            '        const activeBingOrigin = searchResponse.url ? new URL(searchResponse.url).origin : urls_1.URLs.bing.origin;',
            '        const effectiveSearchUrl = searchResponse.url || searchUrl;',
            '        const reportUrl = `${activeBingOrigin}/rewardsapp/reportActivity?${params.toString()}`;',
            '        const reportResponse = await this.client.request({',
            '            url: reportUrl,',
            "            method: 'POST',",
            '            headers: {',
            "                Accept: '*/*',",
            "                'Content-Type': 'application/x-www-form-urlencoded',",
            '                Referer: effectiveSearchUrl,',
            '                Origin: activeBingOrigin,',
            "                'X-Requested-With': 'XMLHttpRequest'",
            '            },',
            "            data: new URLSearchParams({ url: effectiveSearchUrl, V: 'web' }).toString(),"
        ].join('\n')
        fs.writeFileSync(bingSearchApiFile, bingSearchApi.replace(reportAnchor, reportReplacement))
    }

    fs.copyFileSync(envHelperSource, path.join(root, 'dist/control-api/panel-accounts-env.mjs'))
    fs.writeFileSync(
        v5Server,
        "import { refreshAccountEnv } from './panel-accounts-env.mjs'\n" +
            apiSource.replace(apiAnchor, apiAnchor + '\n    refreshAccountEnv(projectRoot)')
    )
} else if (fs.existsSync(v4Server)) {
    // ── 上游 v4.x 兼容适配 ──
    const source = fs.readFileSync(v4Server, 'utf8')
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
    fs.copyFileSync(chinaSource, path.join(root, 'dist/functions/panel-china.mjs'))
    const inject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) {
            const { chinaTopics } = await import('./panel-china.mjs');
            const topics = await chinaTopics({ offline: process.env.PANEL_QUERY_MODE === 'china-local',
                report: message => this.bot.logger.info(this.bot.isMobile, 'PANEL-QUERY', message) });
            return options.shuffle ? this.bot.utils.shuffleArray(topics) : topics;
        }
`
    const localInject = `
        if (['china', 'china-local'].includes(process.env.PANEL_QUERY_MODE)) return ${JSON.stringify(LOCAL_TOPICS)};
`
    fs.writeFileSync(queryFile, query.replace(queryAnchor, queryAnchor + inject).replace(localAnchor, localAnchor + localInject))
    fs.writeFileSync(utilsFile, utils.replace(waitAnchor, waitAnchor + `
        const panelMs = typeof time === 'string' ? this.stringToNumber(time) : time;
        if (Number.isFinite(panelMs) && panelMs >= 30000) console.log('__PANEL_WAIT__' + JSON.stringify({ seconds: Math.ceil(panelMs / 1000), sinceTs: Date.now() }));
`))
    fs.writeFileSync(path.join(root, 'scripts/api/panel-china-version.json'), JSON.stringify({ version: 1, upstream: 'v4' }))
    fs.copyFileSync(envHelperSource, path.join(root, 'scripts/api/panel-accounts-env.mjs'))
    fs.writeFileSync(v4Server, "import { refreshAccountEnv } from './panel-accounts-env.mjs'\n" + source.replace(anchor, '        refreshAccountEnv(projectRoot)\n' + anchor))
} else {
    throw new Error('Upstream control-api server not found (expected dist/control-api/server.js or scripts/api/server.js)')
}
