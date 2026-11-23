const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9293;
const OUT = path.join(__dirname, "shots");
const userDir = path.join(os.tmpdir(), "sub-inj3-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,900","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}

const PAGES = [
  { id: "project",  title: "一键立项",  desc: "生成标准化的影视本地化多级目录结构与术语清单" },
  { id: "precheck", title: "原剧体检",  desc: "检查缺集、空集、重复集与命名规范，逐集输出分辨率与帧率" },
  { id: "localize", title: "ST ↔ TT",  desc: "按清单列批量替换字幕术语，替换后巡检冲突与残留" },
  { id: "repair",   title: "SRT 修复", desc: "修复 SRT 格式问题：时间轴归一化、编码检测、行尾清理、语言混杂检测" },
];

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
  fs.mkdirSync(OUT,{recursive:true});

  for (const p of PAGES) {
    await cdp.eval(`document.querySelector('.nav-item[data-page="${p.id}"]').click()`);
    await sleep(520);
    await cdp.eval(`(function(){
      var old=document.getElementById('injHint'); if(old) old.remove();
      var pg=document.getElementById('page-${p.id}');
      var d=document.createElement('div');
      d.id='injHint';
      d.innerHTML='<div style="border-left:3px solid #e8a0be;padding-left:13px;margin-bottom:18px">'
        + '<div style="font-size:19px;font-weight:600;letter-spacing:.5px;margin-bottom:6px;color:#2d2d3a">${p.title}</div>'
        + '<div style="font-size:13.5px;line-height:1.6;color:#8e8e9a">${p.desc}</div></div>';
      pg.insertBefore(d, pg.firstChild);
    })()`);
    await sleep(300);
    const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
    fs.writeFileSync(path.join(OUT, "73-head-" + p.id + ".png"), Buffer.from(data,"base64"));
    console.log("saved 73-head-" + p.id + ".png");
  }

  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
