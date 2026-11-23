const PYODIDE_VERSION = "v0.27.7";
const CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

const PY_FILES = [
  "modules/__init__.py",
  "modules/srt_repair.py",
  "modules/language_detector.py",
  "modules/report_writer.py",
  "modules/term_matcher.py",
  "modules/comparator.py",
  "modules/excel_loader.py",
  "modules/theme.py",
  "web_adapter.py",
];

importScripts(CDN + "pyodide.js");

let pyodide = null;
let bootPromise = null;
let pkgStatus = { pysubs2: false, openpyxl: false };

function progress(stage, msg) {
  self.postMessage({ type: "progress", stage, msg });
}

async function boot() {
  progress("runtime", "下载 Python 运行时（首次约 10MB）…");
  pyodide = await loadPyodide({ indexURL: CDN });

  progress("packages", "安装依赖 pysubs2 / openpyxl…");
  await pyodide.loadPackage("micropip");
  const micropip = pyodide.pyimport("micropip");

  try {
    await micropip.install("pysubs2");
    pkgStatus.pysubs2 = true;
  } catch (e) {
    pkgStatus.pysubs2 = false;
  }
  try {
    await micropip.install("openpyxl");
    pkgStatus.openpyxl = true;
  } catch (e) {
    pkgStatus.openpyxl = false;
  }

  progress("code", "载入业务逻辑…");
  const base = new URL("../py/", self.location.href).href;
  pyodide.FS.mkdirTree("/lib/modules");

  for (const rel of PY_FILES) {
    // 每次都向服务器确认最新版本，避免改了 py 之后还跑旧逻辑
    const res = await fetch(base + rel, { cache: "no-cache" });
    if (!res.ok) throw new Error("无法加载 " + rel + "（HTTP " + res.status + "）");
    const text = await res.text();
    pyodide.FS.writeFile("/lib/" + rel, text, { encoding: "utf8" });
  }

  pyodide.runPython("import sys\nif '/lib' not in sys.path:\n    sys.path.insert(0, '/lib')");
  progress("ready", "就绪");
  return true;
}

function ensureBoot() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;

  try {
    await ensureBoot();
    const adapter = pyodide.pyimport("web_adapter");

    if (type === "init") {
      const probe = JSON.parse(adapter.probe());
      self.postMessage({ id, ok: true, result: { ...probe, packages: pkgStatus } });
      return;
    }

    if (type === "repair") {
      progress("work", "开始处理…");
      const raw = adapter.repair_batch(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    if (type === "localize_scan") {
      progress("work", "正在扫描术语…");
      const raw = adapter.localize_scan(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    if (type === "localize_apply") {
      progress("work", "正在应用替换…");
      const raw = adapter.localize_apply(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    if (type === "localize_context") {
      const raw = adapter.localize_context(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    if (type === "compare") {
      progress("work", "正在比对字幕…");
      const raw = adapter.compare_batch(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    if (type === "project_spec") {
      progress("work", "正在生成目录结构…");
      const raw = adapter.project_spec(JSON.stringify(payload));
      self.postMessage({ id, ok: true, result: JSON.parse(raw) });
      return;
    }

    self.postMessage({ id, ok: false, error: "未知指令：" + type });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
