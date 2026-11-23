import { fileToBase64, base64ToBlob, downloadBlob } from "../pyodide-bridge.js";

const el = (id) => document.getElementById(id);
const isSrt = (name) => /\.srt$/i.test(name || "");
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TAG_TEXT = {
  added: "网站新增",
  removed: "网站缺失",
  modified: "内容不同",
};

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

export function initCompare(bridge) {
  const state = { a: [], b: [], busy: false };

  function log(text, cls) {
    const box = el("cmpLog");
    box.closest(".log-card").hidden = false;
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    el("cmpLog").innerHTML = "";
    el("cmpLog").closest(".log-card").hidden = true;
  }

  function classify(line) {
    if (line.startsWith("✔")) return "line-ok";
    if (line.startsWith("❌")) return "line-err";
    if (line.startsWith("⚠")) return "line-warn";
    return "";
  }

  function refresh() {
    const ready = state.a.length > 0 && state.b.length > 0 && !state.busy;
    el("runCompare").disabled = !ready;
    el("cmpHint").textContent = ready
      ? `手动版 ${state.a.length} 个 · 网站版 ${state.b.length} 个`
      : "";
  }

  function setSide(side, files) {
    const list = Array.from(files || []).filter((f) => isSrt(f.name));
    state[side] = list;

    const info = el(side === "a" ? "cmpInfoA" : "cmpInfoB");
    const clearBtn = el(side === "a" ? "cmpClearA" : "cmpClearB");

    if (!list.length) {
      info.textContent = "";
      clearBtn.hidden = true;
    } else {
      const preview = list.slice(0, 3).map((f) => f.name).join("、");
      const more = list.length > 3 ? ` 等 ${list.length} 个文件` : "";
      info.textContent = `${preview}${more}`;
      clearBtn.hidden = false;
    }
    refresh();
  }

  function bindDrop(side, zoneId) {
    const zone = el(zoneId);
    ["dragenter", "dragover"].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.add("is-over");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.remove("is-over");
      });
    });
    zone.addEventListener("drop", async (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) {
        setSide(side, files);
        return;
      }
      const entries = Array.from(e.dataTransfer.items || [])
        .map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry())
        .filter(Boolean);
      if (entries.length) {
        const collected = [];
        await walkEntries(entries, collected);
        setSide(side, collected);
      }
    });
  }

  function renderDiff(diff) {
    const item = document.createElement("div");
    item.className = "diff-item";

    const head = document.createElement("div");
    head.className = "diff-head";
    const time = document.createElement("span");
    time.textContent = `#${diff.line} · ${diff.start} --> ${diff.end}`;
    const tag = document.createElement("span");
    tag.className = "diff-tag " + diff.type;
    tag.textContent = TAG_TEXT[diff.type] || diff.type;
    head.append(time, tag);

    const body = document.createElement("div");
    body.className = "diff-body";

    const mk = (label, text) => {
      const cell = document.createElement("div");
      cell.className = "diff-cell";
      if (!text || text === "（无）") cell.classList.add("is-empty");
      const lab = document.createElement("span");
      lab.className = "lab";
      lab.textContent = label;
      cell.append(lab, document.createTextNode(text || "（无）"));
      return cell;
    };

    body.append(mk("手动版", diff.manual), mk("网站版", diff.website));
    item.append(head, body);
    return item;
  }

  function renderResult(res) {
    el("cmpResult").hidden = false;

    el("cmpSummary").innerHTML =
      `<div>匹配文件 <b>${res.matched}</b> 个</div>` +
      `<div>差异总数 <b>${res.total_diffs}</b> 处</div>`;

    const actions = el("cmpActions");
    actions.innerHTML = "";

    if (res.excel_b64) {
      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.textContent = "下载 Excel 报告";
      btn.addEventListener("click", () => {
        downloadBlob(
          base64ToBlob(res.excel_b64, XLSX_MIME),
          res.excel_name || "字幕对比报告.xlsx"
        );
      });
      actions.appendChild(btn);
    } else {
      const note = document.createElement("span");
      note.className = "muted";
      note.textContent = "Excel 报告不可用（openpyxl 未加载）";
      actions.appendChild(note);
    }

    const list = el("cmpDiffList");
    list.innerHTML = "";

    const reports = (res.reports || []).filter((r) => r.diff > 0);

    if (!reports.length) {
      const ok = document.createElement("div");
      ok.className = "muted";
      ok.textContent = "两份字幕完全一致，没有发现差异。";
      list.appendChild(ok);
      el("cmpDetailTitle").textContent = "差异明细";
      return;
    }

    el("cmpDetailTitle").textContent = `差异明细 · ${res.total_diffs} 处`;

    reports.forEach((rep) => {
      const head = document.createElement("div");
      head.style.cssText =
        "padding:10px 4px 4px;font-size:12.5px;font-weight:600;color:#2d2d3a;";
      head.textContent =
        `${rep.manual} · ${rep.diff} 处` +
        `（新增 ${rep.added} / 缺失 ${rep.removed} / 不同 ${rep.modified}）`;
      list.appendChild(head);
      rep.diffs.forEach((d) => list.appendChild(renderDiff(d)));
    });
  }

  async function run() {
    if (state.busy || !state.a.length || !state.b.length) return;
    state.busy = true;
    el("runCompare").disabled = true;
    el("runCompare").textContent = "对比中…";
    el("cmpResult").hidden = true;
    clearLog();
    log(`开始比对：手动版 ${state.a.length} 个文件，网站版 ${state.b.length} 个文件…`);

    try {
      const pack = async (list) => {
        const out = [];
        for (const file of list) {
          out.push({ name: file.name, b64: await fileToBase64(file) });
        }
        return out;
      };

      const res = await bridge.compare(await pack(state.a), await pack(state.b));

      if (!res.ok) throw new Error(res.error || "对比失败");

      (res.logs || []).forEach((line) => log(line, classify(line)));
      renderResult(res);
      log(
        `对比完毕：匹配 ${res.matched} 个文件，累计差异 ${res.total_diffs} 处。`,
        "line-ok"
      );
    } catch (err) {
      log("❌ " + String((err && err.message) || err), "line-err");
    } finally {
      state.busy = false;
      el("runCompare").textContent = "开始对比";
      refresh();
    }
  }

  el("cmpPickA").addEventListener("click", () => el("cmpPickerA").click());
  el("cmpPickAFolder").addEventListener("click", () => el("cmpFolderA").click());
  el("cmpPickB").addEventListener("click", () => el("cmpPickerB").click());
  el("cmpPickBFolder").addEventListener("click", () => el("cmpFolderB").click());

  el("cmpPickerA").addEventListener("change", (e) => {
    setSide("a", e.target.files);
    e.target.value = "";
  });
  el("cmpFolderA").addEventListener("change", (e) => {
    setSide("a", e.target.files);
    e.target.value = "";
  });
  el("cmpPickerB").addEventListener("change", (e) => {
    setSide("b", e.target.files);
    e.target.value = "";
  });
  el("cmpFolderB").addEventListener("change", (e) => {
    setSide("b", e.target.files);
    e.target.value = "";
  });

  el("cmpClearA").addEventListener("click", () => setSide("a", []));
  el("cmpClearB").addEventListener("click", () => setSide("b", []));

  bindDrop("a", "cmpDropA");
  bindDrop("b", "cmpDropB");

  el("runCompare").addEventListener("click", run);

  refresh();
}
