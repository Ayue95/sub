const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9271;
const OUT = path.join(__dirname, "shots");
const HERE = __dirname.replace(/\\/g, "/");
const EXCEL = HERE + "/testdata/audit.xlsx";
const URL = "http://127.0.0.1:8017/?t=" + Date.now();
const userDir = path.join(os.tmpdir(), "sub-all-" + Date.now());
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
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.send("Page.navigate",{url:URL});
  await cdp.waitFor("!document.getElementById('boot') || document.getElementById('boot').classList.contains('is-hidden')",180000,"初始化");
  console.log("✓ 环境就绪");

  await cdp.eval(`(async function(){
    const names = ["01.en.srt","02.en.srt","03.en.srt"];
    const blobs = {};
    for (const n of names) blobs[n] = await (await fetch("/_预览/testdata/" + n)).blob();
    window.__writes = [];
    window.showDirectoryPicker = async (opts) => {
      const isRepair = opts && opts.id === "sub-repair-in";
      const folderName = isRepair ? "剧集甲" : "剧集乙";
      const entries = names.map(n => ({ kind:"file", name:n, getFile: async () => new File([blobs[n]], n) }));
      return {
        name: folderName,
        values: async function* () { for (const e of entries) yield e; },
        getDirectoryHandle: async (dn) => ({
          name: dn,
          getFileHandle: async (fn) => ({
            createWritable: async () => ({
              write: async (d) => window.__writes.push({ parent: folderName, dir: dn, file: fn, size: d.byteLength || d.size || 0 }),
              close: async () => {},
            }),
          }),
        }),
      };
    };
  })()`);

  // ---------- SRT 修复 ----------
  await cdp.eval(`document.querySelector('.nav-item[data-page="repair"]').click()`);
  await sleep(400);
  await cdp.eval("document.getElementById('pickFolder').click()");
  await cdp.waitFor("document.getElementById('fileInfo').textContent.trim().length > 0", 15000, "修复选文件夹");
  console.log("[修复] 选到：", await cdp.eval("document.getElementById('fileInfo').textContent"));
  await cdp.eval("document.getElementById('runRepair').click()");
  await cdp.waitFor("!document.getElementById('repairResult').hidden", 150000, "修复结果");
  await sleep(1500);
  console.log("[修复] 结果区：", await cdp.eval("document.getElementById('repairResult').innerText.replace(/\\s+/g,' ')"));
  console.log("[修复] 写入：", JSON.stringify((await cdp.eval("window.__writes")).filter(w=>w.dir==="修复")));
  await cdp.eval("window.scrollTo(0, document.body.scrollHeight)");
  await sleep(400);
  let shot = await cdp.send("Page.captureScreenshot",{format:"png"});
  fs.mkdirSync(OUT,{recursive:true});
  fs.writeFileSync(path.join(OUT,"43-repair-auto.png"), Buffer.from(shot.data,"base64"));

  // ---------- ST↔TT ----------
  await cdp.eval("window.__writes = []");
  await cdp.eval(`document.querySelector('.nav-item[data-page="localize"]').click()`);
  await sleep(400);
  const { root } = await cdp.send("DOM.getDocument",{depth:-1});
  const { nodeId } = await cdp.send("DOM.querySelector",{nodeId:root.nodeId,selector:"#excelPicker"});
  await cdp.send("DOM.setFileInputFiles",{files:[EXCEL],nodeId});
  await sleep(600);
  await cdp.eval("document.getElementById('locPickFolder').click()");
  await cdp.waitFor("document.getElementById('locFileInfo').textContent.trim().length > 0", 15000, "替换选文件夹");
  await cdp.eval("document.getElementById('runScan').click()");
  await cdp.waitFor("!document.getElementById('locWorkspace').hidden", 120000, "扫描");
  await cdp.eval("document.getElementById('applyReplace').click()");
  await cdp.waitFor("!document.getElementById('locResult').hidden", 120000, "替换");
  await sleep(1200);
  console.log("[替换] 结果区：", await cdp.eval("document.getElementById('locResult').innerText.replace(/\\s+/g,' ')"));
  console.log("[替换] 写入：", JSON.stringify((await cdp.eval("window.__writes")).filter(w=>w.dir==="替换")));
  console.log("[替换] 巡检结论：", await cdp.eval("document.getElementById('auditSum').innerText"));
  await cdp.eval("window.scrollTo(0, document.body.scrollHeight)");
  await sleep(400);
  shot = await cdp.send("Page.captureScreenshot",{format:"png"});
  fs.writeFileSync(path.join(OUT,"44-localize-auto.png"), Buffer.from(shot.data,"base64"));
  console.log("截图已保存");

  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
