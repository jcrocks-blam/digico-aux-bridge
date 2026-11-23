'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  console: {
    ip: '192.168.1.100',
    sendPort: 8001,
    receivePort: 8000
  },
  ipad: {
    enabled: true,
    ip: 'auto',
    sendPort: 9000,
    receivePort: 9001
  },
  aux: 1,
  auxes: 'auto',
  inputCount: 'auto',
  web: {
    port: 8080,
    pin: '',
    title: ''
  },
  levels: {
    min: -150,
    max: 10
  },
  paths: {
    sendLevel: '/Input_Channels/{ch}/Aux_Send/{aux}/send_level',
    channelName: '/Input_Channels/{ch}/Channel_Input/name',
    auxName: '/Aux_Outputs/{aux}/Buss_Trim/name',
    inputCount: '/Console/Input_Channels',
    auxCount: '/Console/Aux_Outputs',
    querySuffix: '/?'
  },
  sync: {
    queriesPerSecond: 250,
    heartbeatSeconds: 5,
    timeoutSeconds: 15,
    reconcileDelayMs: 600
  },
  log: {
    oscToStdout: false,
    ringSize: 2000
  }
};

function isPackaged() {
  try { return require('node:sea').isSea(); } catch { return false; }
}

function baseDir() {
  if (isPackaged()) return path.dirname(process.execPath);          // DigicoAuxBridge.exe
  const script = path.resolve(process.argv[1] || '.');
  if (path.basename(script) === 'aux-bridge.js') return path.dirname(script); // bundled build
  return path.resolve(__dirname, '..');                               // running from source
}

function merge(def, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? def : over;
  const out = { ...def };
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;
    out[k] = (def && typeof def[k] === 'object' && !Array.isArray(def[k])) ? merge(def[k], over[k]) : over[k];
  }
  return out;
}

function load(file) {
  const p = file || process.env.AUX_BRIDGE_CONFIG || path.join(baseDir(), 'config.json');
  let user = {};
  if (fs.existsSync(p)) {
    try { user = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } // Notepad may add a BOM
    catch (e) { throw new Error(`Could not parse ${p}: ${e.message}`); }
  } else {
    fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2));
    console.log(`[config] No config found, wrote defaults to ${p} - edit it and restart.`);
  }
  const cfg = merge(DEFAULTS, user);
  cfg._file = p;
  cfg._baseDir = baseDir();
  return cfg;
}

module.exports = { load, DEFAULTS, baseDir, isPackaged };
