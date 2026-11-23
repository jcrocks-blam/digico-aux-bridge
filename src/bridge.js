'use strict';
// OSC proxy between the DiGiCo console and the official iPad app, plus a state cache of
// input names and aux send levels for the web clients. Web clients each pick one aux.
const dgram = require('dgram');
const { EventEmitter } = require('events');
const osc = require('./osc');

function templateRegex(tpl) {
  const esc = tpl.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace('{ch}', '(?<ch>\\d+)').replace('{aux}', '(?<aux>\\d+)');
  return new RegExp('^' + esc + '(?<query>/\\?)?$', 'i');
}
const fill = (tpl, v) => tpl.replace('{ch}', v.ch).replace('{aux}', v.aux);
const firstNum = args => { const a = args.find(a => typeof a.value === 'number'); return a ? a.value : undefined; };
const firstStr = args => { const a = args.find(a => a.type === 's'); return a ? a.value : undefined; };

// "auto" | "1-8, 12" | [1,2,3] | 4  ->  null (= every aux on the console) or a sorted array
function parseAuxList(v) {
  if (v === undefined || v === null || v === 'auto' || v === 'all' || v === '') return null;
  if (typeof v === 'number') return [v];
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(',');
  const out = new Set();
  for (const p of parts) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(p);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 512; i++) if (i > 0) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

class Bridge extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.defaultAux = Number(cfg.aux) || 1;
    this.auxAllow = parseAuxList(cfg.auxes);
    this.re = {
      sendLevel: templateRegex(cfg.paths.sendLevel),
      channelName: templateRegex(cfg.paths.channelName),
      auxName: templateRegex(cfg.paths.auxName),
      inputCount: templateRegex(cfg.paths.inputCount),
      auxCount: templateRegex(cfg.paths.auxCount)
    };
    this.names = new Map();     // ch -> name
    this.levels = new Map();    // aux -> Map(ch -> { db, lastUpdate })
    this.auxNames = new Map();  // aux -> name
    this.watchers = new Map();  // aux -> number of web clients on it
    this.inputCount = cfg.inputCount === 'auto' ? 0 : Number(cfg.inputCount);
    this.auxCount = 0;
    this.console = { connected: false, lastSeen: 0, rx: 0, tx: 0 };
    this.ipad = { connected: false, lastSeen: 0, rx: 0, tx: 0,
      ip: cfg.ipad.ip === 'auto' ? null : cfg.ipad.ip, port: cfg.ipad.receivePort };
    this.pending = new Map();         // "aux:ch" -> { value, until } after a web change, to ignore stale echoes
    this.outTimers = new Map();       // "aux:ch" -> coalescing timer for web -> console
    this.sent = new Map();            // "aux:ch" -> last value sent
    this.reconcileTimers = new Map();
    this.queue = []; this.queued = new Set();
    this.ring = []; this.startedAt = Date.now();
    this.levelMin = cfg.levels.min; this.levelMax = cfg.levels.max;
  }

  // ---------- aux bookkeeping ----------
  availableAuxes() {
    const onDesk = this.auxCount ? Array.from({ length: this.auxCount }, (_, i) => i + 1) : null;
    let list = this.auxAllow || onDesk || [this.defaultAux];
    if (onDesk) list = list.filter(a => a <= this.auxCount);
    return list;
  }
  isAllowedAux(aux) { return Number.isInteger(aux) && this.availableAuxes().includes(aux); }
  auxList() { return this.availableAuxes().map(aux => ({ aux, name: this.auxNames.get(aux) || '' })); }
  _tracked(aux) { return aux === this.defaultAux || (this.auxAllow ? this.auxAllow.includes(aux) : true); }

  _lv(aux, ch) {
    let m = this.levels.get(aux);
    if (!m) { m = new Map(); this.levels.set(aux, m); }
    let c = m.get(ch);
    if (!c) { c = { db: null, lastUpdate: 0 }; m.set(ch, c); }
    return c;
  }

  // A web client switched to this aux: make sure we have its levels.
  watch(aux) {
    const n = (this.watchers.get(aux) || 0) + 1;
    this.watchers.set(aux, n);
    if (n === 1 && aux !== this.defaultAux) this._syncLevels(aux, 1, this.inputCount);
  }
  unwatch(aux) {
    const n = (this.watchers.get(aux) || 0) - 1;
    if (n > 0) this.watchers.set(aux, n); else this.watchers.delete(aux);
  }
  _watchedAuxes() { return new Set([this.defaultAux, ...this.watchers.keys()]); }

  start() {
    const { cfg } = this;
    this.consoleSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.consoleSock.on('message', (b, r) => this._fromConsole(b, r));
    this.consoleSock.on('error', e => this.emit('error', new Error(`Console socket (UDP ${cfg.console.sendPort}): ${e.message}`)));
    this.consoleSock.bind(cfg.console.sendPort);

    if (cfg.ipad.enabled) {
      this.ipadSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.ipadSock.on('message', (b, r) => this._fromIpad(b, r));
      this.ipadSock.on('error', e => this.emit('error', new Error(`iPad socket (UDP ${cfg.ipad.sendPort}): ${e.message}`)));
      this.ipadSock.bind(cfg.ipad.sendPort);
    }

    const qps = Math.max(10, cfg.sync.queriesPerSecond);
    this.queueTimer = setInterval(() => this._drainQueue(), 10);
    this.queuePerTick = Math.max(1, Math.round(qps / 100));
    this.heartbeat = setInterval(() => this._tick(), cfg.sync.heartbeatSeconds * 1000);
    this._queryCounts();
  }

  stop() {
    clearInterval(this.queueTimer); clearInterval(this.heartbeat);
    try { this.consoleSock.close(); } catch {}
    try { this.ipadSock && this.ipadSock.close(); } catch {}
  }

  // ---------- logging ----------
  _log(dir, msgs) {
    const t = Date.now();
    for (const m of msgs) {
      const e = { t, dir, address: m.address, args: osc.argsToString(m.args) };
      this.ring.push(e);
      if (this.cfg.log.oscToStdout) console.log(`[osc] ${dir.padEnd(16)} ${e.address} ${e.args}`);
      this.emit('log', e);
    }
    const over = this.ring.length - this.cfg.log.ringSize;
    if (over > 0) this.ring.splice(0, over);
  }

  // ---------- transport ----------
  _sendConsole(address, args = [], tag = 'bridge>console') {
    const buf = osc.encode(address, args);
    this.consoleSock.send(buf, this.cfg.console.receivePort, this.cfg.console.ip);
    this.console.tx++;
    this._log(tag, [{ address, args: osc.decode(buf)[0].args }]);
  }

  _sendIpadRaw(buf) {
    if (!this.ipadSock || !this.ipad.ip) return;
    this.ipadSock.send(buf, this.ipad.port, this.ipad.ip);
    this.ipad.tx++;
  }

  _fromConsole(buf) {
    this.console.rx++;
    this._markConsole();
    this._sendIpadRaw(buf); // transparent passthrough to the iPad app
    let msgs; try { msgs = osc.decode(buf); } catch (e) { this._log('console>bridge', [{ address: `<undecodable: ${e.message}>`, args: [] }]); return; }
    this._log('console>bridge', msgs);
    for (const m of msgs) this._handle(m, 'console');
  }

  _fromIpad(buf, rinfo) {
    if (this.cfg.ipad.ip === 'auto') {
      if (this.ipad.ip !== rinfo.address) {
        this.ipad.ip = rinfo.address;
        console.log(`[ipad] iPad app seen at ${rinfo.address}`);
      }
    } else if (rinfo.address !== this.cfg.ipad.ip) {
      return; // ignore packets from anything other than the configured iPad
    }
    this.ipad.rx++;
    const was = this.ipad.connected;
    this.ipad.lastSeen = Date.now(); this.ipad.connected = true;
    if (!was) this._status();
    this.consoleSock.send(buf, this.cfg.console.receivePort, this.cfg.console.ip); // passthrough
    this.console.tx++;
    let msgs; try { msgs = osc.decode(buf); } catch { return; }
    this._log('ipad>console', msgs);
    for (const m of msgs) this._handle(m, 'ipad');
  }

  _markConsole() {
    this.console.lastSeen = Date.now();
    if (!this.console.connected) {
      this.console.connected = true;
      console.log('[console] connected');
      this._status();
      this.fullSync();
    }
  }

  _tick() {
    const now = Date.now(), to = this.cfg.sync.timeoutSeconds * 1000;
    if (this.console.connected && now - this.console.lastSeen > to) {
      this.console.connected = false;
      console.log('[console] no reply - disconnected');
      this._status();
    }
    if (this.ipad.connected && now - this.ipad.lastSeen > to) {
      this.ipad.connected = false;
      console.log('[ipad] iPad app went quiet');
      this._status();
    }
    this._queryCounts(); // heartbeat; replies also keep channel/aux counts current
  }

  _status() { this.emit('status', this.statusSnapshot()); }

  // ---------- message handling ----------
  _handle(m, source) {
    const { re } = this;
    let r;
    if ((r = re.sendLevel.exec(m.address))) {
      if (r.groups.query) return;
      const aux = Number(r.groups.aux);
      if (!this._tracked(aux)) return;
      const v = firstNum(m.args);
      if (v !== undefined) this._updateLevel(aux, Number(r.groups.ch), v, source);
    } else if ((r = re.channelName.exec(m.address))) {
      if (r.groups.query) return;
      const s = firstStr(m.args);
      if (s !== undefined) this._updateName(Number(r.groups.ch), s);
    } else if ((r = re.auxName.exec(m.address))) {
      if (r.groups.query) return;
      const aux = Number(r.groups.aux), s = firstStr(m.args);
      if (s !== undefined && this.auxNames.get(aux) !== s) {
        this.auxNames.set(aux, s);
        this.emit('auxes');
      }
    } else if ((r = re.inputCount.exec(m.address))) {
      if (r.groups.query || source !== 'console') return;
      const n = firstNum(m.args);
      if (n !== undefined && this.cfg.inputCount === 'auto' && n !== this.inputCount && n >= 0 && n <= 512) {
        const old = this.inputCount;
        this.inputCount = n;
        for (const ch of [...this.names.keys()]) if (ch > n) this.names.delete(ch);
        for (const m2 of this.levels.values()) for (const ch of [...m2.keys()]) if (ch > n) m2.delete(ch);
        console.log(`[console] ${n} input channels`);
        this.emit('layout');
        if (n > old) {
          this._syncNames(old + 1, n);
          for (const aux of this._watchedAuxes()) this._syncLevels(aux, old + 1, n);
        }
      }
    } else if ((r = re.auxCount.exec(m.address))) {
      if (r.groups.query || source !== 'console') return;
      const n = firstNum(m.args);
      if (n !== undefined && n !== this.auxCount && n >= 0 && n <= 512) {
        this.auxCount = n;
        console.log(`[console] ${n} auxes`);
        this._syncAuxNames();
        this.emit('auxes');
      }
    }
  }

  _updateLevel(aux, ch, v, source) {
    if (this.inputCount && ch > this.inputCount) return;
    const c = this._lv(aux, ch);
    c.lastUpdate = Date.now();
    if (source === 'console') {
      const p = this.pending.get(aux + ':' + ch);
      if (p && Date.now() < p.until && Math.abs(p.value - v) > 0.05) return; // stale echo while a web user is moving it
    }
    if (c.db !== null && Math.abs(c.db - v) < 0.01) return;
    c.db = v;
    this.emit('level', { aux, ch, db: v, source });
  }

  _updateName(ch, name) {
    if (this.inputCount && ch > this.inputCount) return;
    if (this.names.get(ch) === name) return;
    this.names.set(ch, name);
    this.emit('name', { ch, name });
  }

  // ---------- web -> console ----------
  setLevel(aux, ch, db, originId) {
    aux = Number(aux); ch = Number(ch);
    if (!this.isAllowedAux(aux)) return false;
    if (!Number.isInteger(ch) || ch < 1 || (this.inputCount && ch > this.inputCount)) return false;
    db = Math.min(this.levelMax, Math.max(this.levelMin, Number(db)));
    if (!Number.isFinite(db)) return false;
    db = Math.round(db * 10) / 10;
    const key = aux + ':' + ch;
    const c = this._lv(aux, ch);
    c.db = db; c.lastUpdate = Date.now();
    this.pending.set(key, { value: db, until: Date.now() + this.cfg.sync.reconcileDelayMs });
    this.emit('level', { aux, ch, db, source: 'web', originId });

    // Coalesce rapid moves per channel (~40 msgs/s max per channel to the console)
    if (!this.outTimers.has(key)) {
      this._flushLevel(aux, ch);
      this.outTimers.set(key, setTimeout(() => {
        this.outTimers.delete(key);
        if (this.sent.get(key) !== this._lv(aux, ch).db) this._flushLevel(aux, ch);
      }, 25));
    }

    // After the user stops, ask the console for the real value to make sure everyone agrees
    clearTimeout(this.reconcileTimers.get(key));
    this.reconcileTimers.set(key, setTimeout(() => {
      this.reconcileTimers.delete(key);
      this.pending.delete(key);
      this._enqueue(fill(this.cfg.paths.sendLevel, { ch, aux }) + this.cfg.paths.querySuffix, true);
    }, this.cfg.sync.reconcileDelayMs + 50));
    return true;
  }

  _flushLevel(aux, ch) {
    const db = this._lv(aux, ch).db;
    this.sent.set(aux + ':' + ch, db);
    const address = fill(this.cfg.paths.sendLevel, { ch, aux });
    const args = [{ type: 'f', value: db }];
    this._sendConsole(address, args, 'web>console');
    // Keep the iPad app's screen in step (the console won't echo our change back to the iPad)
    if (this.ipad.ip) {
      this._sendIpadRaw(osc.encode(address, args));
      this._log('web>ipad', [{ address, args }]);
    }
  }

  // ---------- sync / queries ----------
  _enqueue(address, front = false) {
    if (this.queued.has(address)) return;
    this.queued.add(address);
    front ? this.queue.unshift(address) : this.queue.push(address);
  }

  _drainQueue() {
    for (let i = 0; i < this.queuePerTick && this.queue.length; i++) {
      const a = this.queue.shift(); this.queued.delete(a);
      this._sendConsole(a, [], 'query>console');
    }
  }

  _queryCounts() {
    const q = this.cfg.paths.querySuffix;
    this._enqueue(this.cfg.paths.inputCount + q, true);
    this._enqueue(this.cfg.paths.auxCount + q, true);
  }

  fullSync() {
    this._syncAuxNames();
    if (this.inputCount) {
      this._syncNames(1, this.inputCount);
      for (const aux of this._watchedAuxes()) this._syncLevels(aux, 1, this.inputCount);
    } else this._queryCounts(); // channel lists follow when the counts arrive
  }

  _syncAuxNames() {
    const q = this.cfg.paths.querySuffix;
    for (const aux of this.availableAuxes()) this._enqueue(fill(this.cfg.paths.auxName, { aux }) + q);
  }

  // If the iPad app is mid-sync, its own requests bring back names/levels; skip anything fresh.
  _later(fn) { setTimeout(fn, this.ipad.connected ? 1500 : 0); }

  _syncNames(from, to) {
    const q = this.cfg.paths.querySuffix;
    this._later(() => {
      for (let ch = from; ch <= to; ch++) this._enqueue(fill(this.cfg.paths.channelName, { ch }) + q);
    });
  }

  _syncLevels(aux, from, to) {
    if (!to) return; // channel count not known yet; fullSync runs again when it arrives
    const q = this.cfg.paths.querySuffix;
    this._later(() => {
      const fresh = Date.now() - 5000;
      for (let ch = from; ch <= to; ch++) {
        const c = this._lv(aux, ch);
        if (c.lastUpdate > fresh && c.db !== null) continue;
        this._enqueue(fill(this.cfg.paths.sendLevel, { ch, aux }) + q);
      }
    });
  }

  // ---------- snapshots ----------
  stateSnapshot(aux) {
    const channels = [];
    const n = this.inputCount || Math.max(0, ...this.names.keys());
    const lv = this.levels.get(aux);
    for (let ch = 1; ch <= n; ch++) {
      const c = lv && lv.get(ch);
      channels.push({ ch, name: this.names.get(ch) || '', db: c ? c.db : null });
    }
    return { aux, auxName: this.auxNames.get(aux) || '', auxes: this.auxList(), channels,
      min: this.levelMin, max: this.levelMax };
  }

  statusSnapshot() {
    const now = Date.now();
    return {
      defaultAux: this.defaultAux, auxCount: this.auxCount, inputCount: this.inputCount,
      watched: [...this._watchedAuxes()].sort((a, b) => a - b).map(a => ({ aux: a, name: this.auxNames.get(a) || '', clients: this.watchers.get(a) || 0 })),
      uptime: Math.round((now - this.startedAt) / 1000),
      console: { ...this.console, ip: this.cfg.console.ip, sendPort: this.cfg.console.sendPort,
        receivePort: this.cfg.console.receivePort, ageMs: this.console.lastSeen ? now - this.console.lastSeen : null },
      ipad: { ...this.ipad, enabled: this.cfg.ipad.enabled, sendPort: this.cfg.ipad.sendPort,
        receivePort: this.cfg.ipad.receivePort, ageMs: this.ipad.lastSeen ? now - this.ipad.lastSeen : null },
      queue: this.queue.length
    };
  }
}

module.exports = { Bridge, templateRegex, parseAuxList };
