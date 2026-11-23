const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9293;
const OUT = path.join(__dirname, "shots");
const URL_LIVE = "https://ayue95.github.io/sub/";
const userDir = path.join(os.tmpdir(), "sub-live-" + Date.now());
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
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cdp.send("Page.navigate",{url:URL_LIVE + "?t=" + Date.now()});
    await sleep(4000);

    // 收集错误
    const errors = cdp.events.filter(e => e.method === "Runtime.exceptionThrown").map(e => e.params.exceptionDetails.text + " " + (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || ""));
    const failed = cdp.events.filter(e => e.method === "Network.loadingFailed").map(e => e.params.errorText + " " + (e.params.requestId||""));
    const bad = cdp.events.filter(e => e.method === "Network.responseReceived" && e.params.response.status >= 400).map(e => e.params.response.status + " " + e.params.response.url);

    console.log("=== 页面标题 ===", await cdp.eval("document.title"));
    console.log("=== 首页可见 ===", await cdp.eval("!!document.getElementById('page-home')"));

    // 等 Python 运行时
    let badge = "";
    for (let i=0;i<40;i++){
      badge = await cdp.eval("(function(){var b=document.getElementById('pyBadge');return b?b.textContent:'';})()");
      if (badge && badge.indexOf("就绪")>=0) break;
      await sleep(1500);
    }
    console.log("=== 运行时状态 ===", JSON.stringify(badge));

    // 切到四个功能页看是否渲染
    for (const page of ["project","precheck","localize","repair"]) {
      await cdp.eval(`document.querySelector('.nav-item[data-page="${page}"]').click()`);
      await sleep(400);
      const box = await cdp.eval(`(function(){var p=document.getElementById('page-${page}');var b=p.getBoundingClientRect();var h=p.querySelector('.page-head h2');return {left:Math.round(b.left),width:Math.round(b.width),title:h?h.textContent:''};})()`);
      console.log("页面", page, JSON.stringify(box));
    }

    await cdp.eval(`document.querySelector('.nav-item[data-page="precheck"]').click()`);
    await sleep(600);
    fs.mkdirSync(OUT,{recursive:true});
    const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(OUT,"80-live.png"), Buffer.from(data,"base64"));
    console.log("saved 80-live.png");

    console.log("=== JS 异常 ===", errors.length ? JSON.stringify(errors.slice(0,5)) : "无");
    console.log("=== 请求失败 ===", failed.length ? JSON.stringify(failed.slice(0,5)) : "无");
    console.log("=== 4xx/5xx ===", bad.length ? JSON.stringify(bad.slice(0,5)) : "无");
  } catch (e) {
    console.log("ERR", e.message);
  } finally {
    chrome.kill();
  }
})();
