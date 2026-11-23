from __future__ import annotations
from pathlib import Path
import hashlib
import html


def _file_hash(path: Path) -> str:
    """计算文件内容的 MD5，用于重复文件检测。"""
    return hashlib.md5(path.read_bytes()).hexdigest()


def write_summary_report(reports: list):
    """生成网页版「字幕语言检测报告」（.html，双击用浏览器打开）。"""
    if not reports:
        return None

    report_dir = reports[0].result_path.parent.parent / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "Subtitle_Repair_Report.html"

    # 目标语言（一次批量修复，所有文件用同一个目标语言）
    target = ""
    first = reports[0]
    if hasattr(first, "language_summary") and first.language_summary:
        target = first.language_summary.get("target_language", "")

    # 收集有问题的文件
    problem_files = [r for r in reports if (
        (hasattr(r, "language_issues") and r.language_issues)
        or (hasattr(r, "format_issues") and r.format_issues)
        or getattr(r, "file_wrong_language", False)
        or getattr(r, "cue_count", 0) == 0
        or getattr(r, "encoding_failed", False)
    )]

    cards: list[str] = []
    rendered_rows = 0
    for r in problem_files:
        ls = r.language_summary or {}
        wrong = getattr(r, "file_wrong_language", False)

        # 统计徽章
        badges: list[str] = []
        if ls.get("mixed_count"):
            badges.append(f'<span class="badge badge-danger">混杂 {ls["mixed_count"]}</span>')
        if ls.get("term_count"):
            badges.append(f'<span class="badge badge-info">英语术语 {ls["term_count"]}</span>')
        if ls.get("suspect_count"):
            badges.append(f'<span class="badge badge-warning">可疑汉字 {ls["suspect_count"]}</span>')
        if hasattr(r, "format_issues") and r.format_issues:
            badges.append(f'<span class="badge badge-gray">格式 {len(r.format_issues)}</span>')

        # 文件放错横幅
        wrong_banner = ""
        if wrong:
            ratio = int(ls.get("target_ratio", 0) * 100)
            wrong_banner = (
                '<div class="wrong-banner">⚠ 文件语言不符：目标语言「'
                + html.escape(target) + f'」仅占 {ratio}%，可能放错文件夹</div>'
            )

        # 空文件横幅
        empty_banner = ""
        if getattr(r, "cue_count", 0) == 0 and not getattr(r, "encoding_failed", False):
            empty_banner = '<div class="wrong-banner">⚠ 空文件：未识别到有效字幕</div>'

        # 编码识别失败横幅
        encoding_banner = ""
        if getattr(r, "encoding_failed", False):
            encoding_banner = '<div class="wrong-banner">⚠ 编码识别失败：无法识别该文件的文字编码，可能用了特殊编码或文件已损坏</div>'

        # 条目：语言问题（彩色）+ 格式瑕疵（灰色）
        rows: list[str] = []

        # 语言问题（文件放错时，混杂条目不逐条列，避免满屏）
        for item in (r.language_issues if hasattr(r, "language_issues") else []):
            itype = item.get("type", "")
            if wrong and itype == "mixed":
                continue
            time = (item.get("time") or "").split(",")[0]
            line_no = item.get("line", "")
            text = html.escape(item.get("text", ""))
            if itype == "mixed":
                label, tag_class = html.escape(item.get("language", "")), "tag-danger"
            elif itype == "term":
                label, tag_class = "英语术语", "tag-info"
            elif itype == "suspect":
                label, tag_class = "可疑汉字", "tag-warning"
            else:
                label, tag_class = html.escape(item.get("language", "")), "tag-danger"
            rows.append(_row(label, tag_class, time, line_no, text))

        # 格式瑕疵（灰色）
        for fi in (r.format_issues if hasattr(r, "format_issues") else []):
            time = (fi.get("time") or "").split(",")[0]
            line_no = fi.get("line")
            desc = html.escape(fi.get("desc", ""))
            rows.append(_row(fi.get("type", ""), "tag-gray", time, line_no, desc))

        rendered_rows += len(rows)
        cards.append(
            '<div class="file-card">'
            f'<div class="file-header"><span class="filename">{html.escape(r.source_path.name)}</span>'
            f'{"".join(badges)}</div>'
            f'{wrong_banner}'
            f'{empty_banner}'
            f'{encoding_banner}'
            f'<table>{"".join(rows)}</table>'
            '</div>'
        )

    # 重复文件检测
    dup_blocks: list[str] = []
    seen: dict[str, Path] = {}
    for r in reports:
        h = _file_hash(r.source_path)
        if h in seen:
            dup_blocks.append(
                '<div class="dup-line">'
                + html.escape(seen[h].name) + ' 和 ' + html.escape(r.source_path.name)
                + ' 内容相同，可能命名搞错</div>'
            )
        else:
            seen[h] = r.source_path

    dup_section = ""
    if dup_blocks:
        dup_section = (
            '<div class="dup-section"><div class="dup-title">重复文件</div>'
            + "".join(dup_blocks) + '</div>'
        )

    if problem_files or dup_blocks:
        body = "".join(cards) + dup_section
    else:
        body = '<div class="empty">所有文件均无问题</div>'

    target_badge = f'<span class="target">目标语言：{html.escape(target)}</span>' if target else ""

    overview = (
        '<div class="overview">'
        f'<div class="ov"><b>{len(reports)}</b><span>检查文件</span></div>'
        f'<div class="ov{" is-bad" if problem_files else ""}"><b>{len(problem_files)}</b><span>有问题</span></div>'
        f'<div class="ov{" is-bad" if rendered_rows else ""}"><b>{rendered_rows if rendered_rows else "—"}</b><span>问题条目</span></div>'
        f'<div class="ov"><b>{len(dup_blocks)}</b><span>重复文件</span></div>'
        '</div>'
    )

    html_doc = _page_html(target_badge, overview + body)
    report_path.write_text(html_doc, encoding="utf-8")
    return report_path


def _row(label: str, tag_class: str, time: str, line_no, text: str) -> str:
    """生成表格中的一行。line_no 为 None 时不显示第几条。"""
    line_cell = f'<td class="line">第{line_no}条</td>' if line_no is not None else '<td class="line"></td>'
    return (
        f'<tr><td class="tag {tag_class}">{label}</td>'
        f'<td class="time">{time}</td>'
        f'{line_cell}'
        f'<td class="text">{text}</td></tr>'
    )


def _page_html(target_badge: str, body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>字幕语言检测报告</title>
<style>
body {{ font-family: "Microsoft YaHei", "PingFang SC", sans-serif; max-width: 780px; margin: 40px auto; padding: 0 24px; color: #333; background: #f6f7f9; line-height: 1.6; }}
.header {{ display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }}
.header h1 {{ font-size: 20px; margin: 0; font-weight: 600; }}
.target {{ background: #e6f1fb; color: #185fa5; font-size: 13px; padding: 3px 14px; border-radius: 99px; }}
.file-card {{ background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 18px 22px; margin-bottom: 16px; }}
.file-header {{ display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }}
.filename {{ font-size: 15px; font-weight: 600; }}
.badge {{ font-size: 12px; padding: 2px 10px; border-radius: 99px; white-space: nowrap; }}
.badge-danger {{ background: #fcebeb; color: #a32d2d; }}
.badge-info {{ background: #e6f1fb; color: #185fa5; }}
.badge-warning {{ background: #faeeda; color: #854f0b; }}
.badge-gray {{ background: #f1efe8; color: #5f5e5a; }}
.wrong-banner {{ background: #fcebeb; color: #a32d2d; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; margin-bottom: 12px; }}
table {{ width: 100%; border-collapse: collapse; }}
td {{ padding: 8px 0; border-top: 1px solid #f0f1f3; font-size: 14px; vertical-align: top; }}
tr:first-child td {{ border-top: none; }}
.tag {{ font-weight: 600; font-size: 13px; width: 78px; white-space: nowrap; }}
.tag-danger {{ color: #d84a3a; }}
.tag-info {{ color: #378add; }}
.tag-warning {{ color: #b9791a; }}
.tag-gray {{ color: #888780; }}
.time {{ font-family: "Consolas", "Menlo", monospace; color: #8a8f98; font-size: 13px; width: 88px; white-space: nowrap; }}
.line {{ color: #a8adb6; font-size: 13px; width: 72px; white-space: nowrap; }}
.text {{ color: #333; }}
.dup-section {{ background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 18px 22px; margin-top: 24px; }}
.dup-title {{ font-size: 14px; font-weight: 600; color: #a32d2d; margin-bottom: 10px; }}
.dup-line {{ font-size: 13px; color: #a32d2d; padding: 4px 0; }}
.overview {{ display: flex; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }}
.ov {{ flex: 1 1 110px; background: #fff; border: 1px solid #eceef1; border-radius: 12px; padding: 14px 20px; min-width: 110px; }}
.ov b {{ display: block; font-size: 22px; font-weight: 600; line-height: 1.25; }}
.ov span {{ font-size: 12px; color: #8a8f98; }}
.ov.is-bad b {{ color: #d84a3a; }}
.empty {{ color: #999; text-align: center; padding: 60px 0; font-size: 15px; }}
</style>
</head>
<body>
<div class="header"><h1>字幕语言检测报告</h1>{target_badge}</div>
{body}
</body>
</html>
"""
