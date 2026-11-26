import fs from 'node:fs'
import path from 'node:path'

export const WORKERS = {
    doDailySet: '每日任务', doDailyCheckIn: '每日签到', doReadToEarn: '阅读赚积分',
    doMorePromotions: '更多活动', doAppPromotions: '应用活动', doPunchCards: '集章任务',
    doClaimBonusPoints: '奖励积分', doDesktopSearch: '电脑端搜索', doMobileSearch: '手机端搜索',
    doActivateSearchPerk: '激活搜索奖励', doBonusSearches: '额外搜索', doVisualSearch: '图片搜索'
}

const problem = message => Object.assign(new Error(message), { status: 422 })
const scheduleFile = panelFile => path.join(path.dirname(panelFile), 'schedule.json')
const queryModeFile = panelFile => path.join(path.dirname(panelFile), 'query-mode.json')
export const scheduleMarkerFile = panelFile => path.join(path.dirname(panelFile), 'last-scheduled-date')

function readScheduleMarker(panelFile) {
    if (!panelFile) return ''
    const file = scheduleMarkerFile(panelFile)
    try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '' } catch { return '' }
}

export function readQueryMode(panelFile, config = null) {
    if (panelFile) {
        const file = queryModeFile(panelFile)
        if (fs.existsSync(file)) {
            try {
                const mode = JSON.parse(fs.readFileSync(file, 'utf8'))?.mode
                if (['china', 'china-local', 'existing'].includes(mode)) return mode
            } catch {}
        }
    }
    if (['china', 'china-local'].includes(config?.panelQueryMode)) return config.panelQueryMode
    return null
}

function isV5Upstream(dir, config) {
    if (fs.existsSync(path.join(dir, 'dist/control-api/server.js'))) return true
    if (fs.existsSync(path.join(dir, 'scripts/lib/commandUtils.js'))) return true
    return 'rewardsMode' in config || 'continueOnBotWarning' in config || 'taskDelay' in config || 'ensureStreakProtection' in config
}

function hasChinaAdapter(dir) {
    return (
        fs.existsSync(path.join(dir, 'dist/rewards/shared/query/panel-china-version.json')) ||
        fs.existsSync(path.join(dir, 'scripts/api/panel-china-version.json'))
    )
}

export function readSchedule(panelFile) {
    const file = scheduleFile(panelFile)
    const runAt = String(process.env.RUN_AT || '').trim()
    const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { enabled: Boolean(runAt), runAt: runAt || '09:00' }
    if (typeof value.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.runAt)) throw problem('定时配置无效，请重新保存定时设置。')
    const schedule = { enabled: value.enabled, runAt: value.runAt, timezone: process.env.TZ || 'Asia/Shanghai' }
    return { ...schedule, nextAt: nextSchedule(schedule, Date.now(), readScheduleMarker(panelFile)) }
}

export function nextSchedule(schedule, now = Date.now(), lastDate = '') {
    if (!schedule.enabled) return null
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: schedule.timezone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' })
    const localNow = fmt.format(new Date(now))
    const [date] = localNow.split(' ')
    const offset = Date.parse(localNow.replace(' ', 'T') + 'Z') - Math.floor(now / 1000) * 1000
    let candidate = Date.parse(`${date}T${schedule.runAt}:00Z`) - offset
    if (candidate <= now || (lastDate && date === lastDate)) candidate += 86400000
    // Re-evaluate the offset at the target, including DST transitions.
    const targetLocal = fmt.format(new Date(candidate))
    const targetOffset = Date.parse(targetLocal.replace(' ', 'T') + 'Z') - candidate
    candidate += offset - targetOffset
    return new Date(candidate).toISOString()
}

export function scheduleDate(schedule, now = Date.now(), lastDate = '') {
    if (!schedule.enabled) return null
    const formatted = new Intl.DateTimeFormat('sv-SE', { timeZone: schedule.timezone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(now))
    const [date, time] = formatted.split(' ')
    return time === schedule.runAt && date !== lastDate ? date : null
}

function seconds(value) {
    const match = /^(\d+(?:\.\d+)?)(ms|sec|min|hr|h|s|m)?$/.exec(String(value ?? '').trim())
    return match ? Number(match[1]) * ({ ms: .001, sec: 1, s: 1, min: 60, m: 60, hr: 3600, h: 3600 }[match[2]] || 1) : null
}

export function readTaskSettings(dir, panelFile) {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    const v5 = isV5Upstream(dir, config)
    const workers = Object.entries(WORKERS).filter(([key]) => typeof config.workers?.[key] === 'boolean').map(([key, label]) => ({ key, label, enabled: config.workers[key] }))
    const savedMode = readQueryMode(panelFile, config)
    const queryMode = ['china', 'china-local'].includes(savedMode)
        ? savedMode
        : config.searchSettings?.queryEngines?.length === 1 && config.searchSettings.queryEngines[0] === 'local'
          ? 'local'
          : 'existing'
    const continueWarning = config.continueOnBotWarning ?? config.contintueOnBotWarning
    return {
        workers,
        v5Supported: v5,
        chinaSupported: hasChinaAdapter(dir),
        rewardsMode: ['api', 'browser'].includes(config.rewardsMode) ? config.rewardsMode : 'browser',
        ensureStreakProtection: config.ensureStreakProtection === true,
        taskDelay: { min: seconds(config.taskDelay?.min) ?? 15, max: seconds(config.taskDelay?.max) ?? 30 },
        readDelay: { min: seconds(config.searchSettings?.readDelay?.min) ?? 30, max: seconds(config.searchSettings?.readDelay?.max) ?? 60 },
        searchDelay: { min: seconds(config.searchSettings?.searchDelay?.min), max: seconds(config.searchSettings?.searchDelay?.max) },
        accountDelay: { min: seconds(config.accountDelay?.min), max: seconds(config.accountDelay?.max) },
        queryMode,
        stopOnWarning: continueWarning !== true,
        skipNonPointTasks: config.skipNonPointTasks === true,
        schedule: readSchedule(panelFile)
    }
}

function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const target = fs.existsSync(file) ? fs.realpathSync(file) : file
    const temp = `${target}.panel-tmp`
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 4) + '\n', { mode: 0o600 }); fs.renameSync(temp, target) }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

export function writeTaskSettings(dir, panelFile, body, { scheduling = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('设置格式不正确。')
    const file = path.join(dir, 'config.json')
    const original = JSON.parse(fs.readFileSync(file, 'utf8'))
    const config = structuredClone(original)
    const v5 = isV5Upstream(dir, original)
    const available = Object.keys(WORKERS).filter(key => typeof config.workers?.[key] === 'boolean')
    if (!body.workers || Object.keys(body.workers).some(key => !available.includes(key)) || available.some(key => typeof body.workers[key] !== 'boolean')) throw problem('任务开关不完整，请刷新设置后重试。')
    if (!Object.values(body.workers).some(Boolean)) throw problem('请至少开启一项签到任务。')
    const delayChecks = [
        ['searchDelay', 30],
        ['accountDelay', 0],
        ...(body.readDelay ? [['readDelay', 30]] : []),
        ...(body.taskDelay ? [['taskDelay', 0]] : [])
    ]
    for (const [key, minimum] of delayChecks) {
        const range = body[key]
        if (!range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < minimum || range.max < range.min || range.max > 3600) {
            throw problem(`${{ searchDelay: '搜索', readDelay: '阅读', accountDelay: '账号', taskDelay: '活动' }[key]}间隔应为 ${minimum}–3600 秒，最大值不能小于最小值。`)
        }
    }
    if (!['china', 'china-local', 'local', 'existing', 'default'].includes(body.queryMode) || typeof body.stopOnWarning !== 'boolean' || typeof body.skipNonPointTasks !== 'boolean') throw problem('运行设置格式不正确。')
    if (body.rewardsMode != null && !['api', 'browser'].includes(body.rewardsMode)) throw problem('运行模式只能选择纯接口模式或浏览器模式。')
    if (body.ensureStreakProtection != null && typeof body.ensureStreakProtection !== 'boolean') throw problem('连续签到保护开关格式不正确。')
    if (['china', 'china-local'].includes(body.queryMode) && !hasChinaAdapter(dir)) throw problem('当前内核尚未安装国区适配，请使用新版 Docker 镜像。')
    if (body.schedule && (!scheduling || typeof body.schedule.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.schedule.runAt))) throw problem('定时设置不正确，当前仅 Docker 实例支持面板定时。')

    config.workers = { ...config.workers, ...body.workers }
    config.searchSettings = { ...config.searchSettings, searchDelay: { min: `${body.searchDelay.min}sec`, max: `${body.searchDelay.max}sec` } }
    if (body.readDelay) config.searchSettings.readDelay = { min: `${body.readDelay.min}sec`, max: `${body.readDelay.max}sec` }

    // v5 config.json 采用 strict Zod 校验：不向其中写入自定义字段，改存入面板目录的 query-mode.json
    let nextQueryMode = null
    if (['china', 'china-local'].includes(body.queryMode)) {
        nextQueryMode = body.queryMode
        config.searchSettings.queryEngines = ['local']
        config.searchOnBingLocalQueries = true
        if (!v5) config.panelQueryMode = body.queryMode
        else delete config.panelQueryMode
    }
    if (['local', 'default', 'existing'].includes(body.queryMode)) {
        nextQueryMode = 'existing'
        if (!v5) config.panelQueryMode = 'existing'
        else delete config.panelQueryMode
    }
    if (body.queryMode === 'local') {
        config.searchSettings.queryEngines = ['local']
        config.searchOnBingLocalQueries = true
    }
    if (body.queryMode === 'default') {
        const example = JSON.parse(fs.readFileSync(path.join(dir, 'config.example.json'), 'utf8'))
        if (!Array.isArray(example.searchSettings?.queryEngines) || !example.searchSettings.queryEngines.length) throw problem('上游默认搜索词配置不存在，请保留当前来源。')
        config.searchSettings.queryEngines = example.searchSettings.queryEngines
        config.searchOnBingLocalQueries = example.searchOnBingLocalQueries === true
    }

    config.accountDelay = { min: `${body.accountDelay.min}sec`, max: `${body.accountDelay.max}sec` }
    if (v5) {
        if (body.rewardsMode) config.rewardsMode = body.rewardsMode
        if (typeof body.ensureStreakProtection === 'boolean') config.ensureStreakProtection = body.ensureStreakProtection
        if (body.taskDelay) config.taskDelay = { min: `${body.taskDelay.min}sec`, max: `${body.taskDelay.max}sec` }
        config.continueOnBotWarning = !body.stopOnWarning
        delete config.contintueOnBotWarning
        delete config.panelQueryMode
    } else {
        config.contintueOnBotWarning = !body.stopOnWarning
    }
    config.skipNonPointTasks = body.skipNonPointTasks

    let prevSchedule = null
    if (body.schedule && panelFile) {
        try { prevSchedule = readSchedule(panelFile) } catch {}
    }

    atomicJson(fs.realpathSync(file) + '.panel.bak', original)
    atomicJson(file, config)
    try {
        if (nextQueryMode && panelFile) atomicJson(queryModeFile(panelFile), { mode: nextQueryMode })
        if (body.schedule) {
            atomicJson(scheduleFile(panelFile), { enabled: body.schedule.enabled, runAt: body.schedule.runAt })
            const changedSchedule = !prevSchedule || prevSchedule.runAt !== body.schedule.runAt || (!prevSchedule.enabled && body.schedule.enabled)
            if (changedSchedule && panelFile) {
                const marker = scheduleMarkerFile(panelFile)
                if (fs.existsSync(marker)) { try { fs.unlinkSync(marker) } catch {} }
            }
        }
    } catch (error) {
        atomicJson(file, original)
        throw error
    }
    return readTaskSettings(dir, panelFile)
}
