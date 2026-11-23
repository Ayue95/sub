const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9225;
const OUT = path.join(__dirname, "shots");
const DL = path.join(__dirname, "dl2");
const BASE = "E:/01——阿月/技术员同志/测试/102475——CE";
const EXCEL = __dirname.replace(/\\/g, "/") + "/testdata/audit.xlsx";
const HERE = __dirname.replace(/\\/g, "/");
const SRTS = [HERE + "/testdata/01.en.srt", HERE + "/testdata/02.en.srt", HERE + "/testdata/03.en.srt"];
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-check2-" + Date.now());

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

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
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async waitFor(expression, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(expression)) return true;
      await sleep(300);
    }
    throw new Error("超时：" + label);
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(data, "base64"));
    console.log("截图", name);
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
  await cdp.send("DOM.enable");
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DL,
    eventsEnabled: true,
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: URL });

  await cdp.waitFor(
    "!document.getElementById('boot') || document.getElementById('boot').classList.contains('is-hidden')",
    180000,
    "Pyodide 初始化"
  );
  console.log("✓ 环境就绪");

  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  async function setFiles(selector, files) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error("找不到 " + selector);
    await cdp.send("DOM.setFileInputFiles", { files, nodeId });
    await sleep(400);
  }

  await cdp.eval(`document.querySelector('.nav-item[data-page="localize"]').click()`);
  await sleep(300);
  await cdp.shot("10-localize-empty");

  await setFiles("#excelPicker", [EXCEL]);
  await setFiles("#locFilePicker", SRTS);
  console.log("清单：", await cdp.eval("document.getElementById('excelInfo').textContent"));
  console.log("字幕：", await cdp.eval("document.getElementById('locFileInfo').textContent"));
  await cdp.shot("11-localize-picked");

  await cdp.eval("document.getElementById('runScan').click()");
  await cdp.waitFor("!document.getElementById('locWorkspace').hidden", 120000, "扫描结果");
  await sleep(600);

  const report = await cdp.eval(`(function(){
    var out = {};
    out.rows = document.querySelectorAll('#matchList .match-line').length;
    out.numbers = document.querySelectorAll('#matchList .match-no').length;
    out.fileHeads = document.querySelectorAll('#matchList .match-file').length;
    out.oldMeta = document.querySelectorAll('#matchList .match-meta').length;
    out.oldCtxLink = [].filter.call(document.querySelectorAll('#matchList button'), function(b){return b.textContent === '查看上下文';}).length;
    out.pills = document.querySelectorAll('#matchList .match-dst').length;
    out.inputs = document.querySelectorAll('#matchList .match-dst-input').length;
    out.title = document.getElementById('matchTitle').textContent;
    out.sub = document.getElementById('matchSub').textContent;
    out.note = document.getElementById('scanNote').textContent;
    out.logHidden = document.getElementById('locLog').hidden;
    out.stats = document.getElementById('locStats').textContent;
    return out;
  })()`);
  console.log("结构检查：", JSON.stringify(report, null, 2));
  await cdp.shot("12-localize-result");

  // 放大看匹配行的细节
  {
    const r = await cdp.eval(`(function(){var b=document.querySelector('.match-card').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:Math.min(b.height,220)};})()`);
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 },
      captureBeyondViewport: true,
    });
    fs.writeFileSync(path.join(OUT, "17-match-zoom.png"), Buffer.from(data, "base64"));
    console.log("截图 17-match-zoom");
  }

  // 窄一点的窗口看看会不会挤坏
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 940, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await cdp.shot("16-localize-900");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  // 点行号 → 上下文弹窗
  await cdp.eval("document.querySelector('#matchList .match-no').click()");
  await cdp.waitFor("!!document.querySelector('.modal')", 15000, "上下文弹窗");
  await sleep(500);
  console.log(
    "上下文：",
    JSON.stringify(
      await cdp.eval(`(function(){
        var cues = document.querySelectorAll('.modal .cue');
        return {
          title: document.querySelector('.modal-title').textContent,
          cues: cues.length,
          target: document.querySelectorAll('.modal .cue.is-target').length,
          text: document.querySelector('.modal .cue.is-target') ? document.querySelector('.modal .cue.is-target').textContent : ''
        };
      })()`)
    )
  );
  await cdp.shot("13-localize-context");

  await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await sleep(300);
  console.log("Esc 关闭：", !(await cdp.eval("!!document.querySelector('.modal')")));

  // 点译文 → 输入框 → 改成测试译文 → 回车
  await cdp.eval("document.querySelector('#matchList .match-dst').click()");
  await sleep(200);
  console.log("出现输入框：", await cdp.eval("!!document.querySelector('#matchList .match-dst-input')"));
  await cdp.eval(`(function(){
    var i = document.querySelector('#matchList .match-dst-input');
    i.value = '测试译文';
    i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  })()`);
  await sleep(300);
  console.log(
    "改后：",
    JSON.stringify(
      await cdp.eval(`(function(){
        var b = document.querySelector('#matchList .match-dst');
        return { text: b.textContent, edited: b.classList.contains('is-edited'), inputGone: !document.querySelector('#matchList .match-dst-input') };
      })()`)
    )
  );
  await cdp.shot("14-localize-edited");

  // 应用替换 → 下载 ZIP → 检查测试译文写进文件
  await cdp.eval("document.getElementById('applyReplace').click()");
  await cdp.waitFor("!document.getElementById('locResult').hidden", 120000, "替换结果");
  console.log("结果按钮：", await cdp.eval("[...document.querySelectorAll('#locResultActions button')].map(b=>b.textContent).join(' | ')"));
  await cdp.eval("[...document.querySelectorAll('#locResultActions button')].find(b=>b.textContent.startsWith('下载')).click()");
  await sleep(3000);
  console.log("下载目录：", fs.readdirSync(DL));
  await cdp.shot("15-localize-saved");

  // 术语巡检报告
  console.log("巡检卡片可见：", !(await cdp.eval("document.getElementById('locAudit').hidden")));
  console.log("巡检结论：", await cdp.eval("document.getElementById('auditSum').innerText"));
  console.log("巡检分块：", await cdp.eval("[...document.querySelectorAll('#auditBody .pre-issue-card')].map(c=>c.querySelector('.pre-issue-title').innerText.replace(/\\s+/g,' ')).join(' / ')"));
  console.log("巡检明细：");
  console.log(await cdp.eval("[...document.querySelectorAll('#auditBody .pre-issue-row')].map(r=>r.innerText.replace(/\\s+/g,' ')).join('\\n')"));
  await cdp.eval("window.scrollTo(0, document.body.scrollHeight)");
  await sleep(400);
  await cdp.shot("40-audit");
  await cdp.eval("document.getElementById('saveAudit').click()");
  await sleep(1500);
  console.log("下载目录（含巡检报告）：", fs.readdirSync(DL));

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
