export class PyBridge {
  constructor(workerUrl = "js/pyodide-worker.js") {
    this.worker = new Worker(workerUrl);
    this.seq = 0;
    this.pending = new Map();
    this.progressHandlers = [];
    this.ready = null;

    this.worker.onmessage = (event) => {
      const data = event.data || {};

      if (data.type === "progress") {
        this.progressHandlers.forEach((fn) => fn(data.stage, data.msg));
        return;
      }

      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || "未知错误"));
    };

    this.worker.onerror = (event) => {
      const msg = event.message || "Worker 启动失败";
      this.pending.forEach((entry) => entry.reject(new Error(msg)));
      this.pending.clear();
    };
  }

  onProgress(fn) {
    this.progressHandlers.push(fn);
  }

  call(type, payload) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  init() {
    if (!this.ready) this.ready = this.call("init");
    return this.ready;
  }

  repair(files, lang) {
    return this.call("repair", { files, lang });
  }

  compare(manual, website) {
    return this.call("compare", { manual, website });
  }

  projectSpec(name, src, dst) {
    return this.call("project_spec", { name, src, dst });
  }
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取文件失败：" + file.name));
    reader.readAsDataURL(file);
  });
}

export function base64ToBlob(b64, mime = "text/plain;charset=utf-8") {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
