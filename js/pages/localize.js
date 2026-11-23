import { fileToBase64, base64ToBlob, downloadBlob } from "../pyodide-bridge.js";
import { createSaveControls, collectSrtFromDir, writeFilesInto } from "../save.js?v=2";

const el = (id) => document.getElementById(id);

const state = {
  excel: null,
  files: [],
  groups: [],
  current: 0,
  decisions: new Map(),
  audit: { conflicts: [], unused: [] },
  dirHandle: null,
  busy: false,
};

let lastApplyResult = null;

let bridgeRef = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlight(text, needle) {
  const safe = escapeHtml(text);
  if (!needle) return safe;
  const target = escapeHtml(needle);
  const re = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function isSrt(name) {
  return /\.srt$/i.test(name || "");
}

// 两张选择卡共用：拖进来时高亮，松手交给各自的处理函数
function bindDropZone(zone, onDrop) {
  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove("is-over");
    })
  );
  zone.addEventListener("drop", onDrop);
}

function log(msg, cls) {
  const box = el("locLog");
  box.hidden = false;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = el("locLog");
  box.innerHTML = "";
  box.hidden = true;
}

function setNote(text, cls) {
  const note = el("scanNote");
  note.textContent = text || "";
  note.className = "run-note" + (cls ? " " + cls : "");
}

function refreshScanState() {
  const ok = Boolean(state.excel) && state.files.length > 0;
  el("runScan").disabled = !ok || state.busy;
}

function setExcel(file) {
  state.excel = file;
  const info = el("excelInfo");
  if (file) {
    info.textContent = file.name;
    el("clearExcel").hidden = false;
  } else {
    info.textContent = "";
    el("clearExcel").hidden = true;
  }
  refreshScanState();
}

function setFiles(list) {
  state.files = list.filter((f) => isSrt(f.name));
  const info = el("locFileInfo");
  if (!state.files.length) {
    info.textContent = "";
    el("locClear").hidden = true;
  } else {
    const preview = state.files.slice(0, 3).map((f) => f.name).join("、");
    const more = state.files.length > 3 ? ` 等 ${state.files.length} 个文件` : "";
    info.textContent = `${preview}${more}`;
    el("locClear").hidden = false;
  }
  refreshScanState();
}

async function runScan() {
  if (state.busy || !state.excel || !state.files.length) return;
  state.busy = true;
  refreshScanState();
  el("runScan").textContent = "扫描中…";
  clearLog();
  setNote("");
  el("locWorkspace").hidden = true;

  log(`读取清单：${state.excel.name}`);

  try {
    const excelB64 = await fileToBase64(state.excel);
    const payload = [];
    for (const f of state.files) {
      payload.push({ name: f.name, b64: await fileToBase64(f) });
    }
    log(`共 ${payload.length} 个字幕文件，开始匹配…`);

    const res = await bridgeRef.call("localize_scan", {
      excel_name: state.excel.name,
      excel_b64: excelB64,
      files: payload,
    });

    if (!res.ok) {
      log("❌ " + res.error, "line-err");
      return;
    }

    state.groups = res.groups || [];
    state.audit = res.audit || { conflicts: [], unused: [] };
    state.current = 0;
    state.decisions = new Map();
    state.groups.forEach((g) => {
      g.matches.forEach((m) => {
        state.decisions.set(m.key, { selected: true, target: g.target, def: g.target });
      });
    });

    log(`✔ 清单 ${res.rule_count} 条术语，字幕 ${res.file_count} 个`, "line-ok");
    if (!state.groups.length) {
      log("⚠ 没有任何术语在字幕中命中", "line-warn");
      setNote("没有命中任何术语", "is-warn");
      return;
    }
    log(`✔ 共 ${res.match_count} 处匹配，涉及 ${state.groups.length} 条术语`, "line-ok");
    if (state.audit.conflicts.length) {
      log(`⚠ 清单里有 ${state.audit.conflicts.length} 条术语写了多个译文，替换后请看巡检报告`, "line-warn");
    }

    el("locWorkspace").hidden = false;
    renderTermList();
    renderDetail();
    updateStats();

    // 扫描成功就把过程日志收起来，只留一行结论
    setNote(`扫描完成，${state.groups.length} 条术语有匹配，共 ${res.match_count} 处`);
    el("locLog").hidden = true;
  } catch (err) {
    log("❌ " + String((err && err.message) || err), "line-err");
  } finally {
    state.busy = false;
    el("runScan").textContent = "加载并扫描";
    refreshScanState();
    // busy 已复位，这里再算一次，否则按钮会一直停在禁用态
    updateStats();
  }
}

function selectedCount(group) {
  return group.matches.filter((m) => {
    const d = state.decisions.get(m.key);
    return d && d.selected;
  }).length;
}

function renderTermList() {
  const box = el("termList");
  box.innerHTML = "";
  state.groups.forEach((g, idx) => {
    const item = document.createElement("div");
    item.className = "term-item" + (idx === state.current ? " is-active" : "");
    const label = document.createElement("span");
    label.textContent = `${g.source} → ${g.target}`;
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = `${selectedCount(g)}/${g.count}`;
    item.appendChild(label);
    item.appendChild(cnt);
    item.addEventListener("click", () => {
      state.current = idx;
      renderTermList();
      renderDetail();
      updateStats();
    });
    box.appendChild(item);
  });
}

function renderDetail() {
  const g = state.groups[state.current];
  const list = el("matchList");
  list.innerHTML = "";
  if (!g) {
    el("matchTitle").textContent = "匹配预览";
    el("matchSub").textContent = "";
    return;
  }

  const files = new Set(g.matches.map((m) => m.file));
  el("matchTitle").textContent = `${g.source} → ${g.target}`;
  el("matchSub").textContent = `${g.count} 处匹配，涉及 ${files.size} 个文件`;

  let lastFile = null;
  g.matches.forEach((m) => {
    const d = state.decisions.get(m.key) || { selected: true, target: g.target };

    if (m.file !== lastFile) {
      lastFile = m.file;
      const head = document.createElement("div");
      head.className = "match-file";
      head.textContent = m.file;
      list.appendChild(head);
    }

    const row = document.createElement("div");
    row.className = "match-line";

    // 行号就是上下文入口，和桌面版一样
    const no = document.createElement("button");
    no.type = "button";
    no.className = "match-no";
    no.textContent = m.line;
    no.title = "查看上下文";
    no.setAttribute("aria-label", `查看第 ${m.line} 行上下文`);
    no.addEventListener("click", () => showContext(m));

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(d.selected);
    cb.setAttribute("aria-label", `第 ${m.line} 行是否替换`);
    cb.addEventListener("change", () => {
      d.selected = cb.checked;
      state.decisions.set(m.key, d);
      renderTermList();
      updateStats();
    });

    const src = document.createElement("span");
    src.className = "match-src";
    src.innerHTML = highlight(m.text, m.matched);

    const arrow = document.createElement("span");
    arrow.className = "match-arrow";
    arrow.textContent = "→";

    row.append(no, cb, src, arrow, makeDst(m, d, g));
    list.appendChild(row);
  });

  const allSelected = g.matches.every((m) => {
    const d = state.decisions.get(m.key);
    return d && d.selected;
  });
  el("selectAll").checked = allSelected;
}

// 译文：默认一块纯文字，点一下变成输入框，回车/点别处保存，Esc 放弃
function makeDst(m, d, g) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "match-dst" + (d.target !== g.target ? " is-edited" : "");
  btn.textContent = d.target;
  btn.title = "点击可修改译文";
  btn.addEventListener("click", () => editDst(btn, m, d, g));
  return btn;
}

function editDst(btn, m, d, g) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "match-dst-input";
  input.value = d.target;
  btn.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) {
      d.target = input.value.trim() || g.target;
      state.decisions.set(m.key, d);
    }
    input.replaceWith(makeDst(m, d, g));
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function showContext(match) {
  try {
    const res = await bridgeRef.call("localize_context", {
      file: match.file,
      line: match.line,
      text: match.text,
    });
    if (!res.ok) {
      log("❌ " + res.error, "line-err");
      return;
    }
    openModal(`${res.file} · 第 ${res.line} 行`, res.cues);
  } catch (err) {
    log("❌ " + String((err && err.message) || err), "line-err");
  }
}

function openModal(title, cues) {
  const wrap = document.createElement("div");
  wrap.className = "modal";

  const card = document.createElement("div");
  card.className = "modal-card";

  const close = () => {
    document.removeEventListener("keydown", onKey);
    wrap.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const head = document.createElement("div");
  head.className = "modal-head";
  const heading = document.createElement("div");
  heading.className = "modal-title";
  heading.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.className = "link-btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", close);
  head.appendChild(heading);
  head.appendChild(closeBtn);
  card.appendChild(head);

  cues.forEach((cue) => {
    const row = document.createElement("div");
    row.className = "cue" + (cue.target ? " is-target" : "");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = `[${cue.num}] ${cue.time}`;
    const s = document.createElement("span");
    s.textContent = cue.text;
    row.appendChild(t);
    row.appendChild(s);
    card.appendChild(row);
  });

  wrap.appendChild(card);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
}

function updateStats() {
  const total = state.groups.reduce((n, g) => n + g.count, 0);
  const selected = state.groups.reduce((n, g) => n + selectedCount(g), 0);
  el("locStats").textContent = `共 ${total} 条匹配，已选 ${selected} 条替换`;
  el("applyReplace").disabled = selected === 0 || state.busy;
}

async function applyReplace() {
  if (state.busy) return;
  state.busy = true;
  el("applyReplace").disabled = true;
  el("applyReplace").textContent = "应用中…";
  el("locResult").hidden = true;
  clearLog();

  const decisions = [];
  state.groups.forEach((g) => {
    g.matches.forEach((m) => {
      const d = state.decisions.get(m.key);
      if (d && d.selected) {
        decisions.push({
          selected: true,
          file: m.file,
          line: m.line,
          matched: m.matched,
          target: d.target,
        });
      }
    });
  });

  log(`开始替换：${decisions.length} 处`);

  try {
    const res = await bridgeRef.call("localize_apply", { decisions });
    if (!res.ok) {
      log("❌ " + res.error, "line-err");
      return;
    }
    log(`✔ 已处理 ${res.file_count} 个文件，共替换 ${res.replaced_total} 处`, "line-ok");
    renderResult(res);
    renderAudit(res);
    // 结果卡片已经把结论说清楚了，过程日志收起来
    el("locLog").hidden = true;
  } catch (err) {
    log("❌ " + String((err && err.message) || err), "line-err");
  } finally {
    state.busy = false;
    el("applyReplace").textContent = "应用替换";
    updateStats();
  }
}

async function renderResult(res) {
  lastApplyResult = res;
  const card = el("locResult");
  card.hidden = false;
  el("locResultSummary").innerHTML =
    `<div>处理文件 <b>${res.file_count}</b> 个</div>` +
    `<div>替换处数 <b>${res.replaced_total}</b></div>`;

  const box = el("locResultActions");
  box.innerHTML = "";

  if (!res.files.length) return;

  // 从文件夹进来的，替换完直接在原目录里建好「替换」
  if (state.dirHandle) {
    const hint = document.createElement("span");
    hint.className = "muted save-hint";
    hint.textContent = "正在写入…";
    box.appendChild(hint);
    try {
      const n = await writeFilesInto(state.dirHandle, "替换", res.files);
      hint.textContent = `已生成「${state.dirHandle.name} / 替换」，共 ${n} 个文件`;
      hint.classList.add("is-ok");
    } catch (err) {
      hint.textContent = "自动保存失败：" + String((err && err.message) || err);
      box.appendChild(createSaveControls("替换", res.files));
    }
    return;
  }

  box.appendChild(createSaveControls("替换", res.files));
}

/* ---------------- 术语巡检报告 ---------------- */

const AUDIT_LIMIT = 30;

function auditData(res) {
  const conflicts = (state.audit && state.audit.conflicts) || [];
  const unused = (state.audit && state.audit.unused) || [];
  const residual = (res && res.residual) || [];
  return { conflicts, unused, residual, total: conflicts.length + unused.length + residual.length };
}

function renderAudit(res) {
  const { conflicts, unused, residual, total } = auditData(res);

  el("locAudit").hidden = false;
  const sum = el("auditSum");
  sum.textContent = total ? `发现 ${total} 处` : "三项检查全部通过";
  sum.className = "audit-sum" + (total ? " is-bad" : " is-good");

  const body = el("auditBody");
  body.innerHTML = "";

  const block = (title, cls, items, render) => {
    if (!items.length) return;
    const card = document.createElement("div");
    card.className = "pre-issue-card " + cls;
    card.innerHTML = `<div class="pre-issue-title">${title} <span>${items.length}</span></div>`;
    const list = document.createElement("div");
    items.slice(0, AUDIT_LIMIT).forEach((it) => {
      const row = document.createElement("div");
      row.className = "pre-issue-row";
      row.innerHTML = render(it);
      list.appendChild(row);
    });
    if (items.length > AUDIT_LIMIT) {
      const more = document.createElement("div");
      more.className = "pre-issue-row";
      more.innerHTML = `<span class="pre-why">还有 ${items.length - AUDIT_LIMIT} 条，保存报告可以看全部</span>`;
      list.appendChild(more);
    }
    card.appendChild(list);
    body.appendChild(card);
  };

  block(
    "清单冲突",
    "danger",
    conflicts,
    (c) => `<span class="mono">${escapeHtml(c.source)}</span><span class="pre-why">清单里有 ${c.targets.length} 个不同译文：${escapeHtml(c.targets.join(" / "))}</span>`
  );
  block(
    "清单里有、全剧没出现",
    "warn",
    unused,
    (s) => `<span class="mono">${escapeHtml(s)}</span><span class="pre-why">可能拼错了，或者这条已经用不上</span>`
  );
  block(
    "替换后残留",
    "danger",
    residual,
    (r) => `<span class="mono">${escapeHtml(r.file)} 第 ${r.line} 行</span><span class="pre-why">${escapeHtml(r.source)} 没换掉：${escapeHtml(r.text)}</span>`
  );

  if (!total) {
    body.innerHTML = '<div class="pre-ok">清单没有冲突，术语都出现了，替换后也没有残留</div>';
  }
}

// 统一保存进「替换」文件夹，文件名与替换前完全一致
function readFileEntry(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readDirEntries(reader) {
  return new Promise((resolve) => {
    const all = [];
    const read = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) return resolve(all);
          all.push(...batch);
          read();
        },
        () => resolve(all)
      );
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

export function initLocalize(bridge) {
  bridgeRef = bridge;

  el("pickExcel").addEventListener("click", () => el("excelPicker").click());
  el("excelPicker").addEventListener("change", (e) => {
    const file = (e.target.files || [])[0];
    if (file) setExcel(file);
    e.target.value = "";
  });
  el("clearExcel").addEventListener("click", () => setExcel(null));

  el("locPickFiles").addEventListener("click", () => el("locFilePicker").click());
  el("locPickFolder").addEventListener("click", async () => {
    // 支持目录句柄的浏览器：拿到可写权限，替换后直接写回原文件夹
    if (typeof window.showDirectoryPicker === "function") {
      let dir = null;
      try {
        dir = await window.showDirectoryPicker({ mode: "readwrite", id: "sub-localize-in" });
      } catch (err) {
        return; // 用户取消
      }
      try {
        const files = await collectSrtFromDir(dir, []);
        state.dirHandle = dir;
        setFiles(files);
        return;
      } catch (err) {
        state.dirHandle = null;
      }
    }
    el("locFolderPicker").click();
  });

  el("locFilePicker").addEventListener("change", (e) => {
    state.dirHandle = null;
    setFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });
  el("locFolderPicker").addEventListener("change", (e) => {
    state.dirHandle = null;
    setFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });
  el("locClear").addEventListener("click", () => setFiles([]));

  bindDropZone(el("locDrop"), async (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) {
      setFiles(files);
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

  bindDropZone(el("locExcelDrop"), (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    const book = files.find((f) => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    if (book) setExcel(book);
  });

  el("runScan").addEventListener("click", runScan);
  el("applyReplace").addEventListener("click", applyReplace);

  el("selectAll").addEventListener("change", (e) => {
    const g = state.groups[state.current];
    if (!g) return;
    g.matches.forEach((m) => {
      const d = state.decisions.get(m.key);
      if (d) d.selected = e.target.checked;
    });
    renderTermList();
    renderDetail();
    updateStats();
  });

  refreshScanState();
}
