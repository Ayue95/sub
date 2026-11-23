import {
  PyBridge,
  fileToBase64,
  base64ToBlob,
  downloadBlob,
} from "./pyodide-bridge.js";
import { initLocalize } from "./pages/localize.js?v=17";
import { initCompare } from "./pages/compare.js?v=7";
import { initProject, initLanguageChoices } from "./pages/project.js?v=7";
import { initPrecheck } from "./pages/precheck.js?v=5";
import { createSaveControls, collectSrtFromDir, writeFilesInto } from "./save.js?v=2";

// 显示名可以精简，传给原算法的语言名称保持不变。
const REPAIR_LANG_VALUES = { "中文": "简体中文", "西语": "西班牙语" };

const el = (id) => document.getElementById(id);

let bridge = null;
let selectedFiles = [];
let dirHandle = null;
let currentLang = "简体中文";
let busy = false;
let lastResult = null;

function switchPage(name) {
  // 首页是封面：不显示侧栏，靠闪电按钮进入
  document.body.classList.toggle("is-cover", name === "home");

  document.querySelectorAll(".nav-item").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.page === name);
  });
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("is-active", page.id === "page-" + name);
  });

  window.scrollTo({ top: 0, behavior: "auto" });
}

function setBoot(stage, msg) {
  const fill = el("bootFill");
  const label = el("bootMsg");
  if (!fill || !label) return;
  const map = { runtime: 25, packages: 60, code: 88, ready: 100, work: 100 };
  fill.style.width = (map[stage] || 30) + "%";
  if (msg) label.textContent = msg;
}

function hideBoot() {
  const boot = el("boot");
  boot.classList.add("is-hidden");
  setTimeout(() => boot.remove(), 400);
}

function renderLangs() {
  initLanguageChoices(el("langChips"), "中文", (lang) => {
    currentLang = REPAIR_LANG_VALUES[lang] || lang;
  });
}

function isSrt(name) {
  return /\.srt$/i.test(name || "");
}

function setFiles(list) {
  selectedFiles = list.filter((f) => isSrt(f.name));
  const info = el("fileInfo");
  const runBtn = el("runRepair");
  const clearBtn = el("clearFiles");

  if (!selectedFiles.length) {
    info.textContent = "";
    runBtn.disabled = true;
    clearBtn.hidden = true;
    return;
  }

  const preview = selectedFiles.slice(0, 3).map((f) => f.name).join("、");
  const more = selectedFiles.length > 3 ? ` 等 ${selectedFiles.length} 个文件` : "";
  info.textContent = `${preview}${more}`;
  runBtn.disabled = busy;
  clearBtn.hidden = false;
}

function appendLog(text, cls) {
  const box = el("repairLog");
  box.closest(".log-card").hidden = false;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  el("repairLog").innerHTML = "";
  el("repairLog").closest(".log-card").hidden = true;
}

function classify(line) {
  if (line.startsWith("✔")) return "line-ok";
  if (line.startsWith("❌")) return "line-err";
  if (line.startsWith("⚠")) return "line-warn";
  return "";
}

async function renderResult(res) {
  lastResult = res;
  const card = el("repairResult");
  const summary = el("resultSummary");
  const actions = el("resultActions");
  card.hidden = false;

  const okFiles = (res.files || []).filter((f) => f.ok && f.b64);
  const stats = res.report_stats || { problem_files: 0, issue_total: 0 };
  const problemLine = stats.problem_files
    ? `<div>有问题 <b class="is-warn">${stats.problem_files}</b> 个文件 · ${stats.issue_total} 处</div>`
    : `<div>检测结果 <b class="is-ok">全部正常</b></div>`;
  summary.innerHTML =
    `<div>成功 <b>${res.success}</b> / ${res.total}</div>` +
    `<div>可下载 <b>${okFiles.length}</b> 个</div>` +
    `<div>目标语言 <b>${currentLang}</b></div>` +
    problemLine;

  actions.innerHTML = "";

  if (okFiles.length) {
    if (dirHandle) {
      // 从文件夹进来的，直接在原目录里建好「修复」
      const hint = document.createElement("span");
      hint.className = "muted save-hint";
      hint.textContent = "正在写入…";
      actions.appendChild(hint);
      try {
        const n = await writeFilesInto(dirHandle, "修复", okFiles);
        hint.textContent = `已生成「${dirHandle.name} / 修复」，共 ${n} 个文件`;
        hint.classList.add("is-ok");
      } catch (err) {
        hint.textContent = "自动保存失败：" + String((err && err.message) || err);
        actions.appendChild(createSaveControls("修复", okFiles));
      }
    } else {
      actions.appendChild(createSaveControls("修复", okFiles));
    }
  }

  if (res.report_html) {
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.textContent = stats.problem_files ? "查看检测报告（有问题）" : "查看检测报告";
    btn.addEventListener("click", () => {
      const blob = new Blob([res.report_html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    actions.insertBefore(btn, actions.firstChild);
  }
}

async function runRepair() {
  if (busy || !selectedFiles.length || !bridge) return;
  busy = true;
  el("runRepair").disabled = true;
  el("runRepair").textContent = "修复中…";
  el("repairResult").hidden = true;
  clearLog();
  appendLog(`开始处理 ${selectedFiles.length} 个文件…`);

  try {
    const payload = [];
    for (const file of selectedFiles) {
      payload.push({ name: file.name, b64: await fileToBase64(file) });
    }
    const res = await bridge.repair(payload, currentLang);
    (res.logs || []).forEach((line) => appendLog(line, classify(line)));
    renderResult(res);
  } catch (err) {
    appendLog("❌ " + String((err && err.message) || err), "line-err");
  } finally {
    busy = false;
    el("runRepair").disabled = !selectedFiles.length;
    el("runRepair").textContent = "开始修复";
  }
}

function bindEvents() {
  el("tabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".nav-item");
    if (btn) switchPage(btn.dataset.page);
  });

  el("enterApp").addEventListener("click", () => switchPage("project"));

  el("pickFiles").addEventListener("click", () => el("filePicker").click());
  el("pickFolder").addEventListener("click", async () => {
    if (typeof window.showDirectoryPicker === "function") {
      let dir = null;
      try {
        dir = await window.showDirectoryPicker({ mode: "readwrite", id: "sub-repair-in" });
      } catch (err) {
        return;
      }
      try {
        const files = await collectSrtFromDir(dir, []);
        dirHandle = dir;
        setFiles(files);
        return;
      } catch (err) {
        dirHandle = null;
      }
    }
    el("folderPicker").click();
  });

  el("filePicker").addEventListener("change", (e) => {
    dirHandle = null;
    setFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });

  el("folderPicker").addEventListener("change", (e) => {
    dirHandle = null;
    setFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });

  el("clearFiles").addEventListener("click", () => setFiles([]));

  const drop = el("dropZone");
  ["dragenter", "dragover"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
    });
  });
  drop.addEventListener("drop", async (e) => {
    const items = Array.from(e.dataTransfer.files || []);
    if (items.length) {
      setFiles(items);
      return;
    }
    const entries = Array.from(e.dataTransfer.items || [])
      .map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry())
      .filter(Boolean);
    if (entries.length) {
      const collected = [];
      await walkEntries(entries, collected);
      setFiles(collected);
    }
  });

  el("runRepair").addEventListener("click", runRepair);
}

function readFileEntry(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readDirEntries(reader) {
  return new Promise((resolve) => {
    const all = [];
    const read = () => {
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        read();
      }, () => resolve(all));
    };
    read();
  });
}

async function walkEntries(entries, out) {
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await readFileEntry(entry);
      if (file && isSrt(file.name)) out.push(file);
    } else if (entry.isDirectory) {
      const children = await readDirEntries(entry.createReader());
      await walkEntries(children, out);
    }
  }
}

async function boot() {
  renderLangs();
  bindEvents();

  bridge = new PyBridge("js/pyodide-worker.js?v=2");
  bridge.onProgress((stage, msg) => setBoot(stage, msg));
  window.__subBridge = bridge;
  initLocalize(bridge);
  initCompare(bridge);
  initProject(bridge);
  initPrecheck();

  try {
    const info = await bridge.init();
    const badge = el("envBadge");
    if (badge) {
      const hasSubs = !!(info.packages && info.packages.pysubs2);
      badge.textContent = (hasSubs ? "✓ 就绪 · " : "⚠ 文本模式 · ") + info.python;
      badge.classList.add(hasSubs ? "ok" : "warn");
      badge.title =
        "Python " + info.python +
        " · pysubs2: " + (hasSubs ? "已安装" : "未安装") +
        " · openpyxl: " + (info.openpyxl || "未安装");
    }
    hideBoot();
  } catch (err) {
    el("bootMsg").textContent = "环境加载失败：" + String((err && err.message) || err);
    el("bootFill").style.background = "#cf5f5f";
  }
}

boot();
