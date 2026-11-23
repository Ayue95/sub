const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9297;
const OUT = path.join(__dirname, "shots");
const userDir = path.join(os.tmpdir(), "sub-brand-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,900","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}

(async()=>{
  try{
    const ver = await httpJson("/json/version");
    const browser = await connect(ver.webSocketDebuggerUrl);
    const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
    const list = await httpJson("/json/list");
    const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:3,mobile:false});
    await cdp.send("Page.navigate",{url:"http://127.0.0.1:8017/?t="+Date.now()});
    await sleep(2500);

    const info = await cdp.eval(`(function(){
      var m=document.querySelector('.brand-mark');
      var svg=m&&m.querySelector('svg');
      var c=svg&&svg.querySelector('circle');
      var b=m.getBoundingClientRect();
      var cs=c?getComputedStyle(c):null;
      return {box:{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)},
              circleFill: c?c.getAttribute('fill'):null,
              computedFill: cs?cs.fill:null,
              gradient: !!document.getElementById('brandJelly')};
    })()`);
    console.log("品牌标记：", JSON.stringify(info));

    const { data } = await cdp.send("Page.captureScreenshot",{format:"png", clip:{x:20,y:8,width:120,height:44,scale:6}});
    fs.mkdirSync(OUT,{recursive:true});
    fs.writeFileSync(path.join(OUT,"82-brand-zoom.png"), Buffer.from(data,"base64"));
    console.log("saved 82-brand-zoom.png");
  }catch(e){console.log("ERR",e.message);}finally{chrome.kill();}
})();
