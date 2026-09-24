"""墨水屏字体选择。

界面文案按 locale 选字体；SSID 等动态文字优先按自身字符集选字体，避免外部
文字与界面语言不一致时出现缺字方框。
"""

import os

from config import CHINESE_FONT_PATHS
from PIL import ImageFont

WQY_LOCALES = ("zh-CN", "zh-TW", "ja", "ko", "en")
LATIN_FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
]
KOREAN_FONT_PATHS = [
    # 文泉驿没有完整谚文字形；安装脚本会确保 Noto CJK 存在。
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
]
# 8.12 新增语言所需的多脚本字体 (install.sh 装 fonts-noto-core)。这些字体
# 并不都覆盖 Basic Latin（Arabic/Thai 缺字尤其多），纯 ASCII 动态文字必须
# 改用 DejaVu；本地化文案则避免把两套脚本硬塞进同一个字体对象。
ARABIC_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
THAI_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
DEVANAGARI_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

_CJK_RANGES = (
    (0x2E80, 0x2FDF),   # CJK 部首
    (0x3040, 0x30FF),   # 平假名、片假名
    (0x3100, 0x31BF),   # 注音符号
    (0x31F0, 0x31FF),   # 片假名扩展
    (0x3400, 0x4DBF),   # CJK 扩展 A
    (0x4E00, 0x9FFF),   # CJK 基本区
    (0xF900, 0xFAFF),   # CJK 兼容表意文字
    (0x20000, 0x323AF), # CJK 扩展 B-I
)
_HANGUL_RANGES = (
    (0x1100, 0x11FF), (0x3130, 0x318F),
    (0xA960, 0xA97F), (0xAC00, 0xD7FF),
)
_EXTENDED_LATIN_CYRILLIC_RANGES = (
    (0x0080, 0x024F),   # Latin-1 + 拉丁扩展
    (0x0400, 0x052F),   # 西里尔字母
    (0x1E00, 0x1EFF),   # 拉丁扩展附加（含越南语）
    (0x2DE0, 0x2DFF), (0xA640, 0xA69F),
)
_ARABIC_RANGES = (
    (0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF),
    (0xFB50, 0xFDFF), (0xFE70, 0xFEFF),   # 阿拉伯补充/呈现形式(波斯语用)
)
_THAI_RANGES = ((0x0E00, 0x0E7F),)
_DEVANAGARI_RANGES = ((0x0900, 0x097F),)

_font_cache: dict = {}


def _contains_range(text: str, ranges) -> bool:
    return any(
        any(start <= ord(char) <= end for start, end in ranges)
        for char in text
    )


def _detect_script(text: str) -> str:
    if _contains_range(text, _ARABIC_RANGES): return "arabic"
    if _contains_range(text, _THAI_RANGES): return "thai"
    if _contains_range(text, _DEVANAGARI_RANGES): return "devanagari"
    if _contains_range(text, _HANGUL_RANGES): return "hangul"
    has_cjk = _contains_range(text, _CJK_RANGES)
    has_ext = _contains_range(text, _EXTENDED_LATIN_CYRILLIC_RANGES)
    if has_cjk and has_ext: return "cjk_ext"
    if has_cjk: return "cjk"
    if has_ext: return "ext"
    return ""


_SCRIPT_FONTS = {
    "arabic": lambda: ARABIC_FONT_PATHS + LATIN_FONT_PATHS + CHINESE_FONT_PATHS,
    "thai": lambda: THAI_FONT_PATHS + LATIN_FONT_PATHS + CHINESE_FONT_PATHS,
    "devanagari": lambda: DEVANAGARI_FONT_PATHS + LATIN_FONT_PATHS + CHINESE_FONT_PATHS,
    "hangul": lambda: KOREAN_FONT_PATHS + CHINESE_FONT_PATHS + LATIN_FONT_PATHS,
    "cjk_ext": lambda: KOREAN_FONT_PATHS + CHINESE_FONT_PATHS + LATIN_FONT_PATHS,
    "cjk": lambda: CHINESE_FONT_PATHS + LATIN_FONT_PATHS,
    "ext": lambda: LATIN_FONT_PATHS + CHINESE_FONT_PATHS,
}

_LOCALE_FONTS = {
    "ar": lambda: ARABIC_FONT_PATHS, "fa": lambda: ARABIC_FONT_PATHS,
    "th": lambda: THAI_FONT_PATHS, "hi": lambda: DEVANAGARI_FONT_PATHS,
    "ko": lambda: KOREAN_FONT_PATHS + CHINESE_FONT_PATHS,
}


def font_paths_for_text(locale: str, text: str = "") -> list:
    """返回字体候选；动态文字的字符集优先级高于界面 locale。"""
    text = text if isinstance(text, str) else ""
    if text and text.isascii() and locale in ("hi", "ar", "fa", "th"):
        return LATIN_FONT_PATHS + CHINESE_FONT_PATHS
    script = _detect_script(text)
    if script in _SCRIPT_FONTS:
        return _SCRIPT_FONTS[script]()
    if locale in _LOCALE_FONTS:
        return _LOCALE_FONTS[locale]()
    if locale in WQY_LOCALES:
        return CHINESE_FONT_PATHS
    return LATIN_FONT_PATHS


def load_font(size: int, locale: str, text: str = "") -> ImageFont.FreeTypeFont:
    for font_path in font_paths_for_text(locale, text):
        if not os.path.exists(font_path):
            continue
        cache_key = f"{font_path}_{size}"
        if cache_key in _font_cache:
            return _font_cache[cache_key]
        try:
            font = ImageFont.truetype(font_path, size)
            _font_cache[cache_key] = font
            return font
        except (OSError, ValueError):
            # 字体文件损坏/不可读或大小非法: 跳过换下一个候选
            continue

    cache_key = f"__fallback__{size}"
    if cache_key in _font_cache:
        return _font_cache[cache_key]
    try:
        font = ImageFont.truetype(LATIN_FONT_PATHS[0], size)
    except (OSError, ValueError):
        try:
            font = ImageFont.load_default(size=size)
        except TypeError:
            font = ImageFont.load_default()
    _font_cache[cache_key] = font
    return font
