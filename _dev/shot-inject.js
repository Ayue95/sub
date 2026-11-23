const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9289;
const OUT = path.join(__dirname, "shots");
const userDir = path.join(os.tmpdir(), "sub-inj-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,900","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}

const SAY = "查缺集、空集、重复集、命名规范，并列出每集分辨率与帧率";

const INJECT = {
  A: `<div style="text-align:center;font-size:13.5px;line-height:1.6;color:#8e8e9a;margin-bottom:18px">${SAY}</div>`,
  B: `<div style="font-size:13.5px;line-height:1.6;color:#55555f;border-left:3px solid #e8a0be;padding-left:13px;margin-bottom:18px">${SAY}</div>`,
  C: `<div style="text-align:center;margin-bottom:18px"><span style="display:inline-block;background:#fbeaf2;color:#a8577d;font-size:13.5px;line-height:1.6;padding:9px 18px;border-radius:999px">${SAY}</span></div>`,
  D: `<div style="margin-bottom:18px"><div style="font-size:19px;font-weight:600;letter-spacing:.5px;margin-bottom:7px;color:#2d2d3a">原剧体检</div><div style="font-size:13.5px;line-height:1.6;color:#8e8e9a">${SAY}</div></div>`,
};

(async()=>{
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:2,mobile:false});
  await cdp.send("Page.navigate",{url:"http://127.0.0.1:8017/?t="+Date.now()});
  await sleep(2600);
  await cdp.eval("var b=document.getElementById('boot'); if(b) b.remove();");
  await cdp.eval(`document.querySelector('.nav-item[data-page="precheck"]').click()`);
  await sleep(600);
  fs.mkdirSync(OUT,{recursive:true});

  for (const key of ["A","B","C","D"]) {
    await cdp.eval(`(function(){
      var old=document.getElementById('injHint'); if(old) old.remove();
      var p=document.getElementById('page-precheck');
      var d=document.createElement('div');
      d.id='injHint';
      d.innerHTML=${JSON.stringify(INJECT[key])};
      p.insertBefore(d, p.firstChild);
    })()`);
    await sleep(320);
    const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(OUT, "71-real-" + key + ".png"), Buffer.from(data,"base64"));
    console.log("saved 71-real-" + key + ".png");
  }

  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
