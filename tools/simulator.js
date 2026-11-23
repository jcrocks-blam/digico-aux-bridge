'use strict';
// Pretends to be a DiGiCo Quantum's External Control (iPad command set) for testing
// without a desk. Answers queries for channel count, names, aux names and aux send levels.
//
//   node tools/simulator.js [--channels 48] [--auxes 16] [--listen 8000] [--reply-host 127.0.0.1]
//                           [--reply-port 8001] [--echo] [--surface]
//
//   --echo     echo every change back (like "Suppress OSC retransmit" OFF)
//   --surface  every few seconds, move a random send on aux 1 as if the engineer did it
const dgram = require('dgram');
const osc = require('../src/osc');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = name => argv.includes('--' + name);

const CH = Number(opt('channels', 48)), AUX = Number(opt('auxes', 16));
const LISTEN = Number(opt('listen', 8000));
const REPLY_HOST = opt('reply-host', '127.0.0.1'), REPLY_PORT = Number(opt('reply-port', 8001));
const ECHO = flag('echo'), SURFACE = flag('surface'), QUIET = flag('quiet');

const NAMES = ['Kick In', 'Kick Out', 'Snare Top', 'Snare Bot', 'Hat', 'Rack Tom', 'Floor Tom', 'OH L', 'OH R',
  'Bass DI', 'Bass Mic', 'Gtr 1', 'Gtr 2', 'Keys L', 'Keys R', 'Synth', 'Trk L', 'Trk R', 'Click', 'Lead Vox',
  'BV 1', 'BV 2', 'BV 3', 'Talkback', 'Amb L', 'Amb R'];
const AUXNAMES = ['Drums IEM', 'Bass IEM', 'Gtr IEM', 'Keys IEM', 'Vox IEM', 'Side L', 'Side R'];

const state = { names: [], sends: [] };
for (let c = 1; c <= CH; c++) {
  state.names[c] = NAMES[c - 1] || `Ch ${c}`;
  state.sends[c] = [];
  for (let a = 1; a <= AUX; a++) state.sends[c][a] = Math.random() < 0.3 ? -150 : -Math.round(Math.random() * 30);
}

const sock = dgram.createSocket('udp4');
const reply = (address, args) => sock.send(osc.encode(address, args), REPLY_PORT, REPLY_HOST);
const log = (...a) => { if (!QUIET) console.log('[sim]', ...a); };

sock.on('message', (buf) => {
  for (const m of osc.decode(buf)) {
    const isQuery = /\/\?$/.test(m.address);
    const addr = m.address.replace(/\/\?$/, '');
    let r;
    if (/^\/console\/input_channels$/i.test(addr)) {
      if (isQuery) reply('/Console/Input_Channels', [{ type: 'i', value: CH }]);
    } else if (/^\/console\/aux_outputs$/i.test(addr)) {
      if (isQuery) reply('/Console/Aux_Outputs', [{ type: 'i', value: AUX }]);
    } else if ((r = /^\/input_channels\/(\d+)\/aux_send\/(\d+)\/send_level$/i.exec(addr))) {
      const c = +r[1], a = +r[2];
      if (c < 1 || c > CH || a < 1 || a > AUX) continue;
      const path = `/Input_Channels/${c}/Aux_Send/${a}/send_level`;
      if (isQuery) reply(path, [{ type: 'f', value: state.sends[c][a] }]);
      else if (m.args.length) {
        const v = Math.max(-150, Math.min(10, m.args[0].value));
        state.sends[c][a] = v;
        log(`set ch${c} aux${a} = ${v.toFixed(1)} dB`);
        if (ECHO) reply(path, [{ type: 'f', value: v }]);
      }
    } else if ((r = /^\/input_channels\/(\d+)\/channel_input\/name$/i.exec(addr))) {
      const c = +r[1];
      if (c < 1 || c > CH) continue;
      if (isQuery) reply(`/Input_Channels/${c}/Channel_Input/name`, [{ type: 's', value: state.names[c] }]);
      else if (m.args.length) state.names[c] = String(m.args[0].value);
    } else if ((r = /^\/aux_outputs\/(\d+)\/buss_trim\/name$/i.exec(addr))) {
      const a = +r[1];
      if (isQuery) reply(`/Aux_Outputs/${a}/Buss_Trim/name`, [{ type: 's', value: AUXNAMES[a - 1] || `Aux ${a}` }]);
    }
  }
});

if (SURFACE) {
  setInterval(() => {
    const c = 1 + Math.floor(Math.random() * Math.min(CH, 24));
    const v = -Math.round(Math.random() * 40);
    state.sends[c][1] = v;
    log(`surface: ch${c} aux1 -> ${v} dB`);
    reply(`/Input_Channels/${c}/Aux_Send/1/send_level`, [{ type: 'f', value: v }]);
  }, 4000);
}

sock.bind(LISTEN, () => log(`console simulator: ${CH} inputs, ${AUX} auxes, listening UDP ${LISTEN}, replying to ${REPLY_HOST}:${REPLY_PORT}${ECHO ? ', echo on' : ''}`));
module.exports = { state };
