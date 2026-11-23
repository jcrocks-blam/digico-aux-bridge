'use strict';
// Minimal OSC 1.0 encoder/decoder (no dependencies).
// Supports type tags: i f s b T F N I d h, and bundles (decoded and flattened).

function pad4(n) { return (4 - (n % 4)) % 4; }

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('OSC string not terminated');
  const str = buf.toString('utf8', off, end);
  const next = end + 1 + pad4(end + 1 - off);
  return [str, next];
}

function encString(str) {
  const b = Buffer.from(String(str), 'utf8');
  const len = b.length + 1;
  const out = Buffer.alloc(len + pad4(len));
  b.copy(out, 0);
  return out;
}

function decodeMessage(buf, off, end) {
  let address, tags;
  [address, off] = readString(buf, off);
  const args = [];
  if (off >= end) return { address, args }; // no type tag string (old style)
  [tags, off] = readString(buf, off);
  if (tags[0] !== ',') return { address, args };
  for (const t of tags.slice(1)) {
    switch (t) {
      case 'i': args.push({ type: 'i', value: buf.readInt32BE(off) }); off += 4; break;
      case 'f': args.push({ type: 'f', value: buf.readFloatBE(off) }); off += 4; break;
      case 'd': args.push({ type: 'd', value: buf.readDoubleBE(off) }); off += 8; break;
      case 'h': args.push({ type: 'h', value: Number(buf.readBigInt64BE(off)) }); off += 8; break;
      case 's': case 'S': { let s; [s, off] = readString(buf, off); args.push({ type: 's', value: s }); break; }
      case 'b': {
        const n = buf.readInt32BE(off); off += 4;
        args.push({ type: 'b', value: buf.subarray(off, off + n) });
        off += n + pad4(n); break;
      }
      case 'T': args.push({ type: 'T', value: true }); break;
      case 'F': args.push({ type: 'F', value: false }); break;
      case 'N': args.push({ type: 'N', value: null }); break;
      case 'I': args.push({ type: 'I', value: Infinity }); break;
      default: throw new Error('Unsupported OSC type tag ' + t);
    }
  }
  return { address, args };
}

// Returns an array of messages (bundles are flattened).
function decode(buf) {
  const out = [];
  const walk = (start, end) => {
    if (buf.toString('ascii', start, start + 8) === '#bundle\0') {
      let off = start + 16; // '#bundle\0' + timetag
      while (off + 4 <= end) {
        const size = buf.readInt32BE(off); off += 4;
        walk(off, off + size);
        off += size;
      }
    } else {
      out.push(decodeMessage(buf, start, end));
    }
  };
  walk(0, buf.length);
  return out;
}

// args: array of {type, value} or plain JS values (number -> f, int via {type:'i'}, string -> s)
function encode(address, args = []) {
  const norm = args.map(a => (a && typeof a === 'object' && 'type' in a) ? a
    : typeof a === 'string' ? { type: 's', value: a }
    : typeof a === 'boolean' ? { type: a ? 'T' : 'F', value: a }
    : { type: 'f', value: Number(a) });
  const parts = [encString(address), encString(',' + norm.map(a => a.type).join(''))];
  for (const a of norm) {
    if (a.type === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0); parts.push(b); }
    else if (a.type === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(a.value); parts.push(b); }
    else if (a.type === 'd') { const b = Buffer.alloc(8); b.writeDoubleBE(a.value); parts.push(b); }
    else if (a.type === 's') parts.push(encString(a.value));
    else if (a.type === 'b') {
      const n = Buffer.alloc(4); n.writeInt32BE(a.value.length);
      parts.push(n, a.value, Buffer.alloc(pad4(a.value.length)));
    }
  }
  return Buffer.concat(parts);
}

function argsToString(args) {
  return args.map(a => a.type === 's' ? JSON.stringify(a.value)
    : a.type === 'f' ? (Math.round(a.value * 1000) / 1000).toString()
    : a.type === 'b' ? `<blob ${a.value.length}>` : String(a.value)).join(' ');
}

module.exports = { decode, encode, argsToString };
