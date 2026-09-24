"""152×152 纯黑白屏的文字绘制与换行工具。"""

from PIL import Image, ImageChops, ImageDraw, features

from font_bitmap import paint_bitmap_text

_SUPERSAMPLE = 8
_MICRO_BOLD_MAX_SIZE = 13
_BREAK_CHARS = " -_./"
# BOX averages the supersampled glyph coverage without the ringing/halo that
# LANCZOS can introduce around thin strokes before 1-bit thresholding.
_DOWNSAMPLE = getattr(getattr(Image, "Resampling", Image), "BOX", Image.BILINEAR)

# RTL 语言 (阿拉伯/波斯) 需要正确的双向/连字整形。设备端 Debian python3-pil
# 带 libraqm 可做; PC 端 pip 版无 raqm, 此时透传 direction 会抛 KeyError,
# 因此只在 raqm 可用时启用 (2026-08-12 新增语言支持)。
_raqm = bool(features.check("raqm"))
_rtl = False

# 需要整形/连字的脚本: 位图取模会破坏字形, 必须保持矢量渲染。
# 阿拉伯/波斯 (RTL) 由 _rtl 状态覆盖; 泰语/天城文在此显式排除。
_COMPLEX_SCRIPT_RANGES = (
    (0x0E00, 0x0E7F),   # 泰文 (元音/声调组合)
    (0x0900, 0x097F),   # 天城文 (连字/变体)
)


def set_rtl(flag: bool) -> None:
    """设置当前渲染方向是否为 RTL (screen_pages 切换语言时调用)。"""
    global _rtl
    _rtl = bool(flag)


def _contains_arabic(text: str) -> bool:
    return any(
        "\u0600" <= char <= "\u06ff"
        or "\u0750" <= char <= "\u077f"
        or "\u08a0" <= char <= "\u08ff"
        or "\ufb50" <= char <= "\ufdff"
        or "\ufe70" <= char <= "\ufeff"
        for char in text
    )


def _contains_complex_script(text: str) -> bool:
    return any(
        any(start <= ord(char) <= end for start, end in _COMPLEX_SCRIPT_RANGES)
        for char in text
    )


def _bitmap_eligible(text: str) -> bool:
    """文本是否适合位图取模渲染 (无 RTL/复杂脚本字符)。"""
    return not (_rtl or _contains_arabic(text) or _contains_complex_script(text))


def dir_kwargs(text: str = "") -> dict:
    """按文字本身选择方向；RTL 界面里的 SSID/IP 仍保持 LTR。"""
    return (
        {"direction": "rtl"}
        if (_raqm and _contains_arabic(text))
        else {}
    )


def _text_width(draw, text: str, font) -> int:
    bbox = draw.textbbox((0, 0), text, font=font, **dir_kwargs(text))
    return bbox[2] - bbox[0]


def paint_text(image, xy, text: str, font, fill=0) -> None:
    """绘制文字；优先取模位图 (每字符独立取模, 小字号笔画更饱满)。

    位图路径只适用于字形独立脚本 (CJK/拉丁/西里尔/谚文/假名); RTL 与
    泰语/天城文等需要整形的脚本保持矢量渲染。缺字时回退矢量路径。
    13px 以下矢量路径用 8×渲染实现约 0.125px 的轻量增重。
    """
    size = int(getattr(font, "size", 0) or 0)
    if size <= 0 or image.mode != "L":
        ImageDraw.Draw(image).text(
            xy, text, font=font, fill=fill, **dir_kwargs(text)
        )
        return

    if _bitmap_eligible(text):
        try:
            if paint_bitmap_text(image, xy, text, font, fill=fill):
                return
        except Exception:
            # 位图路径任何异常都回退矢量, 不影响页面生成
            pass

    try:
        scaled_font = font.font_variant(size=size * _SUPERSAMPLE)
    except (OSError, ValueError):
        ImageDraw.Draw(image).text(
            xy, text, font=font, fill=fill, **dir_kwargs(text)
        )
        return

    layer = Image.new(
        "L", (image.width * _SUPERSAMPLE, image.height * _SUPERSAMPLE), 255,
    )
    layer_draw = ImageDraw.Draw(layer)
    layer_draw.text(
        (int(xy[0]) * _SUPERSAMPLE, int(xy[1]) * _SUPERSAMPLE),
        text,
        font=scaled_font,
        fill=fill,
        stroke_width=1 if size <= _MICRO_BOLD_MAX_SIZE else 0,
        stroke_fill=fill,
        **dir_kwargs(text),
    )
    layer = layer.resize(image.size, _DOWNSAMPLE)
    image.paste(ImageChops.darker(image, layer))


def _take_line(draw, text: str, font, max_width: int):
    if not text or _text_width(draw, text, font) <= max_width:
        return text, ""

    end = 1
    for index in range(1, len(text) + 1):
        if _text_width(draw, text[:index], font) > max_width:
            break
        end = index

    prefix = text[:end]
    # SSID 常以空格、连字符、下划线分词；优先在后半行的分隔符处换行。
    split_at = max((prefix.rfind(char) for char in _BREAK_CHARS), default=-1)
    if split_at >= max(1, len(prefix) // 2):
        split_at += 1
        line = prefix[:split_at].rstrip()
        remaining = (prefix[split_at:] + text[end:]).lstrip()
        return line, remaining
    return prefix, text[end:]


def wrap_text(draw, text: str, font, max_width: int, max_lines: int):
    """按真实字体宽度换行，返回 (lines, overflow)。"""
    remaining = text.strip()
    if not remaining:
        return [""], ""

    lines = []
    while remaining and len(lines) < max_lines:
        line, remaining = _take_line(draw, remaining, font, max_width)
        lines.append(line)
    return lines, remaining


def _ellipsize(draw, text: str, font, max_width: int) -> str:
    ellipsis = "..."
    for end in range(len(text), -1, -1):
        candidate = text[:end].rstrip() + ellipsis
        if _text_width(draw, candidate, font) <= max_width:
            return candidate
    return ellipsis


def fit_wrapped_text(draw, text: str, preferred_size: int, min_size: int,
                     max_width: int, max_lines: int, font_loader):
    """优先换行、其次缩字号；到最小字号仍超长时才省略。"""
    for size in range(preferred_size, min_size - 1, -1):
        font = font_loader(size, text=text)
        lines, overflow = wrap_text(draw, text, font, max_width, max_lines)
        if not overflow:
            return font, lines, False

    font = font_loader(min_size, text=text)
    lines, overflow = wrap_text(draw, text, font, max_width, max_lines)
    if overflow:
        lines[-1] = _ellipsize(draw, lines[-1] + overflow, font, max_width)
    return font, lines, bool(overflow)


def paint_lines(image, draw, lines, font, y: int, fill=0, center=True,
                x=None, line_gap: int = 4, right_align=False) -> int:
    """绘制多行并返回下一段建议 y 坐标。"""
    size = int(getattr(font, "size", 0) or 0)
    heights = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font, **dir_kwargs(line))
        heights.append(bbox[3] - bbox[1])
    advance = max([size] + heights) + line_gap

    for index, line in enumerate(lines):
        width = _text_width(draw, line, font)
        line_x = x
        if line_x is None:
            if center:
                line_x = (image.width - width) // 2
            elif right_align:
                line_x = image.width - 4 - width
            else:
                line_x = 4
        paint_text(image, (line_x, y + index * advance), line, font, fill=fill)
    return y + len(lines) * advance
