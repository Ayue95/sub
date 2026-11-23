const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9295;
const OUT = path.join(__dirname, "shots");
const URL_LIVE = "https://ayue95.github.io/sub/";
const HERE = __dirname.replace(/\\/g, "/");
const SRT1 = HERE + "/testdata/01.en.srt";
const SRT2 = HERE + "/testdata/02.en.srt";
const SRT3 = HERE + "/testdata/03.en.srt";
const userDir = path.join(os.tmpdir(), "sub-live2-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,900","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}else if(m.method){this.events.push(m);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}

(async()=>{
  try {
    const ver = await httpJson("/json/version");
    const browser = await connect(ver.webSocketDebuggerUrl);
    const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
    const list = await httpJson("/json/list");
    const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable"); await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cdp.send("Page.navigate",{url:URL_LIVE + "?t=" + Date.now()});
    await sleep(3000);

    // 切到 SRT 修复页
    await cdp.eval(`document.querySelector('.nav-item[data-page="repair"]').click()`);
    await sleep(500);

    // 塞文件
    const doc = await cdp.send("DOM.getDocument",{depth:-1});
    const node = await cdp.send("DOM.querySelector",{nodeId:doc.root.nodeId, selector:"#filePicker"});
    await cdp.send("DOM.setFileInputFiles",{nodeId:node.nodeId, files:[SRT1, SRT2, SRT3]});
    await sleep(800);
    console.log("=== 已选文件文案 ===", JSON.stringify(await cdp.eval("document.getElementById('fileInfo').textContent")));
    console.log("=== 按钮可用 ===", await cdp.eval("!document.getElementById('runRepair').disabled"));

    // 点开始修复，等结果（首次要下载 Python 运行时，可能久）
    await cdp.eval("document.getElementById('runRepair').click()");
    let done = false;
    for (let i=0;i<120;i++){
      const vis = await cdp.eval("!document.getElementById('repairResult').hidden");
      if (vis) { done = true; break; }
      await sleep(2000);
    }
    console.log("=== 出结果 ===", done);
    if (done) {
      console.log("=== 摘要 ===", JSON.stringify((await cdp.eval("(document.getElementById('resultSummary')||{}).textContent||''")).slice(0,200)));
      const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
      fs.mkdirSync(OUT,{recursive:true});
      fs.writeFileSync(path.join(OUT,"81-live-repair.png"), Buffer.from(data,"base64"));
      console.log("saved 81-live-repair.png");
    }

    const errors = cdp.events.filter(e => e.method === "Runtime.exceptionThrown").map(e => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text);
    const bad = cdp.events.filter(e => e.method === "Network.responseReceived" && e.params.response.status >= 400).map(e => e.params.response.status + " " + e.params.response.url);
    console.log("=== JS 异常 ===", errors.length ? JSON.stringify(errors.slice(0,3)) : "无");
    console.log("=== 4xx/5xx ===", bad.length ? JSON.stringify(bad.slice(0,5)) : "无");
  } catch (e) {
    console.log("ERR", e.message);
  } finally {
    chrome.kill();
  }
})();
