const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9285;
const OUT = path.join(__dirname, "shots");
const userDir = path.join(os.tmpdir(), "sub-mob-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=390,844","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}
(async()=>{
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await cdp.send("Page.navigate",{url:"http://127.0.0.1:8017/?t="+Date.now()});
  await sleep(2500);
  await cdp.eval("var b=document.getElementById('boot'); if(b) b.remove();");
  await sleep(300);
  fs.mkdirSync(OUT,{recursive:true});
  await cdp.eval(`document.querySelector('.nav-item[data-page="localize"]').click()`);
  await sleep(500);
  const info = await cdp.eval(`(function(){
    var p=document.getElementById('page-localize');
    var pr=p.getBoundingClientRect();
    return Array.from(p.querySelectorAll('.drop')).map(function(d){
      var dr=d.getBoundingClientRect(), r=d.querySelector('.row').getBoundingClientRect();
      return {h:Math.round(dr.height), left:Math.round(dr.left), right:Math.round(dr.right),
              rowRight:Math.round(r.right), rowH:Math.round(r.height),
              overflow: r.right > dr.right + 1};
    });
  })()`);
  console.log("窄屏 390px 两张卡：", JSON.stringify(info));
  const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
  fs.writeFileSync(path.join(OUT, "60-mobile-precheck.png"), Buffer.from(data,"base64"));
  console.log("saved 60-mobile-precheck.png");
  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
