from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# 目标语言（下拉框选项，按此顺序显示）
# ---------------------------------------------------------------------------
TARGET_LANGUAGES = [
    "简体中文", "英语", "日语", "韩语", "西班牙语", "泰语", "德语", "法语",
]

# 下拉框"目标语言名" → 内部标签
_TARGET_TO_DETECTED = {
    "简体中文": "中文",
    "英语": "英语",
    "日语": "日文",
    "韩语": "韩文",
    "西班牙语": "西班牙语",
    "泰语": "泰文",
    "德语": "德语",
    "法语": "法语",
}

# 字母语言（都用英文字母，靠特殊符号尽量区分）
_LATIN_LANGS = {"英语", "西班牙语", "德语", "法语"}

# ---------------------------------------------------------------------------
# Unicode 字符范围（字符级脚本检测）
# ---------------------------------------------------------------------------
_RE_HAN = re.compile(r"[\u4e00-\u9fff]")                               # 汉字（中日共用）
_RE_KANA = re.compile(r"[\u3040-\u30ff\uff66-\uff9f]")                 # 假名（平/片/半角）
_RE_HANGUL = re.compile(r"[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]")  # 韩文
_RE_THAI = re.compile(r"[\u0e00-\u0e7f]")                              # 泰文
_RE_LATIN = re.compile(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff\uff21-\uff3a\uff41-\uff5a]")  # 拉丁字母（含特殊符号）

# 拉丁语系细分：靠各语言"独有特殊符号"区分（纯字母内容无法区分）
_ES_MARKERS = "ñ¿¡"     # 西班牙语独有
_DE_MARKERS = "äöß"     # 德语独有
_FR_MARKERS = "çœæ"     # 法语独有

# 简体信号字符集：简化偏旁 + 高频简体字（这些字形日文不用，用于标记"疑似中文"）
_SIMPLIFIED_MARKERS = (
    "讠纟钅饣贝页见车马鸟鱼龙韦风长门"
    "这们个从众亲爱办务觉传专价变备实审军农严义应兴举电头铁听图团对动无开关还边过进远运连达选"
)

# 术语判定：英文单词数不超过该值视为"术语"，超过视为"成句英文"
TERM_MAX_WORDS = 2
_EN_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’-]*")


@dataclass
class LanguageReport:
    """一次完整语言分析的返回结果。"""
    issues: list = field(default_factory=list)
    summary: dict = field(default_factory=dict)


def _has_simplified(text: str) -> bool:
    """是否含简体信号字符（用于在日语目标下标记"疑似中文"）。"""
    return any(ch in _SIMPLIFIED_MARKERS for ch in text)


def _latin_lang(text: str) -> str:
    """对拉丁字母内容细分语言（靠独有特殊符号，纯字母归"英语"）。"""
    es = sum(text.count(c) for c in _ES_MARKERS)
    de = sum(text.count(c) for c in _DE_MARKERS)
    fr = sum(text.count(c) for c in _FR_MARKERS)
    if fr > es and fr > de:
        return "法语"
    if de > es:
        return "德语"
    if es > 0:
        return "西班牙语"
    return "英语"


def _is_ignorable(text: str) -> bool:
    """过滤空行、纯数字/标点。"""
    t = re.sub(r"\s+", " ", text).strip()
    if not t:
        return True
    if re.fullmatch(
        r"[\d\s.,!?%$€£¥\-:()\"'’‘“”…·~+=\[\]{}<>/\\|@#&*^_、。，！？；：…（）【】《》]+",
        t,
    ):
        return True
    return False


def _count_english_words(text: str) -> int:
    """统计纯字母英文单词个数（判断"术语"还是"成句英文"）。"""
    return len(_EN_WORD_RE.findall(text))


def analyze_language(cues, target_language: str = "简体中文") -> LanguageReport:
    """
    以用户指定的目标语言为基准，检测字幕中混入的其他语言。

    issues 每项结构：
        {
            "line": 5,                # 1 起始的条目序号
            "time": "00:00:03,000",   # 该条字幕的时间码
            "type": "mixed" | "term" | "suspect",
                                       # mixed=语言混杂；term=疑似英语术语；suspect=疑似中文
            "language": "韩文",
            "text": "안녕하세요",
        }
    """
    target = _TARGET_TO_DETECTED.get(target_language, target_language)
    target_is_latin = target in _LATIN_LANGS

    issues: list = []
    total_count = 0
    target_count = 0

    for idx, cue in enumerate(cues, start=1):
        text = "\n".join(cue.text_lines)
        time = getattr(cue, "start", "") or ""
        if _is_ignorable(text):
            continue

        kana = len(_RE_KANA.findall(text))
        han = len(_RE_HAN.findall(text))
        hangul = len(_RE_HANGUL.findall(text))
        thai = len(_RE_THAI.findall(text))
        latin = len(_RE_LATIN.findall(text))

        if not (kana or han or hangul or thai or latin):
            continue
        total_count += 1

        # ---- 生成该行出现的"语言信号"列表 ----
        signals: list[str] = []

        # 汉字/假名（中日共字，需结合假名与简体信号判断）
        if kana:
            signals.append("日文")                      # 含假名 → 日文（铁证）
        elif han:
            if target == "日文" and _has_simplified(text):
                signals.append("疑似中文")               # 日语目标下，纯汉字含简体信号 → 疑似中文
            elif target in ("韩文", "泰文") or target_is_latin:
                signals.append("中文")                   # 韩/泰/字母目标下，纯汉字 → 中文混入
            else:
                signals.append(target)                   # 中文/日语目标下，纯汉字 = 目标语言（正常）

        if hangul:
            signals.append("韩文")
        if thai:
            signals.append("泰文")
        if latin:
            signals.append(_latin_lang(text))

        # 该条字幕是否属于目标语言（用于统计文件语言占比）
        if target in signals:
            target_count += 1
        elif target_is_latin and "英语" in signals:
            # 目标语言是字母语言（英/西/德/法）时，纯字母无法区分，视为目标语言本身
            target_count += 1

        # ---- 逐信号判定 ----
        for lang in signals:
            if lang == target:
                continue

            if lang == "疑似中文":
                issues.append({"line": idx, "time": time, "type": "suspect", "language": "中文", "text": text})
            elif lang == "英语" and target_is_latin:
                # 目标也是字母语言：纯字母视为目标语言本身，忽略（无法区分）
                continue
            elif lang == "英语" and not target_is_latin:
                words = _count_english_words(text)
                if words <= TERM_MAX_WORDS:
                    issues.append({"line": idx, "time": time, "type": "term", "language": "英语", "text": text})
                else:
                    issues.append({"line": idx, "time": time, "type": "mixed", "language": "英语", "text": text})
            else:
                issues.append({"line": idx, "time": time, "type": "mixed", "language": lang, "text": text})

    summary = {
        "target_language": target_language,
        "mixed_count": sum(1 for i in issues if i["type"] == "mixed"),
        "term_count": sum(1 for i in issues if i["type"] == "term"),
        "suspect_count": sum(1 for i in issues if i["type"] == "suspect"),
        "total_count": total_count,
        "target_count": target_count,
        "target_ratio": (target_count / total_count) if total_count else 1.0,
    }
    return LanguageReport(issues=issues, summary=summary)
