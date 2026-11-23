from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import List, Tuple, Optional


@dataclass
class SubtitleLine:
    """一条字幕（带时间轴和文本）"""
    index: int
    start_time: str  # 格式：HH:MM:SS,mmm
    end_time: str
    text: str
    raw_text: str  # 原始行文本，用于对比

    @property
    def time_key(self) -> str:
        """用于对齐的时间键：起始时间 + 结束时间"""
        return f"{self.start_time}-->{self.end_time}"


@dataclass
class DiffResult:
    """一条差异记录"""
    line_number: int
    start_time: str
    end_time: str
    manual_text: str
    website_text: str
    diff_type: str  # "added", "removed", "modified"


@dataclass
class ComparisonReport:
    """对比报告"""
    manual_file: Path
    website_file: Path
    total_lines: int
    diff_count: int
    diffs: List[DiffResult]
    added_lines: int
    removed_lines: int
    modified_lines: int


class SrtComparator:
    """SRT 字幕对比器（按时间轴对齐）"""

    def __init__(self):
        pass

    def load_srt(self, file_path: Path) -> List[SubtitleLine]:
        """加载 SRT 文件，解析出带时间轴的字幕列表"""
        if not file_path.exists():
            raise FileNotFoundError(f"找不到文件: {file_path}")

        content = file_path.read_text(encoding="utf-8-sig", errors="replace")
        blocks = self._split_blocks(content)
        lines: List[SubtitleLine] = []

        for block in blocks:
            parsed = self._parse_block(block)
            if parsed:
                lines.append(parsed)

        return lines

    def _split_blocks(self, content: str) -> List[str]:
        """按空行分割字幕块"""
        # 统一换行符
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        # 按两个及以上换行分割
        blocks = re.split(r"\n\s*\n", content.strip())
        return [b for b in blocks if b.strip()]

    def _parse_block(self, block: str) -> Optional[SubtitleLine]:
        """解析一个字幕块"""
        lines = block.split("\n")
        if len(lines) < 3:
            return None

        # 第1行：序号
        try:
            index = int(lines[0].strip())
        except ValueError:
            return None

        # 第2行：时间轴 HH:MM:SS,mmm --> HH:MM:SS,mmm
        time_line = lines[1].strip()
        time_match = re.match(
            r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})",
            time_line
        )
        if not time_match:
            return None

        start_time = time_match.group(1).replace(".", ",")
        end_time = time_match.group(2).replace(".", ",")

        # 第3行及之后：文本内容
        text_lines = lines[2:]
        text = " ".join(line.strip() for line in text_lines if line.strip())

        return SubtitleLine(
            index=index,
            start_time=start_time,
            end_time=end_time,
            text=text,
            raw_text=block
        )

    def compare(
        self,
        manual_file: Path,
        website_file: Path,
    ) -> ComparisonReport:
        """
        对比两个字幕文件（按时间轴对齐）
        """
        manual_lines = self.load_srt(manual_file)
        website_lines = self.load_srt(website_file)

        # 按时间键建立索引
        manual_dict = {line.time_key: line for line in manual_lines}
        website_dict = {line.time_key: line for line in website_lines}

        all_keys = set(manual_dict.keys()) | set(website_dict.keys())
        diffs: List[DiffResult] = []

        added_count = 0
        removed_count = 0
        modified_count = 0

        # 按时间顺序排序
        sorted_keys = sorted(all_keys)

        for time_key in sorted_keys:
            manual_line = manual_dict.get(time_key)
            website_line = website_dict.get(time_key)

            if manual_line is None:
                # 网站有，手动没有 → 新增
                added_count += 1
                diffs.append(DiffResult(
                    line_number=website_line.index if website_line else 0,
                    start_time=time_key.split("-->")[0],
                    end_time=time_key.split("-->")[1],
                    manual_text="（无）",
                    website_text=website_line.text if website_line else "",
                    diff_type="added"
                ))
            elif website_line is None:
                # 手动有，网站没有 → 删除
                removed_count += 1
                diffs.append(DiffResult(
                    line_number=manual_line.index,
                    start_time=manual_line.start_time,
                    end_time=manual_line.end_time,
                    manual_text=manual_line.text,
                    website_text="（无）",
                    diff_type="removed"
                ))
            else:
                # 都有 → 对比文本
                if manual_line.text != website_line.text:
                    modified_count += 1
                    diffs.append(DiffResult(
                        line_number=manual_line.index,
                        start_time=manual_line.start_time,
                        end_time=manual_line.end_time,
                        manual_text=manual_line.text,
                        website_text=website_line.text,
                        diff_type="modified"
                    ))

        return ComparisonReport(
            manual_file=manual_file,
            website_file=website_file,
            total_lines=len(sorted_keys),
            diff_count=len(diffs),
            diffs=diffs,
            added_lines=added_count,
            removed_lines=removed_count,
            modified_lines=modified_count,
        )

    def export_report(self, report: ComparisonReport, output_path: Path) -> None:
        """导出对比报告为文本文件"""
        lines = [
            "◌Sub - 字幕对比报告",
            "=" * 50,
            "",
            f"手动版文件: {report.manual_file.name}",
            f"网站版文件: {report.website_file.name}",
            "",
            f"总字幕条数: {report.total_lines}",
            f"差异总数: {report.diff_count}",
            f"  - 网站新增: {report.added_lines} 条",
            f"  - 网站缺失: {report.removed_lines} 条",
            f"  - 内容不同: {report.modified_lines} 条",
            "",
            "=" * 50,
            "详细差异列表:",
            "",
        ]

        for idx, diff in enumerate(report.diffs, 1):
            lines.append(f"[{idx}] 时间: {diff.start_time} --> {diff.end_time}")
            lines.append(f"    手动版: {diff.manual_text}")
            lines.append(f"    网站版: {diff.website_text}")
            lines.append(f"    类型: {diff.diff_type}")
            lines.append("")

        with open(output_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))