'use strict';
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('./ws');
const assets = require('./assets');

let nextId = 1;

function startWeb(cfg, bridge) {
  const pin = String(cfg.web.pin || '');
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/': case '/index.html':
        return send(res, 200, 'text/html; charset=utf-8', assets.get('mixer.html'));
      case '/status':
        return send(res, 200, 'text/html; charset=utf-8', assets.get('status.html'));
      case '/manifest.json':
        return send(res, 200, 'application/manifest+json', JSON.stringify({
          name: 'Aux Mix', short_name: 'Aux Mix', display: 'standalone', start_url: '/',
          background_color: '#0e0f11', theme_color: '#0e0f11'
        }));
      case '/healthz':
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, console: bridge.console.connected }));
      default:
        return send(res, 404, 'text/plain', 'Not found');
    }
  });

  const wss = new WebSocketServer(server, '/ws');
  const clients = new Map(); // client -> { id, role, authed, log, aux }

  const broadcast = (obj, filter = () => true) => {
    const s = JSON.stringify(obj);
    for (const [c, info] of clients) if (info.authed && filter(info)) c.send(s);
  };

  // Put a mixer client on an aux (falls back to the default aux, then the first allowed one)
  const pickAux = (want) => {
    const n = Number(want);
    if (bridge.isAllowedAux(n)) return n;
    if (bridge.isAllowedAux(bridge.defaultAux)) return bridge.defaultAux;
    return bridge.availableAuxes()[0] || bridge.defaultAux;
  };
  const setAux = (c, info, want) => {
    const aux = pickAux(want);
    if (info.aux !== aux) {
      if (info.aux) bridge.unwatch(info.aux);
      info.aux = aux;
      bridge.watch(aux);
    }
    c.sendJSON({ t: 'state', ...bridge.stateSnapshot(aux) });
  };

  wss.on('connection', (c) => {
    const info = { id: nextId++, role: 'mixer', authed: false, log: false, aux: 0 };
    clients.set(c, info);
    c.on('close', () => { if (info.aux) bridge.unwatch(info.aux); clients.delete(c); pushStatus(); });
    c.on('message', (text) => {
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.t === 'hello') {
        if (pin && String(m.pin || '') !== pin) {
          c.sendJSON({ t: 'auth', ok: false, needPin: true });
          return;
        }
        info.authed = true;
        info.role = m.role === 'status' ? 'status' : 'mixer';
        c.sendJSON({ t: 'auth', ok: true, id: info.id, title: cfg.web.title || '' });
        if (info.role === 'mixer') setAux(c, info, m.aux);
        c.sendJSON({ t: 'status', ...statusWithClients() });
        if (info.role === 'status') c.sendJSON({ t: 'logHistory', entries: bridge.ring.slice(-300) });
        pushStatus();
        return;
      }
      if (!info.authed) return;
      if (m.t === 'set' && info.role === 'mixer') bridge.setLevel(info.aux, m.ch, m.db, info.id);
      else if (m.t === 'aux' && info.role === 'mixer') {
        setAux(c, info, bridge.isAllowedAux(Number(m.aux)) ? m.aux : info.aux); // refuse auxes that aren't offered
        pushStatus();
      }
      else if (m.t === 'log' && info.role === 'status') info.log = !!m.on;
      else if (m.t === 'resync' && info.role === 'status') bridge.fullSync();
    });
  });

  const statusWithClients = () => {
    const list = [...clients.entries()].filter(([, i]) => i.authed)
      .map(([c, i]) => ({ id: i.id, role: i.role, ip: c.ip, aux: i.aux }));
    return { ...bridge.statusSnapshot(), clients: list };
  };
  const pushStatus = () => broadcast({ t: 'status', ...statusWithClients() });
  const pushStates = () => {
    for (const [c, info] of clients) if (info.authed && info.role === 'mixer') c.sendJSON({ t: 'state', ...bridge.stateSnapshot(info.aux) });
  };

  bridge.on('level', e => broadcast({ t: 'level', aux: e.aux, ch: e.ch, db: e.db, src: e.source, origin: e.originId || 0 },
    i => i.role === 'mixer' && i.aux === e.aux));
  bridge.on('name', e => broadcast({ t: 'name', ch: e.ch, name: e.name }));
  let auxTimer = null; // aux names arrive one by one during a sync: send one update
  bridge.on('auxes', () => { if (!auxTimer) auxTimer = setTimeout(() => { auxTimer = null; auxesChanged(); }, 150); });
  const auxesChanged = () => {
    // If the aux list shrank, move anyone on a vanished aux back to a valid one
    for (const [c, info] of clients) if (info.authed && info.role === 'mixer' && !bridge.isAllowedAux(info.aux)) setAux(c, info, 0);
    for (const [c, info] of clients) if (info.authed && info.role === 'mixer')
      c.sendJSON({ t: 'auxes', auxes: bridge.auxList(), auxName: bridge.auxNames.get(info.aux) || '' });
    pushStatus();
  };
  bridge.on('layout', pushStates);
  bridge.on('status', () => { pushStatus(); pushStates(); });
  bridge.on('log', e => broadcast({ t: 'log', e }, i => i.role === 'status' && i.log));
  setInterval(pushStatus, 2000).unref();

  server.on('error', e => { console.error(`[web] ${e.message}`); process.exitCode = 1; });
  server.listen(cfg.web.port, () => {
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
    console.log(`[web] mixer page:  ${addrs.map(a => `http://${a}:${cfg.web.port}/`).join('  ') || `http://localhost:${cfg.web.port}/`}`);
    console.log(`[web] status page: http://localhost:${cfg.web.port}/status`);
  });
  return server;
}

module.exports = { startWeb };
