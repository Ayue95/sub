from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from openpyxl import load_workbook
except ImportError:
    load_workbook = None


@dataclass
class TermRule:
    source: str
    target: str
    gender: str = ""
    intro: str = ""
    profile: str = ""

    def __post_init__(self) -> None:
        # 确保字符串不为空，便于排序
        self.source = self.source.strip()
        self.target = self.target.strip()


class ExcelLoader:
    """读取本地化清单 xlsx 文件"""

    REQUIRED_COLUMNS = {"Gender", "Source", "Target", "Intro", "Profile"}

    def __init__(self, file_path: Path):
        self.file_path = file_path
        self._validate_file()

    def _validate_file(self) -> None:
        if not self.file_path.exists():
            raise FileNotFoundError(f"找不到文件: {self.file_path}")
        if self.file_path.suffix.lower() not in (".xlsx", ".xls"):
            raise ValueError(f"不支持的文件格式: {self.file_path.suffix}，请使用 .xlsx")

    def load(self) -> list[TermRule]:
        """加载并解析术语清单"""
        if load_workbook is None:
            raise ImportError("请先安装 openpyxl: pip install openpyxl")

        workbook = load_workbook(self.file_path, data_only=True)
        sheet = workbook.active
        if sheet is None:
            raise ValueError("Excel 文件没有活动工作表")

        # 读取表头行，定位各列
        headers = self._normalize_headers([cell.value for cell in sheet[1]])

        # 检查必要列是否存在
        missing = self.REQUIRED_COLUMNS - set(headers.keys())
        if missing:
            raise ValueError(f"Excel 缺少必要列: {missing}")

        col_index = {
            "gender": headers.get("Gender"),
            "source": headers.get("Source"),
            "target": headers.get("Target"),
            "intro": headers.get("Intro"),
            "profile": headers.get("Profile"),
        }

        rules: list[TermRule] = []
        for row in sheet.iter_rows(min_row=2, values_only=True):
            source_val = self._get_cell_value(row, col_index["source"])
            target_val = self._get_cell_value(row, col_index["target"])

            if not source_val or not target_val:
                continue  # 跳过空行

            rules.append(
                TermRule(
                    source=str(source_val).strip(),
                    target=str(target_val).strip(),
                    gender=self._get_cell_value(row, col_index["gender"], ""),
                    intro=self._get_cell_value(row, col_index["intro"], ""),
                    profile=self._get_cell_value(row, col_index["profile"], ""),
                )
            )

        if not rules:
            raise ValueError("未解析到任何有效术语条目，请检查 Excel 格式")

        return rules

    @staticmethod
    def _normalize_headers(headers: list[Any]) -> dict[str, int]:
        """规范化表头，转为小写并去除空格"""
        result: dict[str, int] = {}
        for idx, value in enumerate(headers):
            if value is None:
                continue
            normalized = str(value).strip()
            if normalized:
                result[normalized] = idx
        return result

    @staticmethod
    def _get_cell_value(row: tuple[Any, ...], index: int | None, default: str = "") -> str:
        if index is None or index >= len(row):
            return default
        value = row[index]
        if value is None:
            return default
        return str(value).strip()