"""
屏幕页面渲染器 (B&W) —— 152x152 纯黑白墨水屏
==============================================
说明页 + 三个页面 + 启动画面 / 错误画面。
返回单个 1-bit PIL Image。
"""

from config import (
    DEFAULT_SCREEN_LOCALE,
    EPD_HEIGHT,
    EPD_WIDTH,
    QR_BORDER,
    QR_BOX_SIZE,
    QR_SIZE,
)
from PIL import Image, ImageDraw
from qr_generator import generate_qr, qr_image_fit_for_screen
from screen_fonts import (
    font_paths_for_text,
    load_font,
)
from screen_strings import STRINGS
from screen_text import (
    dir_kwargs,
    fit_wrapped_text,
    paint_lines,
    paint_text,
)
from screen_text import (
    set_rtl as _set_text_rtl,
)

INK = 0
BG = 255

# ============================================================
# 屏幕语言 (跟随前端 locale.json; 未知语种回退英文)
# 与前端 i18n.config.ts 的 21 种语言对齐 (pt-BR 按主语言映射到 pt)。
# ============================================================
SUPPORTED_LOCALES = (
    "zh-CN", "zh-TW", "ja", "ko",
    "en", "es", "de", "fr", "pt", "it", "ru", "nl", "pl", "vi",
    "hi", "ar", "tr", "uk", "id", "fa", "th",
)
_current_locale = DEFAULT_SCREEN_LOCALE

# 这四种语言已经过实屏排版确认，说明页保持原布局。其余语言使用紧凑列表，
# 通过真实字体测宽动态选字号，避免拉丁/西里尔/谚文在 152px 屏右侧被裁掉。
_VERIFIED_HELP_LOCALES = {"zh-CN", "zh-TW", "ja", "en"}

# 从右到左书写的语言: 渲染/测宽需启用 direction=rtl (设备端 raqm)。
_RTL_LOCALES = {"ar", "fa"}



def _str(key: str) -> str:
    """取当前语言文案; 缺失键回退默认语言/原键, 任何情况下不抛异常。"""
    table = STRINGS.get(_current_locale) or STRINGS[DEFAULT_SCREEN_LOCALE]
    return table.get(key, key)


def _bbox(draw, text: str, font):
    """与绘制方向一致的测宽/测高 (RTL 语言透传 direction=rtl)。"""
    return draw.textbbox((0, 0), text, font=font, **dir_kwargs(text))


def resolve_screen_locale(raw_locale: str) -> str:
    """原始语言代码 → 屏幕支持的规范语言。

    前端传任意 BCP-47 代码: 中文按简繁细分 (zh-CN/zh-TW, 含 zh-HK/zh-MO/zh-Hant 等);
    其余按主语言匹配 21 种支持语言; 未知语种回退英文 (152px 屏"先放得下、再达意")。
    """
    if not isinstance(raw_locale, str) or not raw_locale.strip():
        return DEFAULT_SCREEN_LOCALE
    code = raw_locale.strip().lower().replace("_", "-")
    zh_map = {
        "zh": "zh-CN", "zh-cn": "zh-CN", "zh-sg": "zh-CN", "zh-my": "zh-CN",
        "zh-hans": "zh-CN",
        "zh-tw": "zh-TW", "zh-hk": "zh-TW", "zh-mo": "zh-TW", "zh-hant": "zh-TW",
    }
    if code in zh_map:
        return zh_map[code]
    if code.startswith("zh"):
        return "zh-CN"
    by_lang = {loc.lower(): loc for loc in SUPPORTED_LOCALES}
    return by_lang.get(code.split("-")[0], "en")


def set_locale(raw_locale: str) -> str:
    """切换屏幕文案语言 (守护进程检测到 locale.json 变化时调用)。"""
    global _current_locale
    _current_locale = resolve_screen_locale(raw_locale)
    _set_text_rtl(_current_locale in _RTL_LOCALES)
    return _current_locale


def get_locale() -> str:
    return _current_locale


def _font_paths_for_text(text: str = "") -> list:
    return font_paths_for_text(_current_locale, text)


def _load_font(size: int, text: str = ""):
    return load_font(size, _current_locale, text)


def _new_canvas() -> Image.Image:
    return Image.new("L", (EPD_WIDTH, EPD_HEIGHT), BG)


def _finalize(img: Image.Image) -> Image.Image:
    """将灰度稿转换为屏幕需要的 1-bit 图像。

    文字先在 ``L`` 模式绘制，保留 FreeType 的抗锯齿灰度。误差扩散对大字
    边缘有帮助，但会把 12px 左右的小字打散成虚线。因此这里使用稳定阈值
    收敛；小字号本身已经由 ``paint_text`` 的超采样抗锯齿处理。
    """
    return img.point(lambda p: 0 if p < 170 else 255).convert("1")


def _draw_text(img, draw, text, y, font, fill=INK, center=True,
               max_width=None, x=None):
    max_w = max_width or (EPD_WIDTH - 6)
    if center:
        bbox_full = _bbox(draw, text, font)
        if bbox_full[2] - bbox_full[0] > max_w:
            for i in range(len(text) - 1, 0, -1):
                if _bbox(draw, text[:i] + "...", font)[2] <= max_w:
                    text = text[:i] + "..."
                    break
    bbox = _bbox(draw, text, font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    if x is None:
        if center:
            x = (EPD_WIDTH - tw) // 2
        elif _current_locale in _RTL_LOCALES:
            x = EPD_WIDTH - 4 - tw
        else:
            x = 4
    paint_text(img, (x, y), text, font=font, fill=fill)
    return y + th + 2


def _fit_font_to_width(draw, text: str, preferred_size: int, min_size: int,
                       max_width: int):
    """按当前语言的真实字体测宽，返回能完整放下文本的最大字号。

    152px 屏上省略动作词会让用户看不懂，所以先逐级缩小；只有连最小字号也
    放不下时，调用方才会做末尾省略。常规 UI 文案的最小字号均不低于 12px。
    """
    for size in range(preferred_size, min_size - 1, -1):
        font = _load_font(size, text=text)
        bbox = _bbox(draw, text, font)
        if bbox[2] - bbox[0] <= max_width:
            return font, text

    font = _load_font(min_size, text=text)
    ellipsis = "..."
    for end in range(len(text), 0, -1):
        candidate = text[:end].rstrip() + ellipsis
        bbox = _bbox(draw, candidate, font)
        if bbox[2] - bbox[0] <= max_width:
            return font, candidate
    return font, ellipsis


def _draw_fitted_text(img, draw, text: str, y: int, preferred_size: int,
                      min_size: int = 12, fill=INK, center=True,
                      max_width=None, x=None):
    """完整文案优先的单行绘制：仅在超宽时缩字号，最后才省略。"""
    max_w = max_width or (EPD_WIDTH - 6)
    font, fitted = _fit_font_to_width(
        draw, text, preferred_size=preferred_size,
        min_size=min_size, max_width=max_w,
    )
    bbox = _bbox(draw, fitted, font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    if x is None:
        x = (EPD_WIDTH - tw) // 2 if center else 4
    paint_text(img, (x, y), fitted, font=font, fill=fill)
    return y + th + 2


def _draw_help_title(img, draw, y: int) -> None:
    """分别用本地文字与拉丁字体绘制标题，避免单脚本字体把 K 画成方块。

    关键：中文/日文与拉丁字体 baseline 不同，直接用同一 y 会导致 K1-K4 偏上。
    这里计算两文本的垂直中心线，令中心线对齐（中部对齐）。
    """
    label = _str("help_buttons")
    key_range = "K1-K4"
    gap = 5
    max_width = EPD_WIDTH - 6

    for size in range(15, 11, -1):
        label_font = _load_font(size, text=label)
        key_font = _load_font(size, text=key_range)
        label_bbox = _bbox(draw, label, label_font)
        key_bbox = _bbox(draw, key_range, key_font)
        label_width = label_bbox[2] - label_bbox[0]
        key_width = key_bbox[2] - key_bbox[0]
        if label_width + gap + key_width <= max_width:
            break

    total_width = label_width + gap + key_width
    left = (EPD_WIDTH - total_width) // 2

    # 垂直中心对齐：计算两文本各自的中心 y，取平均作为绘制基线
    # bbox[1] 是顶部（负值），bbox[3] 是底部；中心 = (top + bottom) / 2
    label_cy = (label_bbox[1] + label_bbox[3]) / 2
    key_cy = (key_bbox[1] + key_bbox[3]) / 2
    # 目标中心线取两者平均（也可只以 label 为准，这里取平均更稳）
    target_cy = (label_cy + key_cy) / 2

    if _current_locale in _RTL_LOCALES:
        runs = (
            (key_range, key_font, key_bbox, left),
            (label, label_font, label_bbox, left + key_width + gap),
        )
    else:
        runs = (
            (label, label_font, label_bbox, left),
            (key_range, key_font, key_bbox, left + label_width + gap),
        )

    for text, font, bbox, x in runs:
        # 让文本垂直中心落在 target_cy：绘制 y = target_cy - 文本中心
        cy = (bbox[1] + bbox[3]) / 2
        draw_y = y + target_cy - cy
        paint_text(img, (x, draw_y), text, font=font, fill=INK)


def _fit_wrapped_text(draw, text: str, preferred_size: int, min_size: int,
                      max_width: int, max_lines: int):
    return fit_wrapped_text(
        draw, text, preferred_size, min_size, max_width, max_lines, _load_font,
    )


def _paste_centered(bg, fg, y):
    fg_w, _ = fg.size
    x = (EPD_WIDTH - fg_w) // 2
    if fg.mode == "1":
        fg = fg.convert("L")
    bg.paste(fg, (x, y))


def _draw_h_line(draw, y, width=104, fill=INK):
    x0 = (EPD_WIDTH - width) // 2
    draw.line([(x0, y), (x0 + width, y)], fill=fill, width=1)


# ============================================================
# 页面渲染 (返回单个 Image)
# ============================================================

def render_help_page() -> Image.Image:
    """说明页: 按键功能说明

    中文: 两行式 K4 (短按=重启 / 长按=关机, 第二行实测宽度缩进对齐)。
    英文: 152px 屏放不下 "Hold=Power off" 缩进, 重构为竖排方括号 + K4 垂直居中
    (2026-08-11): K4 在最左、括号跨两行动作行, 动作行右移。
    """
    if _current_locale not in _VERIFIED_HELP_LOCALES:
        return _render_help_page_compact()

    img = _new_canvas()
    draw = ImageDraw.Draw(img)
    font_body = _load_font(17)

    _draw_help_title(img, draw, 3)

    y = 22
    items = [
        ("K1", _str("help_k1")),
        ("K2", _str("help_k2")),
        ("K3", _str("help_k3")),
    ]
    for key, desc in items:
        _draw_text(img, draw, f"{key}    {desc}", y, font_body, center=False)
        y += 22

    if _current_locale == "en":
        # 英文: 竖排括号 + K4 居中 (已调优布局, 保持不变)
        _render_help_k4_en(img, draw, font_body, y)
    elif _current_locale in ("zh-CN", "zh-TW"):
        # 中文/繁体: K4 垂直居中于两行动作文案之间 (参考英文布局，去掉竖排括号)
        # 两行动作文案右对齐，K4 在最左垂直居中
        _render_help_k4_zh(img, draw, font_body, y)
    else:
        # 其他语言: 两行式。第二行缩进 = 首行正文左缘, 用实测宽度而非空格填充
        # (拉丁语系文案较长可能超宽, 排版后续统一处理)
        _draw_text(
            img, draw, f"K4    {_str('help_k4_short')}", y, font_body,
            center=False,
        )
        indent_x = 4 + _bbox(draw, "K4    ", font_body)[2]
        _draw_text(
            img, draw, _str("help_k4_long"), y + 24, font_body,
            center=False, x=indent_x,
        )

    # 提示行上移留边距: 英文降部(p)比中文低, y=EPD_HEIGHT-18 会贴到底边
    _draw_fitted_text(
        img, draw, _str("help_hint"), EPD_HEIGHT - 21,
        preferred_size=15, min_size=13, fill=INK,
        max_width=EPD_WIDTH - 6,
    )

    return _finalize(img)


def _render_help_k4_en(img, draw, font, y) -> None:
    """英文 K4 组: 单竖排方括号 + K4 垂直居中 (2026-08-11 原版)。

    单个左括号 [ 连接两行动作行，K4 在最左侧垂直居中。
    """
    act_y1, act_y2 = y, y + 24
    bx = 28       # 括号竖线 x (K4 文字右缘之后)
    act_x = 36    # 动作行左缘
    top, bot = act_y1 - 2, act_y2 + 15

    # 单竖线
    draw.line([(bx, top), (bx, bot)], fill=INK, width=1)
    # 顶横线：左右对称延伸
    draw.line([(bx - 2, top), (bx + 2, top)], fill=INK, width=1)
    # 底横线：左右对称延伸
    draw.line([(bx - 2, bot), (bx + 2, bot)], fill=INK, width=1)

    # K4 垂直居中：两行动作文案中心连线的中点，再向上微调 2px
    group_cy = (act_y1 + (act_y2 + 14)) // 2 - 2
    k4_h = _bbox(draw, "K4", font)[3]
    paint_text(img, (4, group_cy - k4_h // 2), "K4", font, fill=INK)

    # 两行动作文案
    paint_text(img, (act_x, act_y1), _str("help_k4_short"), font, fill=INK)
    paint_text(img, (act_x, act_y2), _str("help_k4_long"), font, fill=INK)


def _render_help_k4_zh(img, draw, font, y) -> None:
    """中文/繁体 K4 组: K4 垂直居中于两行动作文案之间（无括号）。

    关键：让 K1-K3 与 K4 两行动作文案的首字（扫/聊/W/短/长）垂直对齐。
    """
    act_y1, act_y2 = y, y + 24
    k4_x = 4

    # 测量 "K1    " 宽度（K1-K3 统一格式），作为描述文案起始 x
    key_prefix = "K1    "
    prefix_bbox = _bbox(draw, key_prefix, font)
    act_x = k4_x + (prefix_bbox[2] - prefix_bbox[0])

    # K4 垂直居中：两行动作文案中心连线的中点，向上微调 2px
    k4_bbox = _bbox(draw, "K4", font)
    k4_h = k4_bbox[3] - k4_bbox[1]
    group_cy = (act_y1 + (act_y2 + 14)) // 2 - 2
    paint_text(img, (k4_x, group_cy - k4_h // 2), "K4", font, fill=INK)

    # 两行动作文案，首字与 K1-K3 对齐
    paint_text(img, (act_x, act_y1), _str("help_k4_short"), font, fill=INK)
    paint_text(img, (act_x, act_y2), _str("help_k4_long"), font, fill=INK)


def render_page_lan_qr(url: str, hostname: str = "", ip: str = "") -> Image.Image:
    """页面1: 局域网访问二维码"""
    img = _new_canvas()
    draw = ImageDraw.Draw(img)

    qr_size = 100
    # QR 码居中，往上放
    qr_y = (EPD_HEIGHT - qr_size - 30) // 2
    qr_img = generate_qr(url, size=qr_size, box_size=QR_BOX_SIZE, border=QR_BORDER)
    if qr_img:
        _paste_centered(img, qr_img, qr_y)

    _draw_fitted_text(
        img, draw, _str("lan_qr"), qr_y + qr_size + 4,
        preferred_size=18, min_size=12,
    )

    return _finalize(img)


def render_page_chat_qr(qr_url: str = "", chat_name: str = "微信",
                        qr_type: str = "url") -> Image.Image:
    """页面2: 聊天渠道二维码

    qr_type:
      "url"   → qr_url 为可编码字符串, 用 qrcode 库生成二维码 (微信/飞书/QQ)
      "image" → qr_url 为 data:image/png;base64 图片, 解码直显 (WhatsApp)
    """
    img = _new_canvas()
    draw = ImageDraw.Draw(img)

    qr_img = None
    if qr_url:
        if qr_type == "image":
            # 图片直显: 小图保持原始像素; 高密度大图(网页端438px)先解码再原生重绘
            # 为完美网格。缩放会破坏模块网格, 手机无法识别 (WhatsApp v12 65模块实测)
            qr_img = qr_image_fit_for_screen(qr_url)
        else:
            qr_img = generate_qr(qr_url, size=QR_SIZE, box_size=QR_BOX_SIZE, border=QR_BORDER)
    if qr_img is None:
        y0 = 34
        box_h = 90
        draw.rounded_rectangle((14, y0, EPD_WIDTH - 14, y0 + box_h), radius=6, outline=INK, width=1)
        # 框体内宽 124px，再留 6px 内边距；不能按整屏宽度计算，否则长文案
        # 虽未越出屏幕，却会压在框线上（法语实机字体曾复现）。
        box_text_width = EPD_WIDTH - 40
        _draw_fitted_text(
            img, draw, _str("waiting_title"), y0 + 14, 16, 12,
            max_width=box_text_width,
        )
        _draw_fitted_text(
            img, draw, _str("waiting_line2"), y0 + 39, 14, 12,
            max_width=box_text_width,
        )
        _draw_fitted_text(
            img, draw, _str("waiting_line3"), y0 + 61, 14, 12,
            max_width=box_text_width,
        )
        return _finalize(img)

    _, qr_h = qr_img.size
    # 常规尺寸(≤124px): 顶部平台标题 + y=26 起放置; 超高密度码(138px)放不下标题
    # 时, 去掉标题、垂直居中, 把屏幕留给二维码本身
    if 26 + qr_h <= EPD_HEIGHT:
        _draw_fitted_text(img, draw, chat_name, 4, 18, 12)
        _paste_centered(img, qr_img, 26)
    else:
        qr_y = (EPD_HEIGHT - qr_h) // 2
        _paste_centered(img, qr_img, qr_y)

    return _finalize(img)


def render_page_qr_expired(chat_name: str = "WhatsApp") -> Image.Image:
    """页面4: 二维码过期提示 —— WhatsApp 图片型二维码超过有效时长自动切换。

    墨水屏静态快照无法跟随 Baileys 每 ~20s 的码轮换, 码过期后手机扫描会被
    服务器拒绝("无法关联设备"); 与其让用户对着一块死码, 不如明确提示重新获取。
    平台名单独小字一行(拼进标题"WhatsApp 二维码已失效"太长会在 152px 屏截断),
    标题固定 (语言化后英文为 "QR expired") (2026-08-07 用户反馈修正)。
    """
    img = _new_canvas()
    draw = ImageDraw.Draw(img)

    _draw_fitted_text(img, draw, chat_name, 26, 14, 12)
    _draw_fitted_text(img, draw, _str("qr_expired_title"), 46, 20, 13)
    _draw_h_line(draw, 74, width=120)
    _draw_fitted_text(img, draw, _str("qr_expired_line2"), 88, 16, 12)
    _draw_fitted_text(img, draw, _str("qr_expired_line3"), 112, 16, 12)

    return _finalize(img)


def render_page_wifi_disconnect(ssid: str = "", ip: str = "", mode: str = "") -> Image.Image:
    """页面3: WiFi 状态"""
    img = _new_canvas()
    draw = ImageDraw.Draw(img)

    _draw_fitted_text(img, draw, _str("wifi_status"), 6, 20, 13)
    _draw_h_line(draw, 32, width=120)

    # 状态
    if mode == "ap":
        status = _str("hotspot")
        detail = _str("waiting_phone")
    elif ssid:
        status = _str("connected")
        detail = ""
    else:
        status = _str("unknown")
        detail = _str("check_network")

    _draw_fitted_text(img, draw, status, 42, 18, 12, center=False)

    # SSID 是最长且最重要的动态文字：先在 17→14px 间寻找两行排版，禁止为
    # 追求单行而缩到难看的 11px。两行仍放不下时才在第二行省略。
    y = 68
    if ssid:
        ssid_font, ssid_lines, _ = _fit_wrapped_text(
            draw, ssid, preferred_size=17, min_size=14,
            max_width=EPD_WIDTH - 8, max_lines=2,
        )
        y = paint_lines(
            img, draw, ssid_lines, ssid_font, y,
            center=False, line_gap=3,
            right_align=_current_locale in _RTL_LOCALES,
        ) + 2
    if ip:
        y = _draw_fitted_text(
            img, draw, ip, y, 16, 14, center=False,
        ) + 3
    if detail:
        _draw_fitted_text(img, draw, detail, y, 14, 12, center=False)

    return _finalize(img)


def render_page_disconnecting() -> Image.Image:
    img = _new_canvas()
    draw = ImageDraw.Draw(img)
    _draw_fitted_text(img, draw, _str("please_wait"), 42, 16, 12)
    _draw_fitted_text(img, draw, _str("disconnecting"), 70, 14, 12)
    _draw_fitted_text(img, draw, _str("restart_hotspot"), 94, 14, 12)
    return _finalize(img)


def _render_help_page_compact() -> Image.Image:
    """十种未实屏调优语言的说明页：五行等高列表，不截动作语义。

    K4 重复两行是刻意设计：每行自身包含“短按/长按”的本地化动作词，用户不
    需要理解括号或图标。键名固定窄列，说明列按真实字体在 16→12px 间自适应。
    """
    img = _new_canvas()
    draw = ImageDraw.Draw(img)
    key_font = _load_font(14, text="K4")
    rows = (
        ("K1", "help_k1"),
        ("K2", "help_k2"),
        ("K3", "help_k3"),
        ("K4", "help_k4_short"),
        ("K4", "help_k4_long"),
    )
    rtl = _current_locale in _RTL_LOCALES
    value_x = 30
    value_width = EPD_WIDTH - value_x - 4
    _draw_help_title(img, draw, 3)

    for y, (key, string_key) in zip((20, 41, 62, 83, 104), rows):
        if rtl:
            key_bbox = _bbox(draw, key, key_font)
            key_width = key_bbox[2] - key_bbox[0]
            key_x = EPD_WIDTH - 4 - key_width
            paint_text(img, (key_x, y), key, font=key_font, fill=INK)
            value_right = key_x - 5
            value_width = value_right - 4
            font, fitted = _fit_font_to_width(
                draw, _str(string_key), preferred_size=15,
                min_size=12, max_width=value_width,
            )
            fitted_bbox = _bbox(draw, fitted, font)
            fitted_width = fitted_bbox[2] - fitted_bbox[0]
            paint_text(
                img, (value_right - fitted_width, y), fitted,
                font=font, fill=INK,
            )
        else:
            paint_text(img, (4, y), key, font=key_font, fill=INK)
            _draw_fitted_text(
                img, draw, _str(string_key), y,
                preferred_size=15, min_size=12,
                center=False, x=value_x, max_width=value_width,
            )

    _draw_h_line(draw, 126, width=144)
    _draw_fitted_text(
        img, draw, _str("help_hint"), 130, preferred_size=14, min_size=13,
        fill=INK, max_width=EPD_WIDTH - 6,
    )
    return _finalize(img)


def render_boot_screen(version: str = "1.0") -> Image.Image:
    img = _new_canvas()
    draw = ImageDraw.Draw(img)
    _draw_text(img, draw, "ClawBox", 34, _load_font(24, text="ClawBox"))
    _draw_fitted_text(img, draw, _str("boot_subtitle"), 64, 14, 12)

    bar_x0, bar_y = 28, 90
    bar_w, bar_h = 96, 6
    draw.rectangle((bar_x0, bar_y, bar_x0 + bar_w, bar_y + bar_h), outline=INK, width=1)
    draw.rectangle((bar_x0 + 2, bar_y + 1, bar_x0 + bar_w - 2, bar_y + bar_h - 1), fill=INK)

    _draw_fitted_text(img, draw, _str("booting"), 104, 14, 12)
    _draw_text(
        img, draw, version, EPD_HEIGHT - 17,
        _load_font(12, text=version),
    )
    return _finalize(img)


def render_error_screen(title: str = "", message: str = "") -> Image.Image:
    """错误页; title 留空时用当前语言的默认标题。"""
    img = _new_canvas()
    draw = ImageDraw.Draw(img)
    _draw_fitted_text(img, draw, title or _str("error_title"), 42, 16, 12)
    if message:
        text = " ".join(message.splitlines())
        font, lines, _ = _fit_wrapped_text(
            draw, text, preferred_size=14, min_size=12,
            max_width=EPD_WIDTH - 8, max_lines=4,
        )
        paint_lines(img, draw, lines, font, 68, line_gap=4)
    return _finalize(img)
