const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9261;
const OUT = path.join(__dirname, "shots");
const HERE = __dirname.replace(/\\/g, "/");
const EXCEL = HERE + "/testdata/audit.xlsx";
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-auto-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,1000","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}async waitFor(expr,timeout,label){const t0=Date.now();while(Date.now()-t0<timeout){try{if(await this.eval(expr))return true;}catch{}await sleep(400);}throw new Error("等待超时："+label);}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}
(async()=>{
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
  const errors = [];
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("DOM.enable");
  await cdp.send("Runtime.exceptionThrown").catch(()=>{});
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.send("Page.navigate",{url:URL});
  await cdp.waitFor("!document.getElementById('boot') || document.getElementById('boot').classList.contains('is-hidden')",180000,"初始化");
  console.log("✓ 环境就绪");

  // 模拟「选择文件夹」：返回可写目录句柄
  await cdp.eval(`(async function(){
    const names = ["01.en.srt","02.en.srt","03.en.srt"];
    const entries = [];
    for (const n of names) {
      const blob = await (await fetch("/_预览/testdata/" + n)).blob();
      entries.push({ kind: "file", name: n, getFile: async () => new File([blob], n) });
    }
    window.__writes = [];
    window.showDirectoryPicker = async () => ({
      name: "102475",
      values: async function* () { for (const e of entries) yield e; },
      getDirectoryHandle: async (dn) => ({
        name: dn,
        getFileHandle: async (fn) => ({
          createWritable: async () => ({
            write: async (d) => window.__writes.push({ dir: dn, file: fn, size: d.byteLength || d.size || 0 }),
            close: async () => {},
          }),
        }),
      }),
    });
  })()`);

  await cdp.eval(`document.querySelector('.nav-item[data-page="localize"]').click()`);
  await sleep(300);

  const { root } = await cdp.send("DOM.getDocument",{depth:-1});
  const { nodeId } = await cdp.send("DOM.querySelector",{nodeId:root.nodeId,selector:"#excelPicker"});
  await cdp.send("DOM.setFileInputFiles",{files:[EXCEL],nodeId});
  await sleep(600);

  await cdp.eval("document.getElementById('locPickFolder').click()");
  await cdp.waitFor("document.getElementById('locFileInfo').textContent.trim().length > 0", 15000, "选文件夹");
  console.log("选到文件：", await cdp.eval("document.getElementById('locFileInfo').textContent"));

  await cdp.eval("document.getElementById('runScan').click()");
  await cdp.waitFor("!document.getElementById('locWorkspace').hidden", 120000, "扫描");
  await cdp.eval("document.getElementById('applyReplace').click()");
  await cdp.waitFor("!document.getElementById('locResult').hidden", 120000, "替换");
  await sleep(1200);

  console.log("结果区：", await cdp.eval("document.getElementById('locResult').innerText.replace(/\\s+/g,' ')"));
  console.log("写入记录：", JSON.stringify(await cdp.eval("window.__writes")));
  console.log("还有保存按钮吗：", await cdp.eval("!!document.querySelector('#locResultActions .btn.primary')"));
  console.log("巡检卡片：", await cdp.eval("!document.getElementById('locAudit').hidden"));
  console.log("巡检保存按钮存在吗：", await cdp.eval("!!document.getElementById('saveAudit')"));
  console.log("巡检结论：", await cdp.eval("document.getElementById('auditSum').innerText"));

  await cdp.eval("window.scrollTo(0, document.body.scrollHeight)");
  await sleep(500);
  const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
  fs.mkdirSync(OUT,{recursive:true});
  fs.writeFileSync(path.join(OUT,"42-auto-save.png"), Buffer.from(data,"base64"));
  console.log("saved 42-auto-save.png");

  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
