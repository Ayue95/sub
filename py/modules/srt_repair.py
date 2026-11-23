from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import tempfile

from modules.language_detector import analyze_language

try:
    import pysubs2
except ImportError:
    pysubs2 = None


# 日文假名特征正则（编码检测时用来验证 shift_jis 解码结果是否正确）
_RE_KANA = re.compile(r"[\u3040-\u30ff]")

TIMESTAMP_RE = re.compile(r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$")

# 结束时间早于/等于开始时间时，自动延长多少毫秒
END_TIME_EXTEND_MS = 2000


@dataclass(slots=True)
class Cue:
    start: str
    end: str
    text_lines: list[str]
    timing_suffix: str = ""


@dataclass(slots=True)
class RepairReport:
    source_path: Path
    result_path: Path
    engine: str
    original_encoding: str
    cue_count: int
    timestamp_adjustment_count: int
    trimmed_line_count: int
    warning_count: int
    warnings: list[str] = field(default_factory=list)
    language_issues: list = field(default_factory=list)
    language_summary: dict = field(default_factory=dict)
    format_issues: list = field(default_factory=list)
    file_wrong_language: bool = False
    encoding_failed: bool = False


def find_srt_files_in_directory(directory: Path) -> list[Path]:
    """递归查找目录下所有 .srt 文件（排除 results 文件夹）"""
    return sorted(
        path for path in directory.rglob("*.srt") 
        if path.is_file() and "results" not in path.parts
    )


def repair_srt(source_path: Path, target_language: str = "简体中文") -> RepairReport:
    raw_bytes = source_path.read_bytes()
    original_encoding = _detect_encoding(raw_bytes)

    # 编码识别失败：明确报错，不做任何处理（避免产出乱码结果）
    if original_encoding is None:
        warnings = [
            "编码识别失败：无法识别该文件的文字编码，可能使用了特殊编码或文件已损坏",
        ]
        return RepairReport(
            source_path=source_path,
            result_path=source_path,
            engine="",
            original_encoding="未知",
            cue_count=0,
            timestamp_adjustment_count=0,
            trimmed_line_count=0,
            warning_count=len(warnings),
            warnings=warnings,
            encoding_failed=True,
        )

    engine = "text"
    warnings: list[str] = []
    format_issues: list = []

    if pysubs2 is not None:
        try:
            cues, timestamp_adjustment_count, trimmed_line_count, warnings, format_issues = _repair_with_pysubs2(
                raw_bytes,
                original_encoding,
            )
            engine = "pysubs2"
        except Exception as exc:
            warnings.append(f"pysubs2 修复失败，已回退文本模式: {exc}")
            raw_text = raw_bytes.decode(original_encoding, errors="replace")
            cues, parse_warnings, timestamp_adjustment_count, trimmed_line_count, format_issues = _parse_srt(raw_text)
            warnings.extend(parse_warnings)
    else:
        raw_text = raw_bytes.decode(original_encoding, errors="replace")
        cues, warnings, timestamp_adjustment_count, trimmed_line_count, format_issues = _parse_srt(raw_text)

    if not cues:
        warnings.append(f"警告: 未识别到有效字幕条目（文件可能为空或格式完全错误）")
        # 保持空列表，不生成假字幕；报告里会标记为"空文件"

    # ---------- 语言混杂检测 ----------
    language_report = analyze_language(cues, target_language=target_language)
    language_issues = language_report.issues
    language_summary = language_report.summary

    # 文件放错语言判定：目标语言占比不到一半
    file_wrong_language = language_summary.get("target_ratio", 1.0) < 0.5

    if language_issues:
        mixed_n = language_summary.get("mixed_count", 0)
        term_n = language_summary.get("term_count", 0)
        suspect_n = language_summary.get("suspect_count", 0)
        parts = []
        if mixed_n:
            parts.append(f"{mixed_n} 处语言混杂")
        if term_n:
            parts.append(f"{term_n} 处英语术语")
        if suspect_n:
            parts.append(f"{suspect_n} 处可疑汉字")
        warnings.append("发现 " + "、".join(parts))

    result_dir = source_path.parent / "results"
    report_dir = source_path.parent / "reports"
    result_dir.mkdir(parents=True, exist_ok=True)
    report_dir.mkdir(parents=True, exist_ok=True)

    result_path = result_dir / f"{source_path.stem}_repaired.srt"

    repaired_text = _render_srt(cues)
    _write_text(result_path, repaired_text, encoding="utf-8-sig")

    report = RepairReport(
        source_path=source_path,
        result_path=result_path,
        engine=engine,
        original_encoding=original_encoding,
        cue_count=len(cues),
        timestamp_adjustment_count=timestamp_adjustment_count,
        trimmed_line_count=trimmed_line_count,
        warning_count=len(warnings),
        warnings=warnings,
        language_issues=language_issues,
        language_summary=language_summary,
        format_issues=format_issues,
        file_wrong_language=file_wrong_language,
    )
    return report


def _detect_encoding(raw: bytes):
    # 1. 优先按 BOM（字节序标记）识别，最可靠
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if raw.startswith(b"\xff\xfe"):
        return "utf-16-le"
    if raw.startswith(b"\xfe\xff"):
        return "utf-16-be"

    # 2. 无 BOM：先严格试 utf-8（现代字幕绝大多数是 utf-8）
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass

    # 3. 日文 shift_jis：解码后必须含日文假名，才算日文（避免被 gb18030 等宽编码抢走）
    try:
        if _RE_KANA.search(raw.decode("shift_jis")):
            return "shift_jis"
    except UnicodeDecodeError:
        pass

    # 4. 韩文 euc-kr：解码后谚文占非 ASCII 字符比例高，才算韩文（避免把 gb18030 中文误判成韩文）
    try:
        ko_text = raw.decode("euc-kr")
        non_ascii = [c for c in ko_text if ord(c) > 127]
        hangul_count = sum(1 for c in non_ascii if "\uac00" <= c <= "\ud7af")
        if non_ascii and hangul_count / len(non_ascii) >= 0.8:
            return "euc-kr"
    except UnicodeDecodeError:
        pass

    # 5. 中文 gb18030
    try:
        raw.decode("gb18030")
        return "gb18030"
    except UnicodeDecodeError:
        pass

    # 6. 繁体 big5
    try:
        raw.decode("big5")
        return "big5"
    except UnicodeDecodeError:
        pass

    return None  # 识别失败，交由调用方明确报错（不再用 latin-1 硬解成乱码）


def _repair_with_pysubs2(
    raw_bytes: bytes,
    original_encoding: str,
):
    subs = _load_subs_from_bytes(raw_bytes, original_encoding)
    warnings: list[str] = []
    format_issues: list[dict] = []

    for index, line in enumerate(subs, start=1):
        time_str = _format_ms_time(int(line.start))
        if not line.text or not line.text.strip():
            warnings.append(f"第 {index} 条字幕为空文本")
            format_issues.append({"type": "空文本", "line": index, "time": time_str, "desc": "此条无内容"})
        if line.end <= line.start:
            line.end = line.start + END_TIME_EXTEND_MS
            warnings.append(f"第 {index} 条结束时间早于或等于开始时间，已自动延长 {END_TIME_EXTEND_MS}ms")
            format_issues.append({"type": "结束时间异常", "line": index, "time": time_str, "desc": "结束时间早于开始时间，已自动延长"})
        if index > 1 and line.start < subs[index - 2].end:
            warnings.append(f"第 {index} 条与前一条时间重叠")
            format_issues.append({"type": "时间重叠", "line": index, "time": time_str, "desc": "与上一条时间重叠"})

        if line.text:
            line.text = _normalize_subtitle_text(line.text)

    subs = _round_trip_ass(subs)
    cues, timestamp_adjustment_count, trimmed_line_count = _cues_from_pysubs2(subs)
    return cues, timestamp_adjustment_count, trimmed_line_count, warnings, format_issues


def _load_subs_from_bytes(raw_bytes: bytes, original_encoding: str):
    if pysubs2 is None:
        raise RuntimeError("pysubs2 不可用")

    text = raw_bytes.decode(original_encoding, errors="replace")
    file_descriptor, temp_path = tempfile.mkstemp(suffix=".srt")
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        return pysubs2.load(temp_path, encoding="utf-8")
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def _round_trip_ass(subs):
    if pysubs2 is None:
        return subs

    ass_fd, ass_path = tempfile.mkstemp(suffix=".ass")
    srt_fd, srt_path = tempfile.mkstemp(suffix=".srt")
    os.close(ass_fd)
    os.close(srt_fd)
    try:
        subs.save(ass_path, format_="ass")
        mid = pysubs2.load(ass_path, encoding="utf-8")
        mid.save(srt_path, format_="srt")
        return pysubs2.load(srt_path, encoding="utf-8")
    finally:
        for temp_path in (ass_path, srt_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def _normalize_subtitle_text(text: str) -> str:
    normalized = text.replace("\\N", "\n").replace("\r\n", "\n").replace("\r", "\n")
    parts = [part.strip() for part in normalized.split("\n") if part.strip()]
    return "\n".join(parts) if parts else ""


def _cues_from_pysubs2(subs) -> tuple[list[Cue], int, int]:
    cues: list[Cue] = []
    timestamp_adjustment_count = 0
    trimmed_line_count = 0

    for line in subs:
        start_ms = int(line.start)
        end_ms = int(line.end)
        start_norm = _snap_milliseconds_to_10ms(start_ms % 1000)
        end_norm = _snap_milliseconds_to_10ms(end_ms % 1000)

        start_adjusted = start_norm != (start_ms % 1000)
        end_adjusted = end_norm != (end_ms % 1000)
        timestamp_adjustment_count += int(start_adjusted) + int(end_adjusted)

        text_lines: list[str] = []
        for part in _normalize_subtitle_text(line.text or "").split("\n"):
            cleaned_part = part.rstrip()
            if cleaned_part != part:
                trimmed_line_count += 1
            text_lines.append(cleaned_part)

        cues.append(
            Cue(
                start=_format_ms_time(_replace_ms_component(start_ms, start_norm)),
                end=_format_ms_time(_replace_ms_component(end_ms, end_norm)),
                text_lines=text_lines or [""],
            )
        )

    return cues, timestamp_adjustment_count, trimmed_line_count


def _replace_ms_component(total_ms: int, snapped_ms: int) -> int:
    return (total_ms // 1000) * 1000 + snapped_ms


def _format_ms_time(total_ms: int) -> str:
    hours, remain = divmod(total_ms, 3_600_000)
    minutes, remain = divmod(remain, 60_000)
    seconds, milliseconds = divmod(remain, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def _parse_srt(raw_text: str):
    warnings: list[str] = []
    format_issues: list[dict] = []
    text = raw_text.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    cues: list[Cue] = []
    timestamp_adjustment_count = 0
    trimmed_line_count = 0
    index = 0
    while index < len(lines):
        while index < len(lines) and not lines[index].strip():
            index += 1
        if index >= len(lines):
            break

        if lines[index].strip().isdigit():
            index += 1
            while index < len(lines) and not lines[index].strip():
                index += 1
            if index >= len(lines):
                break

        timing_line = lines[index].strip()
        if "-->" not in timing_line:
            warnings.append(f"跳过无法识别的块，附近内容: {timing_line[:60]}")
            format_issues.append({"type": "无法识别的块", "line": None, "time": "", "desc": f"附近内容: {timing_line[:60]}"})
            while index < len(lines) and lines[index].strip():
                index += 1
            continue

        try:
            start_raw, end_raw, suffix = _split_timing_line(timing_line)
            start, start_adjusted = _normalize_timestamp(start_raw)
            end, end_adjusted = _normalize_timestamp(end_raw)
            timestamp_adjustment_count += int(start_adjusted) + int(end_adjusted)
        except ValueError as exc:
            warnings.append(str(exc))
            format_issues.append({"type": "无法识别的块", "line": None, "time": "", "desc": str(exc)})
            while index < len(lines) and lines[index].strip():
                index += 1
            continue
        index += 1

        text_lines: list[str] = []
        while index < len(lines) and lines[index].strip() != "":
            cleaned_line = lines[index].rstrip()
            if cleaned_line != lines[index]:
                trimmed_line_count += 1
            text_lines.append(cleaned_line)
            index += 1

        cues.append(
            Cue(
                start=start,
                end=end,
                text_lines=text_lines or [""],
                timing_suffix=suffix,
            )
        )

    return cues, warnings, timestamp_adjustment_count, trimmed_line_count, format_issues


def _split_timing_line(line: str) -> tuple[str, str, str]:
    start_raw, rest = [part.strip() for part in line.split("-->", maxsplit=1)]
    if not start_raw or not rest:
        raise ValueError(f"无法识别时间轴行: {line}")

    end_parts = rest.split()
    end_raw = end_parts[0]
    suffix = ""
    if len(end_parts) > 1:
        suffix = " " + " ".join(end_parts[1:])
    return start_raw, end_raw, suffix


def _normalize_timestamp(value: str) -> tuple[str, bool]:
    match = TIMESTAMP_RE.match(value)
    if not match:
        raise ValueError(f"非法时间戳: {value}")

    hours, minutes, seconds, milliseconds = match.groups()
    normalized_milliseconds = _snap_milliseconds_to_10ms(int(milliseconds.ljust(3, "0")[:3]))
    adjusted = normalized_milliseconds != int(milliseconds.ljust(3, "0")[:3])
    return (
        f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},"
        f"{normalized_milliseconds:03d}"
    ), adjusted


def _snap_milliseconds_to_10ms(milliseconds: int) -> int:
    snapped = int(round(milliseconds / 10.0) * 10)
    if snapped > 999:
        return 999
    return snapped


def _render_srt(cues: list[Cue]) -> str:
    blocks: list[str] = []
    for index, cue in enumerate(cues, start=1):
        blocks.append(
            "\r\n".join(
                [
                    str(index),
                    f"{cue.start} --> {cue.end}{cue.timing_suffix}",
                    *cue.text_lines,
                ]
            )
        )
    return "\r\n\r\n".join(blocks) + "\r\n"


def _write_text(path: Path, content: str, encoding: str) -> None:
    with path.open("w", encoding=encoding, newline="") as handle:
        handle.write(content)