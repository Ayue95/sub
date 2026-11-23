const el = (id) => document.getElementById(id);

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi)$/i;
const NAMING_OK = /^\d{2}\.(mp4|mov)$/;
const SMALL_SIZE = 1024 * 1024;
const SHORT_SEC = 10;

let picked = [];
let result = null;

/* ---------------- MP4 / MOV 头部解析 ---------------- */

function str4(dv, p) {
  return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
}

function* boxes(dv, start, end) {
  let p = start;
  let guard = 0;
  while (p + 8 <= end && guard++ < 5000) {
    let size = dv.getUint32(p);
    const type = str4(dv, p + 4);
    let hl = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(dv.getBigUint64(p + 8));
      hl = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hl || p + size > end) break;
    yield { type, start: p + hl, end: p + size };
    p += size;
  }
}

function parseMoov(dv) {
  const out = { width: 0, height: 0, fps: 0, duration: 0 };
  let mvTimescale = 0;
  let mvDuration = 0;
  const video = { handler: "", timescale: 0, samples: 0, delta: 0, width: 0, height: 0 };

  const readMvhd = (b) => {
    const v = dv.getUint8(b.start);
    if (v === 1) {
      mvTimescale = dv.getUint32(b.start + 20);
      mvDuration = Number(dv.getBigUint64(b.start + 24));
    } else {
      mvTimescale = dv.getUint32(b.start + 12);
      mvDuration = dv.getUint32(b.start + 16);
    }
  };

  const readTkhd = (b, ctx) => {
    const v = dv.getUint8(b.start);
    const wOff = v === 1 ? b.start + 88 : b.start + 76;
    if (wOff + 8 > b.end) return;
    const w = dv.getUint32(wOff) / 65536;
    const h = dv.getUint32(wOff + 4) / 65536;
    const mOff = v === 1 ? b.start + 52 : b.start + 40;
    let rotated = false;
    if (mOff + 20 <= b.end) {
      const a = dv.getInt32(mOff) / 65536;
      const d = dv.getInt32(mOff + 16) / 65536;
      rotated = Math.abs(a) < 0.01 && Math.abs(d) < 0.01;
    }
    if (w && h) {
      ctx.width = rotated ? h : w;
      ctx.height = rotated ? w : h;
    }
  };

  const readMdhd = (b, ctx) => {
    const v = dv.getUint8(b.start);
    ctx.timescale = v === 1 ? dv.getUint32(b.start + 20) : dv.getUint32(b.start + 12);
  };

  const readStts = (b, ctx) => {
    const n = dv.getUint32(b.start + 4);
    let samples = 0;
    let first = 0;
    for (let i = 0; i < n && i < 8192; i++) {
      const p = b.start + 8 + i * 8;
      if (p + 8 > b.end) break;
      if (i === 0) first = dv.getUint32(p + 4);
      samples += dv.getUint32(p);
    }
    ctx.samples = samples;
    ctx.delta = first;
  };

  function walk(start, end, ctx) {
    for (const b of boxes(dv, start, end)) {
      if (b.type === "mvhd") readMvhd(b);
      else if (b.type === "hdlr") ctx.handler = str4(dv, b.start + 8);
      else if (b.type === "tkhd") readTkhd(b, ctx);
      else if (b.type === "mdhd") readMdhd(b, ctx);
      else if (b.type === "stts") readStts(b, ctx);

      if (b.type === "moov" || b.type === "trak" || b.type === "mdia" || b.type === "minf" || b.type === "stbl") {
        const child =
          b.type === "trak" ? { handler: "", timescale: 0, samples: 0, delta: 0, width: 0, height: 0 } : ctx;
        walk(b.start, b.end, child);
        if (b.type === "trak" && child.handler === "vide" && !video.width) {
          video.timescale = child.timescale;
          video.samples = child.samples;
          video.delta = child.delta;
          video.width = child.width;
          video.height = child.height;
        }
      }
    }
  }

  walk(0, dv.byteLength, { handler: "", timescale: 0, samples: 0, delta: 0, width: 0, height: 0 });

  out.width = video.width;
  out.height = video.height;
  if (mvTimescale && mvDuration) out.duration = mvDuration / mvTimescale;
  if (video.timescale && video.delta) out.fps = video.timescale / video.delta;
  else if (video.samples && out.duration) out.fps = video.samples / out.duration;
  return out;
}

async function mp4Meta(file) {
  let pos = 0;
  let guard = 0;
  while (pos < file.size && guard++ < 400) {
    const head = await file.slice(pos, pos + 16).arrayBuffer();
    if (head.byteLength < 8) break;
    const dv = new DataView(head);
    let size = dv.getUint32(0);
    const type = str4(dv, 4);
    let hl = 8;
    if (size === 1) {
      if (head.byteLength < 16) break;
      size = Number(dv.getBigUint64(8));
      hl = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < hl) break;
    if (type === "moov") {
      const len = Math.min(size - hl, 48 * 1024 * 1024);
      const buf = await file.slice(pos + hl, pos + hl + len).arrayBuffer();
      return parseMoov(new DataView(buf));
    }
    pos += size;
  }
  return null;
}

function videoMeta(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      resolve(r);
    };
    v.onloadedmetadata = () =>
      finish({ width: v.videoWidth || 0, height: v.videoHeight || 0, duration: v.duration || 0, fps: 0 });
    v.onerror = () => finish(null);
    v.src = url;
    setTimeout(() => finish(null), 8000);
  });
}

/* ---------------- 体检规则 ---------------- */

const fmtSize = (b) =>
  b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(0) + " MB" : (b / 1e3).toFixed(0) + " KB";

const fmtDur = (s) => {
  if (!s) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.round(s % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(ss).padStart(2, "0");
};

const fmtFps = (f) => {
  if (!f || !isFinite(f)) return "—";
  if (Math.abs(f - 23.976) < 0.05) return "23.976";
  if (Math.abs(f - 29.97) < 0.05) return "29.97";
  if (Math.abs(f - 59.94) < 0.05) return "59.94";
  return String(Math.round(f * 100) / 100);
};

function namingReason(name) {
  const m = name.match(/^([^.]+)(\.[^.]+)?$/);
  const base = m ? m[1] : name;
  const ext = m && m[2] ? m[2] : "";
  if (!/^\d{2}$/.test(base)) {
    if (/^\d+$/.test(base)) return "集号要两位（01 而不是 " + base + "）";
    if (/[\u4e00-\u9fa5]/.test(base)) return "文件名含中文";
    if (/\s/.test(base)) return "文件名含空格";
    return "应为 01.mp4 这种纯数字";
  }
  if (ext !== ext.toLowerCase()) return "扩展名要小写 " + ext.toLowerCase();
  return "扩展名应为 .mp4";
}

function analyze(rows) {
  const entries = rows
    .map((r) => ({ ...r, num: parseInt((r.name.match(/^(\d+)/) || [])[1] || "0", 10) }))
    .sort((a, b) => (a.num || 9999) - (b.num || 9999) || a.name.localeCompare(b.name));

  const issues = { missing: [], empty: [], dup: [], naming: [] };

  const nums = entries.map((e) => e.num).filter((n) => n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  const have = new Set(nums);
  for (let i = 1; i <= max; i++) if (!have.has(i)) issues.missing.push(i);

  const byKey = new Map();
  entries.forEach((e) => {
    if (!e.size) return;
    const key = e.size + "|" + Math.round(e.duration || 0);
    if (byKey.has(key)) issues.dup.push([byKey.get(key), e]);
    else byKey.set(key, e);
  });

  entries.forEach((e) => {
    if (e.size < SMALL_SIZE) issues.empty.push({ entry: e, why: "文件极小" });
    else if (e.duration && e.duration < SHORT_SEC) issues.empty.push({ entry: e, why: "时长不足 10 秒" });
    if (!NAMING_OK.test(e.name)) issues.naming.push({ entry: e, why: namingReason(e.name) });
  });

  return { entries, issues, max };
}

/* ---------------- 渲染 ---------------- */

function badgeFor(entry, issues) {
  const tags = [];
  if (issues.empty.some((x) => x.entry === entry)) tags.push(["空集", "danger"]);
  if (issues.dup.some(([a, b]) => a === entry || b === entry)) tags.push(["重复", "warn"]);
  if (issues.naming.some((x) => x.entry === entry)) tags.push(["命名", "warn"]);
  return tags;
}

function render(res) {
  const { entries, issues } = res;
  const total = issues.missing.length + issues.empty.length + issues.dup.length + issues.naming.length;

  el("preWorkspace").hidden = false;

  const verdict = el("preVerdict");
  verdict.className = "pre-verdict" + (total ? " is-bad" : " is-good");
  verdict.innerHTML = total
    ? `<b>${entries.length}</b> 集 · 发现 <b>${total}</b> 个问题`
    : `<b>${entries.length}</b> 集 · 全部正常`;

  const box = el("preIssues");
  box.innerHTML = "";

  const card = (title, cls, items, renderItem) => {
    if (!items.length) return;
    const d = document.createElement("div");
    d.className = "pre-issue-card " + cls;
    d.innerHTML = `<div class="pre-issue-title">${title} <span>${items.length}</span></div>`;
    const ul = document.createElement("div");
    ul.className = "pre-issue-body";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "pre-issue-row";
      row.innerHTML = renderItem(it);
      ul.appendChild(row);
    });
    d.appendChild(ul);
    box.appendChild(d);
  };

  card("缺集", "danger", issues.missing, (n) => `<span class="mono">第 ${n} 集</span><span class="pre-why">文件夹里没有这一集</span>`);
  card(
    "空集 / 异常短",
    "danger",
    issues.empty,
    (x) => `<span class="mono">${x.entry.name}</span><span class="pre-why">${x.why} · ${fmtSize(x.entry.size)} · ${fmtDur(x.entry.duration)}</span>`
  );
  card(
    "重复集",
    "warn",
    issues.dup,
    ([a, b]) => `<span class="mono">${a.name}</span><span class="pre-why">与 ${b.name} 大小和时长完全相同</span>`
  );
  card("命名不规范", "warn", issues.naming, (x) => `<span class="mono">${x.entry.name}</span><span class="pre-why">${x.why}</span>`);

  if (!box.children.length) {
    box.innerHTML = '<div class="pre-ok">没有发现缺集、空集、重复或命名问题</div>';
  }

  const tbody = el("preRows");
  tbody.innerHTML = "";
  entries.forEach((e) => {
    const tags = badgeFor(e, issues);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="mono">${e.num ? String(e.num).padStart(2, "0") : "—"}</td>` +
      `<td class="pre-name">${e.name}</td>` +
      `<td class="mono">${fmtSize(e.size)}</td>` +
      `<td class="mono">${e.width ? e.width + " × " + e.height : "—"}</td>` +
      `<td class="mono">${fmtFps(e.fps)}</td>` +
      `<td class="mono">${fmtDur(e.duration)}</td>` +
      `<td>${tags.length ? tags.map(([t, c]) => `<span class="pre-tag ${c}">${t}</span>`).join("") : '<span class="pre-tag ok">正常</span>'}</td>`;
    tbody.appendChild(tr);
  });

  el("preStats").textContent = total ? `共 ${total} 个问题需要处理` : "没有发现问题";
}

/* ---------------- 报告 ---------------- */

function buildReportHtml(res) {
  const { entries, issues } = res;
  const total = issues.missing.length + issues.empty.length + issues.dup.length + issues.naming.length;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const issueBlocks = [];
  const push = (title, cls, items, text) => {
    if (!items.length) return;
    issueBlocks.push(
      `<div class="issue ${cls}"><div class="issue-title">${title}<span>${items.length}</span></div>` +
        items.map((it) => `<div class="issue-row">${text(it)}</div>`).join("") +
        "</div>"
    );
  };
  push("缺集", "danger", issues.missing, (n) => `<b>第 ${n} 集</b>　文件夹里没有这一集`);
  push("空集 / 异常短", "danger", issues.empty, (x) => `<b>${esc(x.entry.name)}</b>　${x.why} · ${fmtSize(x.entry.size)} · ${fmtDur(x.entry.duration)}`);
  push("重复集", "warn", issues.dup, ([a, b]) => `<b>${esc(a.name)}</b> 与 <b>${esc(b.name)}</b>　大小和时长完全相同`);
  push("命名不规范", "warn", issues.naming, (x) => `<b>${esc(x.entry.name)}</b>　${x.why}`);

  const rows = entries
    .map((e) => {
      const tags = badgeFor(e, issues);
      const status = tags.length
        ? tags.map(([t, c]) => `<span class="tag ${c}">${t}</span>`).join("")
        : '<span class="tag ok">正常</span>';
      return `<tr><td class="mono">${e.num ? String(e.num).padStart(2, "0") : "—"}</td><td>${esc(e.name)}</td><td class="mono">${fmtSize(e.size)}</td><td class="mono">${e.width ? e.width + " × " + e.height : "—"}</td><td class="mono">${fmtFps(e.fps)}</td><td class="mono">${fmtDur(e.duration)}</td><td>${status}</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>原剧体检报告</title>
<style>
body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; color: #333; background: #f6f7f9; line-height: 1.6; }
.header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.header h1 { font-size: 20px; margin: 0; font-weight: 600; }
.target { background: #e6f1fb; color: #185fa5; font-size: 13px; padding: 3px 14px; border-radius: 99px; }
.overview { display: flex; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
.ov { flex: 1 1 110px; background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 14px 20px; min-width: 110px; }
.ov b { display: block; font-size: 22px; font-weight: 600; line-height: 1.25; }
.ov span { font-size: 12px; color: #8a8f98; }
.ov.is-bad b { color: #d84a3a; }
.issue { background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 16px 20px; margin-bottom: 12px; }
.issue-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.issue-title span { font-size: 12px; font-weight: 400; color: #8a8f98; margin-left: 6px; }
.issue.danger .issue-title { color: #a32d2d; }
.issue.warn .issue-title { color: #854f0b; }
.issue-row { font-size: 13.5px; padding: 5px 0; border-top: 1px solid #f4f5f7; }
.issue-row:first-of-type { border-top: none; }
.card { background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 18px 22px; }
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; }
th { font-size: 12px; color: #8a8f98; font-weight: 400; text-align: left; padding: 6px 8px; border-bottom: 1px solid #eceef1; }
td { font-size: 13px; padding: 8px; border-bottom: 1px solid #f4f5f7; }
tr:last-child td { border-bottom: none; }
.mono { font-family: Consolas, Menlo, monospace; color: #5f5e5a; }
.tag { font-size: 11.5px; padding: 1px 8px; border-radius: 99px; margin-right: 4px; white-space: nowrap; }
.tag.ok { background: #eaf3de; color: #3b6d11; }
.tag.danger { background: #fcebeb; color: #a32d2d; }
.tag.warn { background: #faeeda; color: #854f0b; }
.empty { color: #999; text-align: center; padding: 40px 0; font-size: 15px; }
</style></head>
<body>
<div class="header"><h1>原剧体检报告</h1><span class="target">共 ${entries.length} 集</span></div>
<div class="overview">
  <div class="ov"><b>${entries.length}</b><span>视频文件</span></div>
  <div class="ov${issues.missing.length ? " is-bad" : ""}"><b>${issues.missing.length}</b><span>缺集</span></div>
  <div class="ov${issues.empty.length ? " is-bad" : ""}"><b>${issues.empty.length}</b><span>空集</span></div>
  <div class="ov${issues.dup.length ? " is-bad" : ""}"><b>${issues.dup.length}</b><span>重复集</span></div>
  <div class="ov${issues.naming.length ? " is-bad" : ""}"><b>${issues.naming.length}</b><span>命名不规范</span></div>
</div>
${issueBlocks.length ? issueBlocks.join("") : '<div class="issue"><div class="issue-title">没有发现问题</div><div class="issue-row">缺集、空集、重复集、命名四项检查全部通过。</div></div>'}
<div class="card"><div class="card-title">每集参数</div>
<table><thead><tr><th>集</th><th>文件名</th><th>大小</th><th>分辨率</th><th>帧率</th><th>时长</th><th>状态</th></tr></thead>
<tbody>${rows}</tbody></table></div>
</body></html>`;
}

/* ---------------- 交互 ---------------- */

function updatePicked() {
  const info = el("preInfo");
  if (!picked.length) {
    info.textContent = "";
    el("preClear").hidden = true;
  } else {
    // 从文件夹进来的能拿到文件夹名，单个选文件时就没有
    const rel = picked[0].webkitRelativePath || "";
    const folder = rel ? rel.split("/")[0] : "";
    const name = folder || picked.slice(0, 2).map((f) => f.name).join("、");
    info.textContent = `${name} · ${picked.length} 个视频`;
    el("preClear").hidden = false;
  }
  el("runPrecheck").disabled = !picked.length;
}

function addFiles(files) {
  const seen = new Set(picked.map((f) => f.name + "|" + f.size));
  files.forEach((f) => {
    if (!VIDEO_EXT.test(f.name)) return;
    const key = f.name + "|" + f.size;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(f);
  });
  updatePicked();
}

function clearAll() {
  picked = [];
  result = null;
  el("preWorkspace").hidden = true;
  el("preNote").textContent = "";
  updatePicked();
}

async function readEntry(entry, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await new Promise((res) => reader.readEntries(res));
    for (const e of entries) await readEntry(e, out);
  }
}

async function run() {
  el("runPrecheck").disabled = true;
  el("preWorkspace").hidden = true;
  el("preNote").textContent = "读取中…";

  const rows = [];
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i];
    el("preNote").textContent = `读取中… ${i + 1}/${picked.length}`;
    let meta = null;
    if (/\.(mp4|mov|m4v)$/i.test(f.name)) {
      try {
        meta = await mp4Meta(f);
      } catch {
        meta = null;
      }
    }
    if (!meta || !meta.width) {
      const v = await videoMeta(f);
      if (v) {
        meta = {
          width: (meta && meta.width) || v.width,
          height: (meta && meta.height) || v.height,
          duration: (meta && meta.duration) || v.duration,
          fps: (meta && meta.fps) || 0,
        };
      }
    }
    rows.push({
      file: f,
      name: f.name,
      size: f.size,
      width: meta ? meta.width : 0,
      height: meta ? meta.height : 0,
      duration: meta ? meta.duration : 0,
      fps: meta ? meta.fps : 0,
    });
  }

  result = analyze(rows);
  render(result);
  el("preNote").textContent = "";
  el("runPrecheck").disabled = false;
}

function saveReport() {
  if (!result) return;
  const html = buildReportHtml(result);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "原剧体检报告.html";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function initPrecheck() {
  el("prePickFiles").addEventListener("click", () => el("preFilePicker").click());
  el("prePickFolder").addEventListener("click", () => el("preFolderPicker").click());

  el("preFilePicker").addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  });
  el("preFolderPicker").addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  });

  el("preClear").addEventListener("click", clearAll);
  el("runPrecheck").addEventListener("click", run);
  el("preSaveReport").addEventListener("click", saveReport);

  const drop = el("preDrop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    const items = [...(e.dataTransfer.items || [])];
    if (items.length) {
      const out = [];
      for (const it of items) {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) await readEntry(entry, out);
      }
      addFiles(out);
    } else {
      addFiles([...e.dataTransfer.files]);
    }
  });
}
