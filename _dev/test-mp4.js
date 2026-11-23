const fs = require("fs");
const path = process.argv[2];
const buf = fs.readFileSync(path);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

const str4 = (d, p) => String.fromCharCode(d.getUint8(p), d.getUint8(p+1), d.getUint8(p+2), d.getUint8(p+3));
function* boxes(d, start, end) {
  let p = start, guard = 0;
  while (p + 8 <= end && guard++ < 5000) {
    let size = d.getUint32(p);
    const type = str4(d, p + 4);
    let hl = 8;
    if (size === 1) { size = Number(d.getBigUint64(p + 8)); hl = 16; }
    else if (size === 0) { size = end - p; }
    if (size < hl || p + size > end) break;
    yield { type, start: p + hl, end: p + size };
    p += size;
  }
}
const out = { width:0, height:0, fps:0, duration:0 };
let mvT = 0, mvD = 0;
const tr = { timescale:0, samples:0, delta:0, width:0, height:0 };
function walk(start, end) {
  for (const b of boxes(dv, start, end)) {
    if (b.type === "mvhd") {
      const v = dv.getUint8(b.start);
      if (v === 1) { mvT = dv.getUint32(b.start+20); mvD = Number(dv.getBigUint64(b.start+24)); }
      else { mvT = dv.getUint32(b.start+12); mvD = dv.getUint32(b.start+16); }
    } else if (b.type === "tkhd") {
      const v = dv.getUint8(b.start);
      const wOff = v === 1 ? b.start+88 : b.start+76;
      if (wOff + 8 <= b.end) {
        const w = dv.getUint32(wOff)/65536, h = dv.getUint32(wOff+4)/65536;
        const mOff = v === 1 ? b.start+52 : b.start+40;
        let rot = false;
        if (mOff + 20 <= b.end) {
          const a = dv.getInt32(mOff)/65536, d2 = dv.getInt32(mOff+16)/65536;
          rot = Math.abs(a) < 0.01 && Math.abs(d2) < 0.01;
        }
        if (w && h) { tr.width = rot ? h : w; tr.height = rot ? w : h; }
      }
    } else if (b.type === "mdhd") {
      const v = dv.getUint8(b.start);
      tr.timescale = v === 1 ? dv.getUint32(b.start+20) : dv.getUint32(b.start+12);
    } else if (b.type === "stts") {
      const n = dv.getUint32(b.start+4);
      let s = 0, first = 0;
      for (let i = 0; i < n && i < 8192; i++) {
        const p = b.start+8+i*8;
        if (p+8 > b.end) break;
        if (i === 0) first = dv.getUint32(p+4);
        s += dv.getUint32(p);
      }
      tr.samples = s; tr.delta = first;
    }
    if (["moov","trak","mdia","minf","stbl"].includes(b.type)) walk(b.start, b.end);
  }
}
walk(0, dv.byteLength);
out.width = tr.width; out.height = tr.height;
if (mvT && mvD) out.duration = mvD/mvT;
if (tr.timescale && tr.delta) out.fps = tr.timescale/tr.delta;
else if (tr.samples && out.duration) out.fps = tr.samples/out.duration;
console.log(path.split(/[\\/]/).pop(), JSON.stringify({ w: out.width, h: out.height, fps: Math.round(out.fps*1000)/1000, dur: Math.round(out.duration*10)/10 }));
