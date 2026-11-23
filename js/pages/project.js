import { base64ToBlob, downloadBlob } from "../pyodide-bridge.js";

const el = (id) => document.getElementById(id);

export const LANGS = Object.freeze(["中文", "英语", "西语", "日语", "韩语", "德语", "法语", "泰语"]);

// 共用一套平铺单选控件，保证立项与修复的显示顺序一致。
export function initLanguageChoices(node, value, onChange = () => {}) {
  node.replaceChildren();
  LANGS.forEach((lang) => {
    const label = document.createElement("label");
    label.className = "language-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = node.id;
    input.value = lang;
    input.checked = lang === value;
    input.addEventListener("change", () => {
      if (input.checked) onChange(lang);
    });
    const text = document.createElement("span");
    text.className = "chip";
    text.textContent = lang;
    label.append(input, text);
    node.appendChild(label);
  });
  return () => node.querySelector("input:checked").value;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function initProject(bridge) {
  const supportsFS = typeof window.showDirectoryPicker === "function";
  let dirHandle = null;
  let busy = false;

  function log(text, cls) {
    const box = el("projLog");
    box.closest(".log-card").hidden = false;
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  const getSourceLanguage = initLanguageChoices(el("projSrc"), "中文");
  const getTargetLanguage = initLanguageChoices(el("projDst"), "英语");

  el("projDirInfo").textContent = "";
  // 不支持目录写入时只保留可执行的 ZIP 入口，不展示无效按钮。
  el("projDirectoryCard").hidden = !supportsFS;
  if (!supportsFS) el("runProject").textContent = "生成并下载 ZIP";

  el("projPickDir").addEventListener("click", async () => {
    if (!supportsFS) return;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      el("projDirInfo").textContent = dirHandle.name;
    } catch (err) {
      /* 用户取消，保持原状 */
    }
  });

  el("projName").addEventListener("input", () => {
    el("projName").style.borderColor = "";
  });

  async function writeToDisk(spec) {
    const root = dirHandle;
    const projDir = await root.getDirectoryHandle(spec.name, { create: true });
    log(`🚀 正在初始化项目根目录: ${spec.name} (${spec.src} ➔ ${spec.dst})`);

    for (const node of spec.tree) {
      const main = await projDir.getDirectoryHandle(node.name, { create: true });
      log(`  ├── 📁 ${node.name}`);
      for (const child of node.children) {
        await main.getDirectoryHandle(child, { create: true });
        log(`  │     └── 📂 ${child}`);
      }
    }

    if (spec.excel_b64) {
      const fh = await projDir.getFileHandle(spec.excel_name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(base64ToBlob(spec.excel_b64, XLSX_MIME));
      await writable.close();
      log(`  └── 📊 📄 已自动生成: ${spec.excel_name} (带标准表头)`);
    }

    return `已写入：${root.name} / ${spec.name}`;
  }

  async function buildZip(spec) {
    if (!window.JSZip) throw new Error("ZIP 组件未加载，请刷新页面重试");

    const zip = new window.JSZip();
    // 直接建在压缩包根目录，解压后只有「项目名」这一层，不会出现套娃
    const root = zip;
    log(`🚀 正在打包项目: ${spec.name} (${spec.src} ➔ ${spec.dst})`);

    for (const node of spec.tree) {
      const main = root.folder(node.name);
      log(`  ├── 📁 ${node.name}`);
      for (const child of node.children) {
        main.folder(child);
        log(`  │     └── 📂 ${child}`);
      }
    }

    if (spec.excel_b64) {
      root.file(spec.excel_name, base64ToBlob(spec.excel_b64, XLSX_MIME));
      log(`  └── 📊 📄 已自动生成: ${spec.excel_name} (带标准表头)`);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, spec.name + ".zip");
    return `已打包下载：${spec.name}.zip`;
  }

  async function run() {
    if (busy) return;

    const name = el("projName").value.trim();
    const src = getSourceLanguage();
    const dst = getTargetLanguage();

    if (!name) {
      log("⚠️ 请先填写 ID 剧名", "line-warn");
      el("projName").focus();
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      log('⚠️ 剧名里不能包含 \\ / : * ? " < > | 这些字符', "line-warn");
      return;
    }

    busy = true;
    const btn = el("runProject");
    btn.disabled = true;
    btn.textContent = "正在构建项目…";
    el("projLog").innerHTML = "";
    el("projLog").closest(".log-card").hidden = true;

    try {
      const spec = await bridge.projectSpec(name, src, dst);
      if (!spec.ok) throw new Error(spec.error || "生成失败");

      if (spec.excel_error) {
        log(`⚠️ 本地化清单生成失败: ${spec.excel_error}`, "line-warn");
      }

      let done;
      if (dirHandle && supportsFS) {
        done = await writeToDisk(spec);
      } else {
        done = await buildZip(spec);
      }

      log(`🎉 一键立项完成！${done}`, "line-ok");
      el("projName").value = "";
    } catch (err) {
      log("❌ 创建失败: " + String((err && err.message) || err), "line-err");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = supportsFS ? "一键生成标准目录" : "生成并下载 ZIP";
    }
  }

  el("runProject").addEventListener("click", run);
  el("projName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
}
