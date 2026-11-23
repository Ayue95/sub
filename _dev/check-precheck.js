const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROME = "C://Program Files//Google//Chrome//Application//chrome.exe";
const PORT = 9251;
const OUT = path.join(__dirname, "shots");
const SRC = "E:/01——阿月/技术员同志/测试/102475——CE/原剧";
const userDir = path.join(os.tmpdir(), "sub-pc-" + Date.now());
const chrome = spawn(CHROME, ["--headless=new","--remote-debugging-port="+PORT,"--user-data-dir="+userDir,"--window-size=1440,1000","--hide-scrollbars","--no-first-run","about:blank"], {stdio:"ignore"});
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function httpJson(p){for(let i=0;i<80;i++){try{const r=await fetch("http://127.0.0.1:"+PORT+p);return await r.json();}catch{await sleep(250);}}throw new Error("no devtools");}
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}send(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(e){const r=await this.send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}async waitFor(expr,timeout,label){const t0=Date.now();while(Date.now()-t0<timeout){try{if(await this.eval(expr))return true;}catch{}await sleep(300);}throw new Error("等待超时："+label);}}
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);ws.addEventListener("open",()=>res(new CDP(ws)));ws.addEventListener("error",rej);});}
(async()=>{
  const ver = await httpJson("/json/version");
  const browser = await connect(ver.webSocketDebuggerUrl);
  const {targetId} = await browser.send("Target.createTarget",{url:"about:blank"});
  const list = await httpJson("/json/list");
  const cdp = await connect(list.find(t=>t.id===targetId).webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const errs = [];
  await cdp.send("Log.enable").catch(()=>{});
  await cdp.send("Page.navigate",{url:"http://127.0.0.1:8017/?t="+Date.now()});
  await sleep(2500);
  await cdp.eval("var b=document.getElementById('boot'); if(b) b.remove();");
  await sleep(400);

  await cdp.eval(`document.querySelector('.nav-item[data-page="precheck"]').click()`);
  await sleep(400);

  const files = fs.readdirSync(SRC).filter(f=>/\.(mp4|mov)$/i.test(f)).sort().map(f=>SRC+"/"+f);
  console.log("素材集数：", files.length);

  const { root } = await cdp.send("DOM.getDocument",{depth:-1});
  const { nodeId } = await cdp.send("DOM.querySelector",{nodeId:root.nodeId,selector:"#preFilePicker"});
  await cdp.send("DOM.setFileInputFiles",{files,nodeId});
  await sleep(800);
  console.log("已选：", await cdp.eval("document.getElementById('preInfo').textContent"));
  console.log("按钮可用：", !(await cdp.eval("document.getElementById('runPrecheck').disabled")));

  await cdp.eval("document.getElementById('runPrecheck').click()");
  await cdp.waitFor("!document.getElementById('preWorkspace').hidden", 120000, "体检结果");
  await sleep(600);

  console.log("结论：", await cdp.eval("document.getElementById('preVerdict').innerText"));
  console.log("问题卡：", await cdp.eval("[...document.querySelectorAll('.pre-issue-card')].map(c=>c.querySelector('.pre-issue-title').innerText.replace(/\\s+/g,' ')).join(' / ')"));
  console.log("前 4 行：");
  console.log(await cdp.eval("[...document.querySelectorAll('#preRows tr')].slice(0,4).map(r=>[...r.children].map(td=>td.innerText.trim()).join(' | ')).join('\\n')"));
  console.log("末行：", await cdp.eval("(function(){var r=[...document.querySelectorAll('#preRows tr')].pop(); return r? [...r.children].map(td=>td.innerText.trim()).join(' | '):'无';})()"));
  console.log("统计：", await cdp.eval("document.getElementById('preStats').textContent"));

  const h = await cdp.eval("document.documentElement.scrollHeight");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:Math.min(h+40,2400),deviceScaleFactor:1,mobile:false});
  await sleep(600);
  const { data } = await cdp.send("Page.captureScreenshot",{format:"png"});
  fs.mkdirSync(OUT,{recursive:true});
  fs.writeFileSync(path.join(OUT,"30-precheck.png"), Buffer.from(data,"base64"));
  console.log("saved 30-precheck.png");

  const DL = path.join(__dirname, "dl3");
  fs.mkdirSync(DL, { recursive: true });
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
  await cdp.eval("document.getElementById('preSaveReport').click()");
  await sleep(2000);
  console.log("下载目录：", fs.readdirSync(DL));

  await browser.send("Target.closeTarget",{targetId}); chrome.kill(); await sleep(200);
  fs.rmSync(userDir,{recursive:true,force:true}); process.exit(0);
})().catch(e=>{console.error("FAIL",e.message);chrome.kill();process.exit(1);});
