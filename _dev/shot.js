const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9223;
const OUT = path.join(__dirname, "shots");
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-shot-" + Date.now());

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir,
    "--window-size=1440,900",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
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

  const shots = [
    { name: "01-cover", width: 1440, height: 900, page: "home" },
    { name: "02-repair", width: 1440, height: 900, page: "repair" },
    { name: "03-project", width: 1440, height: 900, page: "project" },
    { name: "04-localize", width: 1440, height: 900, page: "localize" },
    { name: "05-repair-1920", width: 1920, height: 1080, page: "repair" },
    { name: "06-project-1920", width: 1920, height: 1080, page: "project" },
    { name: "07-repair-narrow", width: 820, height: 900, page: "repair" },
  ];

  let loaded = false;
  for (const s of shots) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: s.width,
      height: s.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    if (!loaded) {
      await cdp.send("Page.navigate", { url: URL });
      await sleep(4500);
      loaded = true;
    }

    // 跳过启动遮罩，直接看界面
    await cdp.send("Runtime.evaluate", {
      expression: `
        (function(){
          var b = document.getElementById('boot');
          if (b) b.remove();
          var t = document.querySelector('.nav-item[data-page="${s.page}"]');
          if (t) t.click();
          window.scrollTo(0,0);
        })()
      `,
    });
    await sleep(700);

    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, s.name + ".png"), Buffer.from(data, "base64"));
    console.log("saved", s.name);
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
