const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9231;
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const userDir = path.join(os.tmpdir(), "sub-icon2-" + Date.now());

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + userDir,
  "--window-size=560,560",
  "--hide-scrollbars",
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + PORT + p);
      return await r.json();
    } catch { await sleep(250); }
  }
  throw new Error("devtools 没起来");
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    ws.addEventListener("open", () => res(new CDP(ws)));
    ws.addEventListener("error", rej);
  });
}

// 手工拼 ICO（Vista 起支持内嵌 PNG）
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);

  const dirs = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    d.writeUInt8(0, 2);
    d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dirs.push(d);
  }
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.png)]);
}

(async () => {
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 560, height: 560, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  const fileUrl = "file:///" + path.join(__dirname, "favicon.html").replace(/\\/g, "/");
  await cdp.send("Page.navigate", { url: fileUrl });
  await sleep(1500);

  const plan = [
    { size: 512, name: "apple-512.png" },
    { size: 180, name: "apple-180.png" },
    { size: 48, name: "apple-48.png" },
    { size: 32, name: "favicon-32.png" },
    { size: 16, name: "favicon-16.png" },
  ];

  const pngs = {};
  for (const p of plan) {
    await cdp.eval(`(function(){
      var s = document.getElementById('icon');
      s.setAttribute('width', ${p.size});
      s.setAttribute('height', ${p.size});
      window.scrollTo(0,0);
    })()`);
    await sleep(280);
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: p.size, height: p.size, scale: 1 },
      captureBeyondViewport: true,
    });
    const buf = Buffer.from(data, "base64");
    fs.writeFileSync(path.join(ASSETS, p.name), buf);
    pngs[p.size] = buf;
    console.log("saved assets/" + p.name, p.size + "×" + p.size);
  }

  const ico = buildIco([
    { size: 16, png: pngs[16] },
    { size: 32, png: pngs[32] },
    { size: 48, png: pngs[48] },
  ]);
  fs.writeFileSync(path.join(ASSETS, "favicon.ico"), ico);
  console.log("saved assets/favicon.ico", ico.length, "bytes");

  await browser.send("Target.closeTarget", { targetId });
  chrome.kill();
  await sleep(200);
  fs.rmSync(userDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e.message);
  chrome.kill();
  process.exit(1);
});
