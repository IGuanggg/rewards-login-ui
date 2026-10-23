import http from 'node:http'

// The backend is loopback-only and only exists during a manual login. Both
// static assets and the WebSocket use the panel's existing authenticated session.
export function createDesktopProxy({ authenticated, active, port = 6080 }) {
    const sockets = new Set()
    const requests = new Set()
    const rejectSocket = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    const track = socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('error', () => socket.destroy())
    }
    function close() {
        for (const request of requests) request.destroy()
        for (const socket of sockets) socket.destroy()
        requests.clear()
        sockets.clear()
    }
    function handle(req, res, url) {
        if (!authenticated(req)) { res.writeHead(401); return res.end('请先返回面板输入访问密码。') }
        if (!active()) { res.writeHead(409); return res.end('远程浏览器尚未就绪或授权已结束。') }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end() }
        if (url.pathname === '/desktop') { res.writeHead(302, { Location: '/desktop/' }); return res.end() }
        const upstream = http.request({
            host: '127.0.0.1', port, method: req.method,
            path: (url.pathname.slice('/desktop'.length) || '/') + url.search,
            headers: { Host: `127.0.0.1:${port}` }
        }, response => {
            res.writeHead(response.statusCode || 502, {
                'Content-Type': response.headers['content-type'] || 'application/octet-stream',
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer'
            })
            response.pipe(res)
        })
        requests.add(upstream)
        upstream.on('close', () => requests.delete(upstream))
        upstream.setTimeout(10000, () => upstream.destroy())
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502)
            res.end('远程浏览器连接失败，请回到面板查看授权日志。')
        })
        res.on('close', () => upstream.destroy())
        upstream.end()
    }
    function upgrade(req, socket, head) {
        let url
        try { url = new URL(req.url, 'http://panel.local') } catch { return rejectSocket(socket, '400 Bad Request') }
        if (url.pathname !== '/desktop/websockify') return rejectSocket(socket, '404 Not Found')
        if (!authenticated(req)) return rejectSocket(socket, '401 Unauthorized')
        let origin
        try { origin = new URL(req.headers.origin) } catch { return rejectSocket(socket, '403 Forbidden') }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) return rejectSocket(socket, '403 Forbidden')
        if (!active()) return rejectSocket(socket, '409 Conflict')
        track(socket)
        const headers = { Host: `127.0.0.1:${port}`, Connection: 'Upgrade', Upgrade: 'websocket' }
        for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
            if (req.headers[name]) headers[name] = req.headers[name]
        }
        const upstream = http.request({ host: '127.0.0.1', port, path: '/websockify', headers })
        requests.add(upstream)
        upstream.on('close', () => requests.delete(upstream))
        upstream.setTimeout(10000, () => upstream.destroy())
        upstream.on('upgrade', (response, backend, backendHead) => {
            track(backend)
            backend.setTimeout(0)
            socket.setTimeout(0)
            if (socket.destroyed || !authenticated(req) || !active()) return backend.destroy()
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce((all, value, i, raw) => i % 2 ? all : all + `${value}: ${raw[i + 1]}\r\n`, '') + '\r\n')
            if (head.length) backend.write(head)
            if (backendHead.length) socket.write(backendHead)
            socket.pipe(backend).pipe(socket)
            socket.once('close', () => backend.destroy())
            backend.once('close', () => socket.destroy())
        })
        upstream.on('response', response => { response.resume(); rejectSocket(socket, '502 Bad Gateway') })
        upstream.on('error', () => { if (!socket.destroyed) rejectSocket(socket, '502 Bad Gateway') })
        socket.once('close', () => upstream.destroy())
        upstream.end()
    }
    return { handle, upgrade, close }
}
