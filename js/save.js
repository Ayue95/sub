// 结果保存：优先直接写进本地文件夹，浏览器不支持时退回 ZIP
import { base64ToBlob, downloadBlob } from "./pyodide-bridge.js";

export const canSaveToFolder = () => typeof window.showDirectoryPicker === "function";

function b64ToBytes(b64) {
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 递归读取文件夹里的 .srt（跳过上次生成的结果目录，免得读回来）
export async function collectSrtFromDir(dir, out = []) {
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      const f = await entry.getFile();
      if (/\.srt$/i.test(f.name)) out.push(f);
    } else if (entry.kind === "directory") {
      if (entry.name === "替换" || entry.name === "修复") continue;
      await collectSrtFromDir(entry, out);
    }
  }
  return out;
}

// 在指定目录下建好子文件夹并写入文件，不需要用户再选位置
export async function writeFilesInto(parent, folderName, files) {
  const dir = await parent.getDirectoryHandle(folderName, { create: true });
  for (const f of files) {
    const handle = await dir.getFileHandle(f.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(b64ToBytes(f.b64));
    await writable.close();
  }
  return files.length;
}

// 让用户选一个位置，然后自动在里面建好「修复」/「替换」文件夹并写入文件
export async function saveToFolder(folderName, files) {
  const parent = await window.showDirectoryPicker({ mode: "readwrite", id: "sub-output" });
  const dir = await parent.getDirectoryHandle(folderName, { create: true });
  for (const f of files) {
    const handle = await dir.getFileHandle(f.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(b64ToBytes(f.b64));
    await writable.close();
  }
  return { count: files.length, path: parent.name + " / " + folderName };
}

export async function saveAsZip(folderName, files) {
  if (!window.JSZip) {
    files.forEach((f, i) => {
      setTimeout(() => {
        downloadBlob(base64ToBlob(f.b64, "text/plain;charset=utf-8"), f.name);
      }, i * 300);
    });
    return { count: files.length, path: "浏览器下载目录" };
  }
  const zip = new window.JSZip();
  const dir = zip.folder(folderName);
  files.forEach((f) => dir.file(f.name, base64ToBlob(f.b64, "text/plain;charset=utf-8")));
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, folderName + ".zip");
  return { count: files.length, path: "浏览器下载目录 / " + folderName + ".zip" };
}

// 生成「保存到文件夹 / 下载 ZIP」两个按钮 + 一行提示，交给页面自行摆放
export function createSaveControls(folderName, files) {
  const wrap = document.createElement("div");
  wrap.className = "save-controls";

  const hint = document.createElement("span");
  hint.className = "muted save-hint";

  const nodes = [];

  if (canSaveToFolder()) {
    const save = document.createElement("button");
    save.className = "btn primary";
    save.textContent = `保存到「${folderName}」文件夹`;
    save.addEventListener("click", async () => {
      save.disabled = true;
      const old = save.textContent;
      save.textContent = "保存中…";
      try {
        const r = await saveToFolder(folderName, files);
        hint.textContent = `已保存 ${r.count} 个文件 → ${r.path}`;
      } catch (err) {
        if (err && err.name === "AbortError") {
          hint.textContent = "已取消";
        } else {
          hint.textContent = "保存失败：" + String((err && err.message) || err);
        }
      } finally {
        save.disabled = false;
        save.textContent = old;
      }
    });
    nodes.push(save);
  }

  const zip = document.createElement("button");
  zip.className = canSaveToFolder() ? "btn text" : "btn primary";
  zip.textContent = `下载 ${folderName}.zip`;
  zip.addEventListener("click", () => saveAsZip(folderName, files));
  nodes.push(zip);

  wrap.append(...nodes, hint);
  return wrap;
}
