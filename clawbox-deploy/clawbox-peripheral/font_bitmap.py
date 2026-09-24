"""墨水屏取模字库 —— 每字符独立取模的 1-bit 位图渲染。

背景 (2026-08-28): 官方宣传图汉字清晰, 因为用的是 PCtoLCD2002 预取模位图
(1-bit 直接画点, 无抗锯齿→二值化损失)。矢量字体整行渲染在 10-12px 小字号下
笔画细、复杂字粘连。本模块把每个字符独立取模 (超采样→降采样→阈值→1-bit),
字符在网格内居中, 降采样时边缘损失远小于整行渲染, 效果接近官方取模字库。

适用脚本: CJK/拉丁/西里尔/谚文/假名等"字形独立"脚本。
不适用: 需要整形/连字的脚本 (阿拉伯/波斯 RTL、泰语、天城文) —— 这些保持
矢量渲染 (screen_text.paint_text 原路径), 由调用方决定。

取模参数与官方 PCtoLCD2002 对齐: 阴码 (1=白 0=黑), 逐行式, 高位在前。
"""

import logging

from PIL import Image, ImageChops, ImageDraw, ImageFont

from screen_fonts import load_font

logger = logging.getLogger("clawbox.bitmapfont")

_SUPERSAMPLE = 8
_THRESHOLD = 170
_MICRO_BOLD_MAX_SIZE = 13
_DOWNSAMPLE = getattr(getattr(Image, "Resampling", Image), "BOX", Image.BILINEAR)

# 位图渲染适用的脚本 (字形独立, 无整形/连字需求)
_BITMAP_SCRIPTS = ("cjk", "cjk_ext", "ext", "hangul", "")

# 每字号一个缓存: size -> {char: (bitmap, advance)}
_glyph_cache: dict = {}


def _script_for(locale: str, text: str) -> str:
    """复用 screen_fonts 的脚本检测; 返回 '' 表示纯 ASCII/未知。"""
    from screen_fonts import _detect_script
    return _detect_script(text)


def bitmap_supported(locale: str, text: str) -> bool:
    """该文本是否适合位图渲染 (简单脚本)。"""
    return _script_for(locale, text) in _BITMAP_SCRIPTS


def _glyph(font: ImageFont.FreeTypeFont, char: str):
    """取单个字符的 (1-bit 位图, 矢量 advance)。缓存命中直接返回。"""
    size = int(getattr(font, "size", 0) or 0)
    if size <= 0:
        return None
    cache = _glyph_cache.setdefault(size, {})
    if char in cache:
        return cache[char]

    try:
        scaled_font = font.font_variant(size=size * _SUPERSAMPLE)
    except (OSError, ValueError):
        return None

    # 超采样渲染单字符 (网格内居中, 避免行级降采样的边缘损失)
    # 13px 以下加 1px 描边增重, 与矢量路径的 micro-bold 策略一致
    layer = Image.new("L", (size * _SUPERSAMPLE, size * _SUPERSAMPLE), 255)
    layer_draw = ImageDraw.Draw(layer)
    layer_draw.text(
        (0, 0), char, font=scaled_font, fill=0,
        stroke_width=1 if size <= _MICRO_BOLD_MAX_SIZE else 0,
        stroke_fill=0,
    )
    layer = layer.resize((size, size), _DOWNSAMPLE)

    # 阈值 → 1-bit; 再按字形实际范围裁剪 (tight bbox), 去掉空白边距
    bitmap = layer.point(lambda p: 0 if p < _THRESHOLD else 255).convert("1")
    bbox = bitmap.getbbox()
    if bbox is None:
        cache[char] = (None, 0)
        return cache[char]
    bitmap = bitmap.crop(bbox)

    # 矢量 advance 用于测宽/定位 (与布局测宽一致)
    advance = font.getlength(char)
    cache[char] = (bitmap, advance)
    return cache[char]


def paint_bitmap_text(image, xy, text: str, font: ImageFont.FreeTypeFont,
                      fill=0) -> bool:
    """按位图绘制整行文字; 返回是否全部字符都有位图 (缺字返回 False)。

    字符 x 位置按矢量 advance 累加 (与 _bbox 测宽一致, 布局不变);
    位图按 tight bbox 裁剪后放置, 垂直方向以字形顶部对齐。
    """
    if not text:
        return True
    size = int(getattr(font, "size", 0) or 0)
    if size <= 0:
        return False

    x0, y0 = int(xy[0]), int(xy[1])
    canvas = image
    if image.mode != "1":
        canvas = image.convert("1")

    px = canvas.load()
    x = x0
    for char in text:
        glyph = _glyph(font, char)
        if glyph is None or glyph[0] is None:
            return False
        bitmap, advance = glyph
        bpx = bitmap.load()
        bw, bh = bitmap.size
        for by in range(bh):
            for bx in range(bw):
                if bpx[bx, by] == 0:
                    sx, sy = x + bx, y0 + by
                    if 0 <= sx < canvas.width and 0 <= sy < canvas.height:
                        px[sx, sy] = 0
        x += advance

    if image.mode != "1":
        # 把 1-bit 结果合并回原画布 (L 模式: 0/255 直接可用)
        image.paste(ImageChops.darker(image, canvas))
    return True


def clear_cache() -> None:
    """清空取模缓存 (语言/字体切换时调用, 避免跨字体串用)。"""
    _glyph_cache.clear()