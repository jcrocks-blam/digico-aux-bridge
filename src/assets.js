'use strict';
// Web pages are read from src/web/ during development. The Windows build embeds them
// into the bundle (see build/build.js), so the .exe needs no extra files.
const fs = require('fs');
const path = require('path');

let embedded = null;
try { embedded = require('./generated-assets'); } catch { /* dev mode */ }

function get(name) {
  if (embedded && embedded[name]) return embedded[name];
  return fs.readFileSync(path.join(__dirname, 'web', name));
}

module.exports = { get };
