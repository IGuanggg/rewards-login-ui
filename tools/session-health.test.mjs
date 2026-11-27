import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    inspectCookieHealth,
    recordSessionHealth,
    readSessionHealthMap,
    clearSessionHealth,
    detectRuntimeSessionInvalidations,
    probeBingSession,
    collectSessionAlerts
} from '../lib/session-health.mjs'
import {
    saveNotifications,
    formatRunNotification,
    formatSessionAlertNotification,
    notifySessionAlerts,
    sendTestNotification
} from '../lib/notifications.mjs'

function tempPanel(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-session-health-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return path.join(dir, 'panel.json')
}

test('inspectCookieHealth classifies valid, expiring, expired, missing, and auto-clears stale overlays after re-login', () => {
    const now = Date.parse('2026-11-27T02:00:00Z')
    const sec = days => Math.floor((now + days * 86400000) / 1000)

    const valid = inspectCookieHealth(JSON.stringify({
        cookies: [
            { name: '_U', value: 'u1', domain: '.bing.com', expires: sec(14) },
            { name: 'WLSSC', value: 'w1', domain: '.live.com', expires: sec(365) }
        ]
    }), { updatedAt: now - 1000, now })
    assert.equal(valid.status, 'valid')
    assert.equal(valid.daysLeft, 14)

    const expiring = inspectCookieHealth(JSON.stringify({
        cookies: [
            { name: '_U', value: 'u1', domain: '.bing.com', expires: sec(2) },
            { name: 'WLSSC', value: 'w1', domain: '.live.com', expires: sec(365) }
        ]
    }), { updatedAt: now - 1000, now })
    assert.equal(expiring.status, 'expiring')
    assert.match(expiring.reason, /2 天/)

    const expired = inspectCookieHealth(JSON.stringify({
        cookies: [
            { name: '_U', value: 'u1', domain: '.bing.com', expires: sec(-1) },
            { name: 'WLSSC', value: 'w1', domain: '.live.com', expires: sec(-2) }
        ]
    }), { updatedAt: now - 1000, now })
    assert.equal(expired.status, 'expired')

    const synthetic = inspectCookieHealth(JSON.stringify({ cookies: [{ name: 'a', value: '1' }] }), { updatedAt: now, now })
    assert.equal(synthetic.status, 'valid')

    // Invalid overlay applies when session has NOT been refreshed since detection
    const invalidNow = inspectCookieHealth(JSON.stringify({
        cookies: [{ name: '_U', value: 'u1', domain: '.bing.com', expires: sec(14) }]
    }), {
        updatedAt: now - 5000,
        now,
        overlay: { status: 'invalid', reason: 'Bing 会话已失效', sessionUpdatedAt: now - 5000, checkedAt: now - 1000, source: 'probe' }
    })
    assert.equal(invalidNow.status, 'invalid')

    // Once user re-authorizes (updatedAt > overlay.sessionUpdatedAt), stale invalid overlay auto-clears
    const refreshed = inspectCookieHealth(JSON.stringify({
        cookies: [{ name: '_U', value: 'u2', domain: '.bing.com', expires: sec(14) }]
    }), {
        updatedAt: now,
        now,
        overlay: { status: 'invalid', reason: 'Bing 会话已失效', sessionUpdatedAt: now - 5000, checkedAt: now - 1000, source: 'probe' }
    })
    assert.equal(refreshed.status, 'valid')
})

test('detectRuntimeSessionInvalidations flags real auth failures and ignores cn.bing.com redirect or cancellation', () => {
    const falseAlarms = detectRuntimeSessionInvalidations(
        {
            accounts: [
                { email: 'a@example.com', error: 'Search: Bing request left the authenticated Bing session; Punchcard: quest children unavailable' },
                { email: 'b@example.com', error: 'Run cancelled' }
            ]
        },
        [
            { account: 'a@example.com', platform: 'DESKTOP', level: 'error', title: 'SEARCH-BING', message: 'Error in doSearch | Bing request left the authenticated Bing session' }
        ]
    )
    assert.equal(falseAlarms.length, 0)

    const real = detectRuntimeSessionInvalidations(
        {
            accounts: [
                { email: 'c@example.com', error: 'Login failed or aborted at state: SIGN_IN_METHOD_PICKER' }
            ]
        },
        [
            { account: 'c@example.com', platform: 'DESKTOP', level: 'error', title: 'LOGIN', message: 'Login failed or aborted at state: SIGN_IN_METHOD_PICKER' }
        ]
    )
    assert.equal(real.length, 1)
    assert.equal(real[0].email, 'c@example.com')
    assert.equal(real[0].platform, 'desktop')
    assert.equal(real[0].status, 'invalid')
})

test('probeBingSession follows www.bing.com -> cn.bing.com, distinguishes valid/invalid/redirect/network error', async () => {
    const now = Date.parse('2026-11-27T02:00:00Z')
    const validStorage = JSON.stringify({
        cookies: [{ name: '_U', value: 'secret', domain: '.bing.com', expires: Math.floor((now + 86400000 * 10) / 1000) }]
    })

    // 1. Valid cookie via 302 www.bing.com -> cn.bing.com
    let hops = 0
    const ok = await probeBingSession({
        storageState: validStorage,
        now,
        fetcher: async url => {
            hops++
            if (url.startsWith('https://www.bing.com/')) {
                return new Response('', { status: 302, headers: { location: 'https://cn.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards' } })
            }
            return new Response(JSON.stringify({ userInfo: { isRewardsUser: true, balance: 14156 } }), { status: 200 })
        }
    })
    assert.equal(hops, 2)
    assert.equal(ok.status, 'valid')
    assert.equal(ok.balance, 14156)

    // 2. Invalid cookie: isRewardsUser=false
    const invalid = await probeBingSession({
        storageState: validStorage,
        now,
        fetcher: async () => new Response(JSON.stringify({ userInfo: { isRewardsUser: false, balance: 0 } }), { status: 200 })
    })
    assert.equal(invalid.status, 'invalid')

    // 3. Redirected to login.live.com -> invalid
    const loginRedir = await probeBingSession({
        storageState: validStorage,
        now,
        fetcher: async () => new Response('', { status: 302, headers: { location: 'https://login.live.com/login.srf' } })
    })
    assert.equal(loginRedir.status, 'invalid')

    // 4. Network timeout -> error (never false invalid)
    const netErr = await probeBingSession({
        storageState: validStorage,
        now,
        fetcher: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }
    })
    assert.equal(netErr.status, 'error')
})

test('session health persistence, alert notifications, daily dedup and run-summary alert block work end-to-end', async t => {
    const panel = tempPanel(t)
    recordSessionHealth(panel, [{ email: 'user@example.com', platform: 'desktop', status: 'invalid', reason: 'Bing 会话已失效', sessionUpdatedAt: 1000, checkedAt: 2000, source: 'probe' }])
    assert.equal(readSessionHealthMap(panel)['user@example.com'].desktop.status, 'invalid')
    clearSessionHealth(panel, 'user@example.com', ['desktop'])
    assert.equal(readSessionHealthMap(panel)['user@example.com'], undefined)

    const alerts = collectSessionAlerts([
        { email: 'user@example.com', sessions: { mobile: { status: 'valid', daysLeft: 14 }, desktop: { status: 'invalid', reason: '会话已失效' } } }
    ])
    assert.equal(alerts.length, 1)

    // Run summary includes masked CK alert callout and upgrades Bark to timeSensitive
    const runBark = formatRunNotification('bark', {
        day: '2026-11-27', state: 'partial', points: 75,
        accounts: [{ email: 'user@example.com', success: false, collectedPoints: 75, finalPoints: 5000 }],
        sessionAlerts: alerts
    })
    assert.equal(runBark.level, 'timeSensitive')
    assert.match(runBark.title, /CK 失效/)
    assert.match(runBark.body, /use\*\*\*@example\.com/)
    assert.ok(!runBark.body.includes('user@example.com'))

    // Dedicated session alert formatting across all 3 channels
    for (const provider of ['pushplus', 'serverchan', 'bark']) {
        const formatted = formatSessionAlertNotification(provider, alerts, { day: '2026-11-27', source: 'check' })
        const raw = JSON.stringify(formatted)
        assert.match(raw, /use\*\*\*@example\.com/)
        assert.ok(!raw.includes('user@example.com'))
    }

    // Daily deduplication: first auto alert sends, second on same day skips, force resends
    saveNotifications(panel, { provider: 'pushplus', enabled: true, onlyProblems: true, sessionAlerts: true, token: 'synthetic-token-123456' })
    let sentCount = 0
    const fetcher = async () => { sentCount++; return new Response(JSON.stringify({ code: 200 }), { status: 200 }) }
    const now = Date.parse('2026-11-27T01:00:00Z')
    assert.equal((await notifySessionAlerts(panel, alerts, { source: 'schedule', fetcher, now })).sent, true)
    assert.equal((await notifySessionAlerts(panel, alerts, { source: 'schedule', fetcher, now })).skipped, true)
    assert.equal((await notifySessionAlerts(panel, alerts, { source: 'check', force: true, fetcher, now })).sent, true)
    assert.equal(sentCount, 2)

    // Test push supports state=session_alert
    const testRes = await sendTestNotification(panel, { state: 'session_alert', fetcher })
    assert.equal(testRes.sent, true)
    assert.equal(sentCount, 3)

    // Disabling sessionAlerts skips automatic session alert
    saveNotifications(panel, { provider: 'pushplus', enabled: true, onlyProblems: false, sessionAlerts: false, token: '' })
    assert.equal((await notifySessionAlerts(panel, alerts, { force: true, fetcher, now })).skipped, true)
})
