"""网页端适配层：把浏览器的输入转成 modules 能处理的本地路径，再把结果打包回 JSON。

设计原则：
- 不改动 modules/ 里任何一行业务逻辑
- 所有中间文件都落在 Pyodide 的虚拟文件系统 /work 下，不接触用户真实磁盘
"""
from __future__ import annotations

import base64
import json
import os
import shutil
from pathlib import Path

WORK = Path(os.environ.get("SUB_WORK_DIR", "/work"))


def _reset_work() -> Path:
    if WORK.exists():
        shutil.rmtree(WORK)
    inp = WORK / "input"
    inp.mkdir(parents=True, exist_ok=True)
    return inp


def _unique_path(folder: Path, name: str) -> Path:
    """只取文件名部分，重名时自动加序号，避免覆盖。"""
    safe = Path(name).name or "subtitle.srt"
    p = folder / safe
    if not p.exists():
        return p
    stem, suffix = p.stem, p.suffix
    i = 2
    while True:
        candidate = folder / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def _b64decode(data: str) -> bytes:
    if not data:
        return b""
    return base64.b64decode(data)


def repair_batch(payload_json: str) -> str:
    """批量修复 SRT。返回 JSON 字符串。"""
    from modules.srt_repair import repair_srt
    from modules.report_writer import write_summary_report

    payload = json.loads(payload_json)
    files = payload.get("files") or []
    target_language = payload.get("lang") or "简体中文"

    inp = _reset_work()
    logs: list[str] = []
    out_files: list[dict] = []
    reports = []
    ok_count = 0

    logs.append(f"目标语言：{target_language}")
    logs.append(f"共 {len(files)} 个文件")

    for idx, item in enumerate(files, 1):
        name = item.get("name") or f"file_{idx}.srt"
        try:
            src = _unique_path(inp, name)
            src.write_bytes(_b64decode(item.get("b64", "")))
        except Exception as exc:
            logs.append(f"❌ {name} 写入失败：{exc}")
            out_files.append({"name": name, "ok": False, "error": str(exc)})
            continue

        try:
            rep = repair_srt(src, target_language)
        except Exception as exc:
            logs.append(f"❌ {src.name} 修复出错：{exc}")
            out_files.append({"name": name, "ok": False, "error": str(exc)})
            continue

        reports.append(rep)

        if rep.encoding_failed:
            logs.append(f"⚠ {src.name} 编码无法识别，已跳过")
            out_files.append({
                "name": src.name,
                "ok": False,
                "error": "编码识别失败",
                "encoding": rep.original_encoding,
            })
            continue

        ok_count += 1
        out_b64 = ""
        # 修复只改内容不改名，下载后文件名与原文件完全一致
        out_name = src.name
        try:
            if rep.result_path and rep.result_path.exists():
                out_b64 = base64.b64encode(rep.result_path.read_bytes()).decode("ascii")
        except Exception as exc:
            logs.append(f"⚠ {src.name} 读取结果失败：{exc}")

        warnings = list(rep.warnings or [])
        logs.append(
            f"✔ {src.name} → {rep.cue_count} 条字幕，引擎 {rep.engine or '文本'}"
            + (f"，{len(warnings)} 条提醒" if warnings else "")
        )
        out_files.append({
            "name": out_name,
            "ok": True,
            "source": src.name,
            "cue_count": rep.cue_count,
            "encoding": rep.original_encoding,
            "engine": rep.engine,
            "adjust": rep.timestamp_adjustment_count,
            "trimmed": rep.trimmed_line_count,
            "wrong_language": bool(rep.file_wrong_language),
            "warnings": warnings,
            "b64": out_b64,
        })

    # 报告用的统计：有问题的文件数、问题条目总数
    problem_files = 0
    issue_total = 0
    for r in reports:
        lang_n = len(getattr(r, "language_issues", []) or [])
        fmt_n = len(getattr(r, "format_issues", []) or [])
        wrong = bool(getattr(r, "file_wrong_language", False))
        empty = getattr(r, "cue_count", 0) == 0
        failed = bool(getattr(r, "encoding_failed", False))
        if lang_n or fmt_n or wrong or empty or failed:
            problem_files += 1
        issue_total += lang_n + fmt_n

    report_html = ""
    try:
        report_path = write_summary_report(reports)
        if report_path and Path(report_path).exists():
            report_html = Path(report_path).read_text(encoding="utf-8")
            logs.append("已生成语言检测报告")
    except Exception as exc:
        logs.append(f"⚠ 报告生成失败：{exc}")

    return json.dumps({
        "ok": True,
        "logs": logs,
        "total": len(files),
        "success": ok_count,
        "files": out_files,
        "report_html": report_html,
        "report_stats": {
            "problem_files": problem_files,
            "issue_total": issue_total,
        },
    }, ensure_ascii=False)


def localize_context(payload_json: str) -> str:
    """返回某条匹配的上下文（上下各 3 条字幕），对齐桌面版的语境查看。"""
    import pysubs2

    payload = json.loads(payload_json)
    name = payload.get("file")
    try:
        line_no = int(payload.get("line") or 0)
    except Exception:
        line_no = 0
    text = payload.get("text") or ""

    paths = _LOC_STATE.get("paths") or {}
    path = paths.get(name)
    if not path or not path.exists():
        return json.dumps({"ok": False, "error": "找不到对应字幕文件"}, ensure_ascii=False)

    try:
        subs = pysubs2.load(str(path), encoding="utf-8-sig")
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"读取失败：{exc}"}, ensure_ascii=False)

    target_clean = text.strip()
    idx = -1
    for i, ev in enumerate(subs):
        if ev.text.replace("\\N", " ").strip() == target_clean:
            idx = i
            break
    if idx == -1:
        idx = max(0, min(line_no - 1, len(subs) - 1))

    start = max(0, idx - 3)
    end = min(len(subs) - 1, idx + 3)

    cues = []
    for i in range(start, end + 1):
        ev = subs[i]
        try:
            ms = int(ev.start)
            t = f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
        except Exception:
            t = str(getattr(ev, "start", ""))
        cues.append({
            "num": getattr(ev, "number", i + 1),
            "time": t,
            "text": ev.text.replace("\\N", " "),
            "target": i == idx,
        })

    return json.dumps({
        "ok": True,
        "file": name,
        "line": line_no,
        "cues": cues,
    }, ensure_ascii=False)


def probe() -> str:
    """返回运行环境信息，供界面显示。"""
    import sys
    info = {"python": sys.version.split()[0], "pysubs2": None, "openpyxl": None}
    try:
        import pysubs2
        info["pysubs2"] = getattr(pysubs2, "__version__", "已安装")
    except Exception:
        pass
    try:
        import openpyxl
        info["openpyxl"] = openpyxl.__version__
    except Exception:
        pass
    return json.dumps(info, ensure_ascii=False)


# ============================================================
# 术语替换
# ============================================================

_LOC_STATE: dict = {}


class _SyncFuture:
    def __init__(self, value=None, error=None):
        self._value = value
        self._error = error

    def result(self):
        if self._error:
            raise self._error
        return self._value


class _SyncExecutor:
    """Pyodide 里没有真线程，用同步执行替代线程池，接口保持一致。"""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def submit(self, fn, *args, **kwargs):
        try:
            return _SyncFuture(value=fn(*args, **kwargs))
        except Exception as exc:
            return _SyncFuture(error=exc)


def _patch_threads() -> None:
    """把 term_matcher 里的线程池换掉（不改动 modules 源码）。"""
    import modules.term_matcher as tm
    tm.ThreadPoolExecutor = _SyncExecutor
    tm.as_completed = lambda futures: list(futures)


def localize_scan(payload_json: str) -> str:
    """读取术语清单 + 扫描字幕，返回匹配分组。"""
    from modules.excel_loader import ExcelLoader
    from modules.term_matcher import TermMatcher

    _patch_threads()

    payload = json.loads(payload_json)
    excel_name = payload.get("excel_name") or "terms.xlsx"
    excel_b64 = payload.get("excel_b64") or ""
    files = payload.get("files") or []

    if not excel_b64:
        return json.dumps({"ok": False, "error": "没有收到术语清单"}, ensure_ascii=False)
    if not files:
        return json.dumps({"ok": False, "error": "没有收到字幕文件"}, ensure_ascii=False)

    inp = _reset_work()
    subs_dir = inp / "subs"
    subs_dir.mkdir(parents=True, exist_ok=True)

    xlsx = inp / (Path(excel_name).name or "terms.xlsx")
    xlsx.write_bytes(_b64decode(excel_b64))

    paths = []
    for idx, item in enumerate(files, 1):
        name = item.get("name") or f"file_{idx}.srt"
        p = _unique_path(subs_dir, name)
        p.write_bytes(_b64decode(item.get("b64", "")))
        paths.append(p)

    try:
        rules = ExcelLoader(xlsx).load()
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"读取清单失败：{exc}"}, ensure_ascii=False)

    try:
        matcher = TermMatcher(rules, paths)
        groups = matcher.scan_all()
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"扫描失败：{exc}"}, ensure_ascii=False)

    out_groups = []
    total = 0
    for g in groups:
        if not g.matches:
            continue
        items = []
        for m in g.matches:
            items.append({
                "key": f"{m.file_path.name}|{m.line_number}|{m.matched_text}",
                "file": m.file_path.name,
                "line": m.line_number,
                "text": m.line_text,
                "matched": m.matched_text,
            })
        total += len(items)
        out_groups.append({
            "source": g.rule.source,
            "target": g.rule.target,
            "count": len(items),
            "matches": items,
        })

    _LOC_STATE.clear()
    _LOC_STATE.update({"paths": {p.name: p for p in paths}})

    # 巡检一：清单里同一条术语出现多个不同译文
    from collections import defaultdict

    by_source: dict[str, list[str]] = defaultdict(list)
    for r in rules:
        if r.target not in by_source[r.source]:
            by_source[r.source].append(r.target)
    conflicts = [
        {"source": src, "targets": tgts}
        for src, tgts in by_source.items()
        if len(tgts) > 1
    ]
    conflicts.sort(key=lambda x: -len(x["targets"]))

    # 巡检二：清单里有，但全剧一次都没出现
    seen_sources = {g["source"] for g in out_groups}
    unused = sorted({r.source for r in rules if r.source not in seen_sources})

    return json.dumps({
        "ok": True,
        "rule_count": len(rules),
        "file_count": len(paths),
        "match_count": total,
        "groups": out_groups,
        "audit": {
            "conflicts": conflicts,
            "unused": unused,
        },
    }, ensure_ascii=False)


def localize_apply(payload_json: str) -> str:
    """按勾选结果批量替换，返回每个文件的输出内容。"""
    import re

    payload = json.loads(payload_json)
    decisions = payload.get("decisions") or []

    paths = _LOC_STATE.get("paths") or {}
    if not paths:
        return json.dumps({"ok": False, "error": "扫描数据已失效，请重新扫描"}, ensure_ascii=False)

    per_file: dict[str, list[tuple[int, str, str]]] = {}
    for d in decisions:
        if not d.get("selected"):
            continue
        fname = d.get("file")
        target = (d.get("target") or "").strip()
        matched = d.get("matched") or ""
        try:
            line_no = int(d.get("line") or 0)
        except Exception:
            line_no = 0
        if not fname or not target or not matched or line_no <= 0:
            continue
        per_file.setdefault(fname, []).append((line_no, matched, target))

    outputs = []
    residual: list[dict] = []
    for name, path in paths.items():
        try:
            content = path.read_text(encoding="utf-8-sig", errors="replace")
        except Exception:
            content = path.read_text(encoding="utf-8", errors="replace")

        lines = content.split("\n")
        by_line: dict[int, list[tuple[str, str]]] = {}
        for line_no, source, target in per_file.get(name, []):
            by_line.setdefault(line_no - 1, []).append((source, target))
        for k in by_line:
            by_line[k].sort(key=lambda x: len(x[0]), reverse=True)

        new_lines = []
        for idx, line in enumerate(lines):
            if idx in by_line:
                new_line = line
                for source, target in by_line[idx]:
                    pattern = (
                        rf"(?<![A-Za-z]){re.escape(source)}(?![A-Za-z])"
                        if re.fullmatch(r"[A-Za-z\s]+", source)
                        else re.escape(source)
                    )
                    new_line = re.sub(pattern, target, new_line, flags=re.IGNORECASE)
                # 巡检三：这一行本该换掉，换完还留着原词说明漏了
                for source, target in by_line[idx]:
                    if source and source in target:
                        continue  # 译文本身就含原词，不算残留
                    pattern = (
                        rf"(?<![A-Za-z]){re.escape(source)}(?![A-Za-z])"
                        if re.fullmatch(r"[A-Za-z\s]+", source)
                        else re.escape(source)
                    )
                    if re.search(pattern, new_line, flags=re.IGNORECASE):
                        residual.append({
                            "file": name,
                            "line": idx + 1,
                            "source": source,
                            "text": new_line.strip()[:120],
                        })
                new_lines.append(new_line)
            else:
                new_lines.append(line)

        data = "\n".join(new_lines).encode("utf-8-sig")
        # 只改内容不改名：输出文件名与替换前完全一致
        out_name = path.name
        outputs.append({
            "name": out_name,
            "replaced": len(per_file.get(name, [])),
            "b64": base64.b64encode(data).decode("ascii"),
        })

    # 同一处可能被多条规则命中，按 文件+行+原词 去重
    seen_res = set()
    residual_out = []
    for r in residual:
        key = (r["file"], r["line"], r["source"])
        if key in seen_res:
            continue
        seen_res.add(key)
        residual_out.append(r)
    residual_out.sort(key=lambda x: (x["file"], x["line"]))

    return json.dumps({
        "ok": True,
        "file_count": len(outputs),
        "replaced_total": sum(o["replaced"] for o in outputs),
        "files": outputs,
        "residual": residual_out,
    }, ensure_ascii=False)


def _sub_dir(name: str) -> Path:
    """只清理自己的子目录，不碰其它功能留下的中间状态。"""
    d = WORK / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ============================================================
# 字幕对比
# ============================================================

def _norm_stem(name: str) -> str:
    """和桌面版一致的配对规则：去掉 _localized / _repaired 后忽略大小写。"""
    stem = Path(name).stem
    return stem.replace("_localized", "").replace("_repaired", "").lower()


def compare_batch(payload_json: str) -> str:
    """比对两批字幕文件，返回差异明细 + Excel 报告（base64）。"""
    from modules.comparator import SrtComparator

    payload = json.loads(payload_json)
    manual_files = payload.get("manual") or []
    website_files = payload.get("website") or []

    if not manual_files or not website_files:
        return json.dumps({"ok": False, "error": "两侧都需要至少一个 .srt 文件"}, ensure_ascii=False)

    m_dir = _sub_dir("compare_manual")
    w_dir = _sub_dir("compare_website")

    def _materialize(files, folder):
        table = {}
        for item in files:
            name = item.get("name") or "subtitle.srt"
            path = _unique_path(folder, name)
            path.write_bytes(_b64decode(item.get("b64") or ""))
            table[_norm_stem(name)] = path
        return table

    m_map = _materialize(manual_files, m_dir)
    w_map = _materialize(website_files, w_dir)

    comparator = SrtComparator()
    logs: list[str] = []
    reports: list[dict] = []
    matched = 0
    total_diffs = 0

    for key, m_path in m_map.items():
        w_path = w_map.get(key)
        if w_path is None:
            logs.append(f"⚠️ 未找到对应文件: {m_path.name}")
            continue

        matched += 1
        rep = comparator.compare(m_path, w_path)
        total_diffs += rep.diff_count

        if rep.diff_count:
            logs.append(f"❌ {m_path.name} ⟷ {w_path.name}: 发现 {rep.diff_count} 处差异")
        else:
            logs.append(f"✔ {m_path.name}: 完全一致")

        reports.append({
            "manual": m_path.name,
            "website": w_path.name,
            "total": rep.total_lines,
            "diff": rep.diff_count,
            "added": rep.added_lines,
            "removed": rep.removed_lines,
            "modified": rep.modified_lines,
            "diffs": [
                {
                    "line": d.line_number,
                    "start": d.start_time,
                    "end": d.end_time,
                    "manual": d.manual_text,
                    "website": d.website_text,
                    "type": d.diff_type,
                }
                for d in rep.diffs
            ],
        })

    excel_b64 = ""
    if reports:
        try:
            excel_b64 = _compare_excel(reports)
        except Exception as exc:  # openpyxl 缺失时降级，不影响差异展示
            logs.append(f"⚠️ Excel 报告生成失败: {exc}")

    unmatched = [p.name for k, p in m_map.items() if k not in w_map]
    if unmatched:
        logs.append(f"⚠️ 共 {len(unmatched)} 个文件没有找到对应版本")

    return json.dumps({
        "ok": True,
        "matched": matched,
        "total_diffs": total_diffs,
        "reports": reports,
        "logs": logs,
        "excel_b64": excel_b64,
        "excel_name": "字幕对比报告.xlsx",
    }, ensure_ascii=False)


def _compare_excel(reports: list[dict]) -> str:
    """复刻桌面版 _write_compare_report 的表格样式。"""
    import io

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "字幕差异"
    ws.append(["文件名", "行号", "手动版", "网站版"])

    header_fill = PatternFill(fill_type="solid", fgColor="EDEDED")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    green_font = Font(color="008000")
    red_font = Font(color="C00000")
    row = 2

    for rep in reports:
        if rep["diff"] == 0:
            continue
        first_line = True
        for d in rep["diffs"]:
            if first_line:
                ws.cell(row, 1).value = rep["manual"]
                first_line = False
            ws.cell(row, 2).value = d["line"]
            c3 = ws.cell(row, 3)
            c3.value = d["manual"]
            c3.font = green_font
            c4 = ws.cell(row, 4)
            c4.value = d["website"]
            c4.font = red_font
            row += 1

    if row == 2:
        ws.cell(2, 1).value = "未发现差异"

    ws.column_dimensions["A"].width = 20
    ws.column_dimensions["B"].width = 8
    ws.column_dimensions["C"].width = 55
    ws.column_dimensions["D"].width = 55

    for r in ws.iter_rows(min_row=2):
        for cell in r:
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ============================================================
# 一键立项
# ============================================================

PROJECT_LANG_CODE = {
    "中文": "zh", "英语": "en", "日语": "ja", "韩语": "ko",
    "西语": "es", "泰语": "th", "德语": "de", "法语": "fr",
}

PROJECT_LANG_SHORT = {
    "中文": "中", "英语": "英", "日语": "日", "韩语": "韩",
    "西语": "西", "泰语": "泰", "德语": "德", "法语": "法",
}


def project_spec(payload_json: str) -> str:
    """返回标准目录结构 + 带表头的本地化清单.xlsx（base64）。

    目录结构与桌面版 pages/project_page.py 的 structure 完全一致，
    真正的建目录动作交给浏览器（文件系统 API 或 ZIP 打包）。
    """
    import io

    payload = json.loads(payload_json)
    name = (payload.get("name") or "").strip()
    src = payload.get("src") or "中文"
    dst = payload.get("dst") or "英语"

    if not name:
        return json.dumps({"ok": False, "error": "请填写 ID 剧名"}, ensure_ascii=False)
    if src not in PROJECT_LANG_CODE or dst not in PROJECT_LANG_CODE:
        return json.dumps({"ok": False, "error": f"不支持的语言组合：{src} → {dst}"}, ensure_ascii=False)

    src_code = PROJECT_LANG_CODE[src]
    dst_code = PROJECT_LANG_CODE[dst]
    src_short = PROJECT_LANG_SHORT[src]
    dst_short = PROJECT_LANG_SHORT[dst]

    structure = {
        "净版视频": [f"带{dst}旁白", "仅抹除字幕"],
        f"{dst}旁白": [],
        f"{dst}压制视频": [],
        "原剧": [],
        f"{src_short}{dst_short}字幕": [
            f"{dst_code}修改",
            f"{dst_code}原版",
            f"{src_code}修改",
            f"{src_code}原版",
            "替换",
        ],
    }

    tree = [{"name": main, "children": list(subs)} for main, subs in structure.items()]

    excel_b64 = ""
    excel_error = ""
    try:
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "术语清单"
        ws.append(["Gender", "Source", "Target", "Intro", "Profile"])
        buf = io.BytesIO()
        wb.save(buf)
        excel_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        excel_error = str(exc)

    return json.dumps({
        "ok": True,
        "name": name,
        "src": src,
        "dst": dst,
        "tree": tree,
        "excel_name": "本地化清单.xlsx",
        "excel_b64": excel_b64,
        "excel_error": excel_error,
    }, ensure_ascii=False)
