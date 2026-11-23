'use strict';
const config = require('./config');
const { Bridge } = require('./bridge');
const { startWeb } = require('./web');

const VERSION = '1.0.0';

function main() {
  const args = process.argv.slice(2);
  const cfgArg = args.indexOf('--config');
  let cfg;
  try {
    cfg = config.load(cfgArg >= 0 ? args[cfgArg + 1] : undefined);
  } catch (e) {
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }
  if (args.includes('--log-osc')) cfg.log.oscToStdout = true;

  console.log(`DiGiCo Aux Bridge ${VERSION}`);
  console.log(`[config] ${cfg._file}`);
  console.log(`[console] ${cfg.console.ip}  bridge listens UDP ${cfg.console.sendPort}, sends to UDP ${cfg.console.receivePort}`);
  if (cfg.ipad.enabled) console.log(`[ipad] proxy on: listens UDP ${cfg.ipad.sendPort}, sends to iPad UDP ${cfg.ipad.receivePort} (iPad ${cfg.ipad.ip})`);
  console.log(`[aux] default aux ${cfg.aux}; web users may pick: ${cfg.auxes === 'auto' ? 'any aux on the console' : cfg.auxes}`);

  const bridge = new Bridge(cfg);
  bridge.on('error', e => { console.error(`[error] ${e.message}`); if (/EADDRINUSE|EACCES/.test(e.message)) process.exit(1); });
  bridge.start();
  startWeb(cfg, bridge);

  const shutdown = () => { console.log('Stopping.'); bridge.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', e => { console.error('[fatal]', e); process.exit(1); });
}

main();
