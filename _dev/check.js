const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9224;
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-check-" + Date.now());

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir,
    "--window-size=1440,900",
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
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push("EXC " + JSON.stringify(msg.params.exceptionDetails.text));
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push("CONSOLE " + msg.params.args.map((a) => a.value || a.description).join(" "));
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
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
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
  const cdp = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: URL });
  await sleep(6000);

  const report = await cdp.eval(`(function(){
    var out = {};
    out.pages = [].map.call(document.querySelectorAll('.page'), function(p){
      return p.id + ':' + (p.classList.contains('is-active') ? 'active' : 'off');
    });
    out.repairLangs = document.querySelectorAll('#langChips .language-choice').length;
    out.projSrc = document.querySelectorAll('#projSrc .language-choice').length;
    out.projDst = document.querySelectorAll('#projDst .language-choice').length;
    out.repairChecked = (document.querySelector('#langChips input:checked')||{}).value;
    out.projSrcChecked = (document.querySelector('#projSrc input:checked')||{}).value;
    out.projDstChecked = (document.querySelector('#projDst input:checked')||{}).value;
    out.paneCols = document.querySelector('#page-repair .pane')
      ? getComputedStyle(document.querySelector('#page-repair .pane')).gridTemplateColumns
      : 'n/a';
    out.cardsRepair = document.querySelectorAll('#page-repair .card').length;
    out.ambientImgs = document.querySelectorAll('.ambient img').length;
    out.bootGone = !document.getElementById('boot') || document.getElementById('boot').classList.contains('is-hidden');

    // 点一下「英语」，确认能切换
    var en = document.querySelectorAll('#langChips .language-choice input')[1];
    en.click();
    out.afterClick = (document.querySelector('#langChips input:checked')||{}).value;

    // 切到立项页，确认导航正常
    document.querySelector('.nav-item[data-page="project"]').click();
    out.projectActive = document.getElementById('page-project').classList.contains('is-active');
    out.coverOff = !document.body.classList.contains('is-cover');

    // 点「西语」看两个分组互不干扰
    var es = document.querySelectorAll('#projDst .language-choice input')[2];
    es.click();
    out.projDstAfter = (document.querySelector('#projDst input:checked')||{}).value;
    out.projSrcStill = (document.querySelector('#projSrc input:checked')||{}).value;
    return out;
  })()`);

  console.log(JSON.stringify(report, null, 2));
  console.log("ERRORS:", cdp.errors.length ? cdp.errors : "none");

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
