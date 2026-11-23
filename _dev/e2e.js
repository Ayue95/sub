const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9225;
const OUT = path.join(__dirname, "dl");
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-e2e-" + Date.now());

const BASE = "E:/01——阿月/技术员同志/测试/102475——CE";
const EXCEL = BASE + "/本地化清单.xlsx";
const HERE = __dirname.replace(/\\/g, "/");
const SRTS = [
  HERE + "/testdata/01.en.srt",
  HERE + "/testdata/02.en.srt",
  HERE + "/testdata/03.en.srt",
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

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
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async waitFor(expression, timeout = 90000, label = "") {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.eval(expression)) return true;
      await sleep(400);
    }
    throw new Error("超时等待：" + label);
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
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: OUT,
    eventsEnabled: true,
  });

  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");

  // 无头浏览器没有真实的「选择文件夹」弹窗，这里装一个假目录，验证写文件流程
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__saved = [];
      function fakeDir(name) {
        return {
          name,
          getDirectoryHandle: async (n) => { window.__saved.push({ dir: n }); return fakeDir(n); },
          getFileHandle: async (n) => ({
            createWritable: async () => ({
              write: async (d) => window.__saved.push({ file: n, bytes: d.length }),
              close: async () => {},
            }),
          }),
        };
      }
      window.showDirectoryPicker = async () => fakeDir("测试目录");
    `,
  });

  await cdp.send("Page.navigate", { url: URL });

  // 等运行环境就绪（启动遮罩消失）
  await cdp.waitFor(
    "!document.getElementById('boot') || document.getElementById('boot').classList.contains('is-hidden')",
    180000,
    "Pyodide 初始化"
  );
  console.log("✓ 运行环境就绪");

  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  async function setFiles(selector, files) {
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error("找不到 " + selector);
    await cdp.send("DOM.setFileInputFiles", { files, nodeId });
    await sleep(400);
  }

  // ---------- 1. SRT 修复 ----------
  await cdp.eval(`document.querySelector('.nav-item[data-page="repair"]').click()`);
  await sleep(300);
  await setFiles("#filePicker", SRTS);
  console.log("修复页已选文件：", await cdp.eval("document.getElementById('fileInfo').textContent"));

  await cdp.eval("document.getElementById('runRepair').click()");
  await cdp.waitFor("!document.getElementById('repairResult').hidden", 120000, "修复结果");
  console.log("修复摘要：", await cdp.eval("document.getElementById('resultSummary').innerText"));
  console.log(
    "修复按钮：",
    await cdp.eval("[...document.querySelectorAll('#resultActions button')].map(b=>b.textContent).join(' | ')")
  );

  await cdp.eval("document.querySelector('#resultActions .btn.primary').click()");
  await sleep(1200);
  console.log("修复保存到文件夹：", JSON.stringify(await cdp.eval("window.__saved")));
  await cdp.eval("window.__saved = []");
  await cdp.eval(
    "[...document.querySelectorAll('#resultActions button')].find(b=>b.textContent.startsWith('下载')).click()"
  );
  await sleep(2500);

  // ---------- 2. ST↔TT 替换 ----------
  await cdp.eval(`document.querySelector('.nav-item[data-page="localize"]').click()`);
  await sleep(300);
  await setFiles("#excelPicker", [EXCEL]);
  await setFiles("#locFilePicker", SRTS);
  console.log("替换页清单：", await cdp.eval("document.getElementById('excelInfo').textContent"));

  console.log("扫描按钮可用：", !(await cdp.eval("document.getElementById('runScan').disabled")));
  await cdp.eval("document.getElementById('runScan').click()");
  try {
    await cdp.waitFor("!document.getElementById('locWorkspace').hidden", 120000, "扫描结果");
  } catch (e) {
    console.log("扫描日志：", await cdp.eval("document.getElementById('locLog').innerText"));
    throw e;
  }
  console.log("扫描日志：", await cdp.eval("document.getElementById('locLog').innerText"));

  await cdp.eval("document.getElementById('applyReplace').click()");
  await cdp.waitFor("!document.getElementById('locResult').hidden", 120000, "替换结果");
  console.log("替换摘要：", await cdp.eval("document.getElementById('locResultSummary').innerText"));
  console.log(
    "替换按钮：",
    await cdp.eval("[...document.querySelectorAll('#locResultActions button')].map(b=>b.textContent).join(' | ')")
  );

  await cdp.eval("document.querySelector('#locResultActions .btn.primary').click()");
  await sleep(1200);
  console.log("替换保存到文件夹：", JSON.stringify(await cdp.eval("window.__saved")));

  // 再点一次 ZIP 备用入口，确认压缩包结构没坏
  await cdp.eval(
    "[...document.querySelectorAll('#locResultActions button')].find(b=>b.textContent.startsWith('下载')).click()"
  );
  await sleep(2500);

  console.log("下载目录：", fs.readdirSync(OUT));

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
