'use strict';
// Builds dist/DigicoAuxBridge/ :
//   1. bundles src/*.js and the web pages into one script (no npm packages needed)
//   2. with --exe: turns it into a single DigicoAuxBridge.exe using Node's Single Executable
//      Application feature (run this on the Windows PC, with Node 22 or 24 LTS installed)
//   3. copies the Windows install scripts and a default config next to it
//
//   node build/build.js          -> bundle only (dist/DigicoAuxBridge/aux-bridge.js)
//   node build/build.js --exe    -> bundle + .exe
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const out = path.join(root, 'dist', 'DigicoAuxBridge');
const work = path.join(root, 'dist', '.build');
const EXE = 'DigicoAuxBridge.exe';

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(work, { recursive: true });

// 1. Embed web pages
const pages = {};
for (const f of fs.readdirSync(path.join(src, 'web'))) {
  if (f.startsWith('.') || !f.endsWith('.html')) continue; // skip macOS ._ files etc.
  pages[f] = fs.readFileSync(path.join(src, 'web', f)).toString('base64');
}
const genAssets = 'module.exports = {\n' + Object.entries(pages)
  .map(([k, v]) => `  ${JSON.stringify(k)}: Buffer.from(${JSON.stringify(v)}, 'base64')`).join(',\n') + '\n};\n';

// 2. Tiny CommonJS bundler for the flat src/ folder
const modules = { './generated-assets': genAssets };
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.js') && !f.startsWith('.') && f !== 'generated-assets.js') modules['./' + f.slice(0, -3)] = fs.readFileSync(path.join(src, f), 'utf8');
}
let bundle = `'use strict';
// DiGiCo Aux Bridge - bundled ${new Date().toISOString()}
const __defs = {}, __cache = {};
const __nativeRequire = require;
function __require(name) {
  if (!name.startsWith('./')) return __nativeRequire(name);
  name = name.replace(/\\.js$/, '');
  if (__cache[name]) return __cache[name].exports;
  if (!__defs[name]) { const e = new Error('Cannot find module ' + name); e.code = 'MODULE_NOT_FOUND'; throw e; }
  const module = { exports: {} };
  __cache[name] = module;
  __defs[name](module, module.exports, __require, __dirname);
  return module.exports;
}
`;
for (const [name, code] of Object.entries(modules)) {
  bundle += `\n__defs[${JSON.stringify(name)}] = function (module, exports, require, __dirname) {\n${code}\n};\n`;
}
bundle += `\n__require('./main');\n`;
const bundlePath = path.join(out, 'aux-bridge.js');
// Fail here with a clear message rather than producing an .exe that can't start
try { new (require('vm').Script)(bundle, { filename: 'aux-bridge.js' }); }
catch (e) { throw new Error(`Bundled code doesn't parse (${e.message}). Are all files in src/ the originals from the zip?`); }
fs.writeFileSync(bundlePath, bundle);
console.log(`bundle: ${path.relative(root, bundlePath)} (${Math.round(bundle.length / 1024)} KB)`);

// 3. Windows files + default config
for (const f of ['install.ps1', 'uninstall.ps1', 'run-foreground.bat']) {
  fs.copyFileSync(path.join(root, 'windows', f), path.join(out, f));
}
const { DEFAULTS } = require(path.join(src, 'config.js'));
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(DEFAULTS, null, 2));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));

// 4. Single executable
if (process.argv.includes('--exe')) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error('Building the .exe needs Node 20 or newer (22 or 24 LTS recommended).');
  const blob = path.join(work, 'sea-prep.blob');
  const seaCfg = path.join(work, 'sea-config.json');
  fs.writeFileSync(seaCfg, JSON.stringify({ main: bundlePath, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaCfg], { stdio: 'inherit' });
  if (!fs.existsSync(blob)) {
    throw new Error(`Node did not produce ${blob}. Check the lines above for its error, and that Node is 22 or 24 LTS.`);
  }
  console.log(`packed app: ${blob}`);

  const exe = path.join(out, process.platform === 'win32' ? EXE : 'DigicoAuxBridge');
  fs.copyFileSync(process.execPath, exe);
  const args = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  runNpx(args);
  fs.rmSync(bundlePath); // the exe carries the bundle now
  console.log(`exe: ${path.relative(root, exe)}`);
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`done: ${path.relative(root, out)}`);

// Run npx without going through cmd.exe, so folder names with spaces can't break the arguments.
// npm ships npx-cli.js beside node.exe on Windows; fall back to the shell only if it isn't there.
function runNpx(args) {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),          // Windows installer layout
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js') // macOS / Linux layout
  ];
  const cli = candidates.find(f => fs.existsSync(f));
  if (cli) return execFileSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (process.platform !== 'win32') return execFileSync('npx', args, { stdio: 'inherit' });
  const quoted = args.map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
  return execFileSync(`npx.cmd ${quoted}`, { stdio: 'inherit', shell: true });
}
