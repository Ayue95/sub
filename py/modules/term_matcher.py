from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Generator, Callable, List
from concurrent.futures import ThreadPoolExecutor, as_completed
import os

from .excel_loader import TermRule


@dataclass
class Match:
    """单个匹配结果"""

    file_path: Path
    line_number: int
    line_text: str
    matched_text: str
    start_pos: int
    end_pos: int
    all_lines: list[str]


@dataclass
class TermMatchGroup:
    """一个术语的所有匹配结果"""

    rule: TermRule
    matches: list[Match]

    @property
    def count(self) -> int:
        return len(self.matches)


class TermMatcher:
    """术语匹配引擎"""

    def __init__(self, rules: list[TermRule], subtitle_files: list[Path]):
        # 保存原始规则顺序（清单顺序）
        self.rules = rules[:]  # 复制一份，不改变原列表
        self.subtitle_files = subtitle_files
        # 编译所有规则的正则表达式（保持顺序）
        self._compiled_patterns: list[tuple[TermRule, re.Pattern]] = []
        # 【性能优化 1】预先排好序的规则索引列表（按 source 长度降序），避免在每一行匹配时重复排序
        self._sorted_indices: list[int] = []

    def _compile_pattern(self, rule: TermRule) -> re.Pattern:
        """
        根据规则编译正则表达式
        - 不区分大小写
        - 英文名前加空格（前后不能是字母）
        """
        source = re.escape(rule.source)
        if re.fullmatch(r"[A-Za-z\s]+", rule.source):
            pattern = rf"(?<![A-Za-z]){source}(?![A-Za-z])"
        else:
            pattern = source
        return re.compile(pattern, re.IGNORECASE)

    def _compile_all_patterns(self) -> None:
        """预编译所有规则的正则表达式，并提前完成先长后短的排序"""
        self._compiled_patterns = [
            (rule, self._compile_pattern(rule)) for rule in self.rules
        ]
        # 【性能优化 1 落实】在这里全局只做一次排序，后续所有行直接复用
        self._sorted_indices = sorted(
            range(len(self._compiled_patterns)),
            key=lambda i: len(self._compiled_patterns[i][0].source),
            reverse=True,
        )

    def scan_all(
        self, progress_callback: Callable[[int, int, str], None] = None
    ) -> list[TermMatchGroup]:
        """
        扫描所有字幕文件，返回匹配结果
        保持清单顺序，同时实现先长后短
        [性能升级]: 引入线程池并发处理各个文件，大幅提升大批量字幕扫描速度
        """
        self._compile_all_patterns()

        # 初始化结果组（保持清单顺序）
        results: list[TermMatchGroup] = []
        rule_to_group = {}
        for rule in self.rules:
            group = TermMatchGroup(rule=rule, matches=[])
            results.append(group)
            rule_to_group[rule.source] = group

        total_files = len(self.subtitle_files)
        all_matches: list[Match] = []

        # 线程安全的工作函数：对单个文件完整执行您的先长后短匹配逻辑
        def process_file(file_path: Path) -> list[Match]:
            file_matches = []
            try:
                lines = self._read_file_lines(file_path)
            except Exception as e:
                print("读取文件失败:", file_path, e)
                return file_matches

            for line_num, line_text in enumerate(lines, 1):
                # 完全保留您原有的行匹配与先长后短排他逻辑，传入已预排序的索引
                file_matches.extend(
                    self._match_single_line_internal(
                        line_text=line_text,
                        file_path=file_path,
                        line_num=line_num,
                        compiled_patterns=self._compiled_patterns,
                        sorted_indices=self._sorted_indices,
                        all_lines=lines,
                    )
                )
            return file_matches

        completed = 0
        max_workers = min(8, os.cpu_count() or 4)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_file = {
                executor.submit(process_file, f): f for f in self.subtitle_files
            }

            for future in as_completed(future_to_file):
                completed += 1
                f_path = future_to_file[future]
                if progress_callback:
                    progress_callback(completed, total_files, f_path.name)
                try:
                    res = future.result()
                    if res:
                        all_matches.extend(res)
                except Exception as exc:
                    print(f"文件处理异常 {f_path}: {exc}")

        # 【性能优化 2】建立小写 source 到对应 Rule 对象的字典映射，避免昂贵的 O(M × N) 双重循环
        lower_rule_map = {rule.source.lower(): rule for rule in self.rules}
        temp_map = {rule.source: [] for rule in self.rules}

        for m in all_matches:
            matched_lower = m.matched_text.lower()
            target_rule = lower_rule_map.get(matched_lower)
            if target_rule:
                temp_map[target_rule.source].append(m)

        for rule in self.rules:
            group = rule_to_group[rule.source]
            group.matches = temp_map.get(rule.source, [])

        print("DEBUG 总术语:", len(results))
        print("DEBUG 有匹配:", len([g for g in results if g.matches]))

        return results

    def _match_single_line_internal(
        self,
        line_text: str,
        file_path: Path,
        line_num: int,
        compiled_patterns: list,
        sorted_indices: list[int],
        all_lines: list[str],
    ) -> list[Match]:
        """内部复用：对单行文本执行先长后短排他匹配（已移除每行重复排序）"""
        line_matches = []
        occupied_positions: list[tuple[int, int]] = []

        for idx in sorted_indices:
            rule, pattern = compiled_patterns[idx]

            for match in pattern.finditer(line_text):
                start, end = match.span()
                matched_text = match.group(0)

                is_occupied = False
                for occ_start, occ_end in occupied_positions:
                    if not (end <= occ_start or start >= occ_end):
                        is_occupied = True
                        break

                if not is_occupied:
                    occupied_positions.append((start, end))
                    line_matches.append(
                        Match(
                            file_path=file_path,
                            line_number=line_num,
                            line_text=line_text.strip(),
                            matched_text=matched_text,
                            start_pos=start,
                            end_pos=end,
                            all_lines=all_lines,
                        )
                    )
        return line_matches

    @staticmethod
    def _read_file_lines(file_path: Path) -> list[str]:
        """读取字幕文件，尝试多种编码"""
        encodings = ("utf-8-sig", "utf-8", "gb18030", "big5", "latin-1")
        for encoding in encodings:
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    return f.readlines()
            except UnicodeDecodeError:
                continue
        raise UnicodeDecodeError(f"无法解码文件: {file_path}")

    def get_context_for_term(
        self,
        group: TermMatchGroup,
        context_lines: int = 2,
    ) -> list[dict]:
        """
        获取某个术语的上下文预览
        """
        contexts = []
        for match in group.matches:
            contexts.append(
                {
                    "file": match.file_path.name,
                    "line_num": match.line_number,
                    "line": match.line_text,
                    "matched": match.matched_text,
                }
            )
        return contexts