'use strict';
// End-to-end test: console simulator <-> bridge <-> (fake iPad app + two web clients).
// Run: node tools/test-e2e.js   (needs Node 22+ for the built-in WebSocket client)
const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const osc = require('../src/osc');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auxbridge-'));
const cfgFile = path.join(tmp, 'config.json');
const P = { conSend: 18001, conRecv: 18000, ipadSend: 19000, ipadRecv: 19001, web: 18080 };
fs.writeFileSync(cfgFile, JSON.stringify({
  console: { ip: '127.0.0.1', sendPort: P.conSend, receivePort: P.conRecv },
  ipad: { enabled: true, ip: 'auto', sendPort: P.ipadSend, receivePort: P.ipadRecv },
  aux: 1, auxes: '1-4', inputCount: 'auto', web: { port: P.web, pin: '1234' },
  sync: { heartbeatSeconds: 1, timeoutSeconds: 3, reconcileDelayMs: 400, queriesPerSecond: 500 }
}));

const procs = [];
const run = (args, name) => {
  const p = spawn(process.execPath, args, { cwd: root });
  p.stdout.on('data', d => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', d => process.stdout.write(`[${name} ERR] ${d}`));
  procs.push(p); return p;
};
const startSim = (extra = []) => run(['tools/simulator.js', '--channels', '24', '--listen', P.conRecv, '--reply-port', P.conSend, '--quiet', ...extra], 'sim');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return false; }

function wsClient(pin, aux) {
  const c = { msgs: [], state: null, status: null, levels: new Map(), names: new Map() };
  c.ws = new WebSocket(`ws://127.0.0.1:${P.web}/ws`);
  c.ws.onopen = () => c.ws.send(JSON.stringify({ t: 'hello', role: 'mixer', pin, aux }));
  c.ws.onmessage = e => {
    const m = JSON.parse(e.data); c.msgs.push(m);
    if (m.t === 'auth') c.auth = m;
    if (m.t === 'state') { c.state = m; c.levels.clear(); for (const ch of m.channels) { c.levels.set(ch.ch, ch.db); c.names.set(ch.ch, ch.name); } }
    if (m.t === 'status') c.status = m;
    if (m.t === 'level' && c.state && m.aux === c.state.aux) c.levels.set(m.ch, m.db);
    if (m.t === 'auxes' && c.state) c.state.auxes = m.auxes;
    if (m.t === 'name') c.names.set(m.ch, m.name);
  };
  c.send = o => c.ws.send(JSON.stringify(o));
  return c;
}

(async () => {
  let sim = startSim();
  await sleep(200);
  run([process.env.BRIDGE || 'src/main.js', '--config', cfgFile], 'bridge');
  await sleep(500);

  // Fake iPad app
  const ipadIn = [];
  const ipad = dgram.createSocket('udp4');
  ipad.on('message', b => { for (const m of osc.decode(b)) ipadIn.push(m); });
  await new Promise(r => ipad.bind(P.ipadRecv, r));
  const ipadSend = (a, args = []) => ipad.send(osc.encode(a, args), P.ipadSend, '127.0.0.1');

  const bad = wsClient('0000');
  const a = wsClient('1234');
  const b = wsClient('1234');

  check(await until(() => bad.auth), 'wrong PIN gets a reply');
  check(bad.auth && bad.auth.ok === false && !bad.state, 'wrong PIN is refused and gets no state');
  check(await until(() => a.status && a.status.console.connected), 'bridge reaches the console');
  check(await until(() => a.state && a.state.channels.length === 24), 'channel count learned from console (24)');
  check(await until(() => a.names.get(20) === 'Lead Vox'), 'channel names synced');
  check(await until(() => [...a.levels.values()].every(v => typeof v === 'number')), 'all aux 1 send levels synced');
  check(await until(() => a.state.auxName === 'Drums IEM' || a.msgs.some(m => m.t === 'state' && m.auxName === 'Drums IEM')), 'aux name synced');

  // iPad proxy: query goes through and the reply comes back to the iPad
  ipadSend('/Input_Channels/20/Channel_Input/name/?');
  check(await until(() => ipadIn.some(m => m.address === '/Input_Channels/20/Channel_Input/name' && m.args[0].value === 'Lead Vox')),
    'iPad query proxied to console and reply returned to iPad');

  // Web change -> console, iPad, other web client
  ipadIn.length = 0;
  a.send({ t: 'set', ch: 3, db: -5 });
  check(await until(() => b.levels.get(3) === -5), 'web change reaches the other web client');
  check(await until(() => ipadIn.some(m => /input_channels\/3\/aux_send\/1\/send_level$/i.test(m.address) && Math.abs(m.args[0].value + 5) < 0.01)),
    'web change pushed to the iPad app');
  // reconcile query: console's own answer comes back through to the iPad, proving the console took it
  check(await until(() => ipadIn.filter(m => /input_channels\/3\/aux_send\/1\/send_level$/i.test(m.address)).length >= 2, 2000),
    'console confirms the web change (reconcile query)');

  // Fast drag: many moves, final value wins
  for (let i = 0; i <= 30; i++) { a.send({ t: 'set', ch: 5, db: -30 + i }); await sleep(5); }
  await sleep(900);
  ipadIn.length = 0;
  ipadSend('/Input_Channels/5/Aux_Send/1/send_level/?');
  check(await until(() => ipadIn.some(m => /input_channels\/5\/aux_send\/1\/send_level$/i.test(m.address) && Math.abs(m.args[0].value - 0) < 0.01)),
    'fast fader drag: console ends on the final value (0 dB)');

  // iPad change -> console + web clients
  ipadSend('/Input_Channels/4/Aux_Send/1/send_level', [{ type: 'f', value: -12 }]);
  check(await until(() => a.levels.get(4) === -12 && b.levels.get(4) === -12), 'iPad change shows up on web clients');
  // iPad change to another aux must not move our faders
  const before = a.levels.get(6);
  ipadSend('/Input_Channels/6/Aux_Send/2/send_level', [{ type: 'f', value: -1 }]);
  await sleep(300);
  check(a.levels.get(6) === before, 'changes to other auxes are ignored');

  // Aux selection
  const c3 = wsClient('1234', 3);
  check(await until(() => c3.state && c3.state.aux === 3), 'client can open on aux 3');
  check(await until(() => c3.state.auxes && c3.state.auxes.length === 4 && c3.state.auxes[0].name === 'Drums IEM'), 'aux list limited to config (1-4) with names');
  check(await until(() => c3.levels.size === 24 && [...c3.levels.values()].every(v => typeof v === 'number')), 'aux 3 levels synced on demand');
  const a6 = a.levels.get(6);
  ipadSend('/Input_Channels/6/Aux_Send/3/send_level', [{ type: 'f', value: -3 }]);
  check(await until(() => c3.levels.get(6) === -3), 'iPad change on aux 3 reaches the aux 3 client');
  await sleep(200);
  check(a.levels.get(6) === a6, 'aux 1 clients are not affected by aux 3 changes');
  ipadIn.length = 0;
  c3.send({ t: 'set', ch: 2, db: -7 });
  check(await until(() => ipadIn.some(m => /input_channels\/2\/aux_send\/3\/send_level$/i.test(m.address) && Math.abs(m.args[0].value + 7) < 0.01)),
    'aux 3 client change goes to aux 3 on the console');
  c3.send({ t: 'aux', aux: 9 });
  await sleep(300);
  check(c3.state.aux === 3, 'request for an aux outside the allowed list is refused');
  c3.send({ t: 'aux', aux: 2 });
  check(await until(() => c3.state.aux === 2 && c3.levels.size === 24 && [...c3.levels.values()].every(v => typeof v === 'number')), 'switching to aux 2 loads its levels');
  c3.ws.close();

  // Out-of-range / junk
  a.send({ t: 'set', ch: 999, db: 0 }); a.send({ t: 'set', ch: 2, db: 99 });
  check(await until(() => b.levels.get(2) === 10), 'levels clamp to +10 dB');

  // Console goes away and comes back
  sim.kill();
  check(await until(() => a.status && !a.status.console.connected, 6000), 'console loss detected');
  sim = startSim(['--echo']);
  check(await until(() => a.status && a.status.console.connected, 6000), 'console reconnect detected');
  check(await until(() => a.levels.get(3) !== -5), 'state re-synced from the (fresh) console after reconnect');

  // Echo-on console: a drag must not bounce back on the other client
  const seen = [];
  const orig = b.ws.onmessage;
  b.ws.onmessage = e => { orig(e); const m = JSON.parse(e.data); if (m.t === 'level' && m.ch === 7) seen.push(m.db); };
  for (let i = 0; i <= 20; i++) { a.send({ t: 'set', ch: 7, db: -20 + i }); await sleep(15); }
  await sleep(1000);
  const nonMonotonic = seen.some((v, i) => i > 0 && v < seen[i - 1]);
  check(!nonMonotonic && seen[seen.length - 1] === 0, `echoing console: no fader bounce on other clients (${seen.length} updates)`);

  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  for (const p of procs) p.kill();
  ipad.close(); a.ws.close(); b.ws.close(); bad.ws.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(failures ? 1 : 0), 200);
})().catch(e => { console.error(e); for (const p of procs) p.kill(); process.exit(1); });
