'use strict';
// Minimal RFC 6455 WebSocket server for text messages (no dependencies).
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Client extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      this._frame(fin, op, payload);
      if (!this.open) return;
    }
  }

  _frame(fin, op, payload) {
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this._send(0xA, payload); return; }
    if (op === 0xA) { this.alive = true; return; }
    if (op === 0x1 || op === 0x2) this.frag = [payload];
    else if (op === 0x0 && this.frag) this.frag.push(payload);
    else return;
    if (!fin) return;
    const data = Buffer.concat(this.frag); this.frag = null;
    this.emit('message', data.toString('utf8'));
  }

  _send(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this._closed(); }
  }

  send(text) { this._send(0x1, Buffer.from(text, 'utf8')); }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this._send(0x8, p);
    this.open = false;
    try { this.socket.end(); } catch {}
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  constructor(httpServer, path = '/ws') {
    super();
    this.clients = new Set();
    httpServer.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://x');
      const key = req.headers['sec-websocket-key'];
      if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const c = new Client(socket, req);
      this.clients.add(c);
      c.on('close', () => this.clients.delete(c));
      this.emit('connection', c, req);
    });
    // Keepalive: ping every 15s, drop clients that never pong (phones that went to sleep)
    this.timer = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.close(1001); continue; }
        c.alive = false;
        c._send(0x9, Buffer.alloc(0));
      }
    }, 15000);
    this.timer.unref();
  }
}

module.exports = { WebSocketServer };
