const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9224;
const OUT = path.join(__dirname, "shots");
const URL = "http://127.0.0.1:8017/" + encodeURI("_预览/预览区方案.html") + "?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-plan-" + Date.now());

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir,
    "--window-size=1200,1000",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(p) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:" + PORT + p);
      return await r.json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error("devtools not ready");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(new CDP(ws)));
    ws.addEventListener("error", reject);
  });
}

(async () => {
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const list = await httpJson("/json/list");
  const page = list.find((t) => t.id === targetId);
  const cdp = await connect(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: URL });
  await sleep(1600);

  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "document.documentElement.scrollHeight",
    returnByValue: true,
  });
  const height = Math.min(result.value + 20, 8000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "08-plan.png"), Buffer.from(data, "base64"));
  console.log("saved 08-plan.png", 1200, height);

  // 再按方案逐块截一张，方便放大看细节
  const { result: rects } = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify([...document.querySelectorAll('.plan')].map(p=>{const r=p.getBoundingClientRect();return {x:r.x,y:r.y+window.scrollY,w:r.width,h:r.height};}))`,
    returnByValue: true,
  });
  const list2 = JSON.parse(rects.value);
  for (let i = 0; i < list2.length; i++) {
    const r = list2[i];
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: Math.max(0, r.x - 6), y: r.y - 6, width: r.w + 12, height: r.h + 12, scale: 1 },
      captureBeyondViewport: true,
    });
    fs.writeFileSync(path.join(OUT, `08-plan-${i + 1}.png`), Buffer.from(shot.data, "base64"));
    console.log("saved plan", i + 1, Math.round(r.w), Math.round(r.h));
  }

  await browser.send("Target.closeTarget", { targetId });
  chrome.kill();
  await sleep(300);
  fs.rmSync(userDir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e.message);
  chrome.kill();
  process.exit(1);
});
