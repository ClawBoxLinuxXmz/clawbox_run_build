"""screen_pages.py —— 语言映射 + 排版逻辑单测。

注意: 本机无 Linux 字体路径, _load_font 会回退默认字体 —— 测宽/冒烟测试
验证"不越界、不崩溃"; 真实字形排版验收工具已归档到
archive/2026-08-12_clawbox-deploy工具归档/板上测试工具/screen_layout_test.py。
"""

import pytest
from PIL import Image, ImageDraw, ImageFont

import screen_pages as pages
from screen_fonts import (
    ARABIC_FONT_PATHS,
    CHINESE_FONT_PATHS,
    DEVANAGARI_FONT_PATHS,
    KOREAN_FONT_PATHS,
    LATIN_FONT_PATHS,
    THAI_FONT_PATHS,
)
from screen_text import dir_kwargs, paint_text


# ---- resolve_screen_locale ----

def test_resolve_zh_cn_variants():
    for code in ("zh", "zh-cn", "zh-CN", "zh-sg", "zh-SG", "zh-my", "zh-hans"):
        assert pages.resolve_screen_locale(code) == "zh-CN"


def test_resolve_zh_tw_variants():
    for code in ("zh-tw", "zh-TW", "zh-hk", "zh-HK", "zh-mo", "zh-hant"):
        assert pages.resolve_screen_locale(code) == "zh-TW"


def test_resolve_unknown_zh_falls_back_cn():
    assert pages.resolve_screen_locale("zh-XX") == "zh-CN"


def test_resolve_language_match():
    assert pages.resolve_screen_locale("ko") == "ko"
    assert pages.resolve_screen_locale("ko-KR") == "ko"
    assert pages.resolve_screen_locale("ja") == "ja"
    assert pages.resolve_screen_locale("ru") == "ru"
    assert pages.resolve_screen_locale("es-ES") == "es"


def test_resolve_new_languages():
    # 8.12 新增 7 种语言与前端 i18n.config.ts 对齐
    for code in ("hi", "ar", "tr", "uk", "id", "fa", "th"):
        assert pages.resolve_screen_locale(code) == code
        assert pages.resolve_screen_locale(code.upper()) == code


def test_resolve_pt_br_maps_to_pt():
    # 前端语言为 pt-BR, 屏幕端以 pt 承担 (主语言映射)
    assert pages.resolve_screen_locale("pt-BR") == "pt"
    assert pages.resolve_screen_locale("pt") == "pt"


def test_resolve_unknown_falls_back_en():
    assert pages.resolve_screen_locale("xx") == "en"
    assert pages.resolve_screen_locale("fr-FR") == "fr"


def test_resolve_empty_or_none():
    assert pages.resolve_screen_locale("") == "zh-CN"
    assert pages.resolve_screen_locale(None) == "zh-CN"


# ---- set_locale / get_locale / _str ----

def test_set_and_get_locale():
    pages.set_locale("en")
    assert pages.get_locale() == "en"
    pages.set_locale("zh-CN")
    assert pages.get_locale() == "zh-CN"


def test_str_known_and_fallback():
    pages.set_locale("zh-CN")
    assert pages._str("lan_qr") == "扫码进入网页"
    assert pages._str("nonexistent_key") == "nonexistent_key"


def test_str_en():
    pages.set_locale("en")
    assert pages._str("lan_qr") == "Scan to open"


# ---- 动态文字字体选择 ----

@pytest.mark.parametrize("locale", ["es", "ru", "fr", "vi"])
def test_cjk_ssid_uses_cjk_font_in_non_cjk_locale(locale):
    pages.set_locale(locale)
    paths = pages._font_paths_for_text("核桃派-WiFi")
    assert paths[0] == CHINESE_FONT_PATHS[0]
    assert paths[0] not in LATIN_FONT_PATHS


def test_cjk_font_priority_prefers_microhei_for_low_resolution_screen():
    assert CHINESE_FONT_PATHS[0].endswith("wqy-microhei.ttc")


def test_finalize_keeps_small_text_strokes_solid():
    canvas = Image.new("L", (32, 1), 255)
    for x in range(8, 24):
        canvas.putpixel((x, 0), 128)
    result = pages._finalize(canvas)
    assert result.mode == "1"
    # No Floyd–Steinberg holes in a small, uniform stroke.
    assert [result.getpixel((x, 0)) for x in range(8, 24)] == [0] * 16


def test_foreign_ssid_uses_dejavu_in_chinese_locale():
    pages.set_locale("zh-CN")
    assert pages._font_paths_for_text("Русский")[0] == LATIN_FONT_PATHS[0]
    assert pages._font_paths_for_text("Español")[0] == LATIN_FONT_PATHS[0]


def test_mixed_cjk_cyrillic_ssid_prefers_noto_cjk():
    pages.set_locale("ru")
    assert pages._font_paths_for_text("核桃派-Русский")[0] == KOREAN_FONT_PATHS[0]


# ---- _fit_font_to_width ----

def test_fit_font_to_width_respects_max_width():
    canvas = Image.new("L", (152, 152), 255)
    draw = ImageDraw.Draw(canvas)
    text = "这是一段非常长的文案" * 5
    font, fitted = pages._fit_font_to_width(
        draw, text, preferred_size=18, min_size=11, max_width=146,
    )
    width = draw.textbbox((0, 0), fitted, font=font)[2]
    assert width <= 146


def test_short_ssid_stays_single_line_at_17px():
    canvas = Image.new("L", (152, 152), 255)
    draw = ImageDraw.Draw(canvas)
    font, lines, truncated = pages._fit_wrapped_text(
        draw, "Home-WiFi", preferred_size=17, min_size=14,
        max_width=144, max_lines=2,
    )
    assert lines == ["Home-WiFi"]
    assert font.size == 17
    assert not truncated


def test_long_ssid_wraps_instead_of_shrinking_to_11px():
    canvas = Image.new("L", (152, 152), 255)
    draw = ImageDraw.Draw(canvas)
    font, lines, truncated = pages._fit_wrapped_text(
        draw, "ClawBox-Office-LivingRoom", preferred_size=17, min_size=14,
        max_width=144, max_lines=2,
    )
    assert len(lines) == 2
    assert font.size >= 14
    assert not truncated
    assert all(draw.textbbox((0, 0), line, font=font)[2] <= 144 for line in lines)


def test_extreme_ssid_ellipsizes_only_after_two_lines():
    canvas = Image.new("L", (152, 152), 255)
    draw = ImageDraw.Draw(canvas)
    font, lines, truncated = pages._fit_wrapped_text(
        draw, "W" * 80, preferred_size=17, min_size=14,
        max_width=144, max_lines=2,
    )
    assert len(lines) == 2
    assert font.size == 14
    assert truncated
    assert lines[-1].endswith("...")


def test_small_text_micro_bold_preserves_more_black_pixels():
    font = ImageFont.load_default(size=12)
    normal = Image.new("L", (152, 40), 255)
    ImageDraw.Draw(normal).text((4, 4), "ClawBox 123", font=font, fill=0)
    enhanced = Image.new("L", (152, 40), 255)
    paint_text(enhanced, (4, 4), "ClawBox 123", font=font, fill=0)

    normal_bw = normal.point(lambda p: 0 if p < 170 else 255)
    enhanced_bw = enhanced.point(lambda p: 0 if p < 170 else 255)
    normal_black = normal_bw.histogram()[0]
    enhanced_black = enhanced_bw.histogram()[0]
    assert enhanced_black > normal_black


def test_14px_text_uses_supersampled_rendering():
    font = ImageFont.load_default(size=14)
    normal = Image.new("L", (152, 40), 255)
    ImageDraw.Draw(normal).text((4, 4), "ClawBox", font=font, fill=0)
    enhanced = Image.new("L", (152, 40), 255)
    paint_text(enhanced, (4, 4), "ClawBox", font=font, fill=0)
    assert enhanced.tobytes() != normal.tobytes()
    assert enhanced.getbbox() is not None


# ---- 页面渲染冒烟测试 (不越界/不崩溃) ----

@pytest.mark.parametrize("locale", [
    "zh-CN", "zh-TW", "en", "ko", "ru", "ja",
    "hi", "ar", "fa", "th", "tr", "uk", "id",
])
def test_render_pages_smoke(locale):
    pages.set_locale(locale)
    imgs = [
        pages.render_help_page(),
        pages.render_page_lan_qr("http://192.168.1.5/setup"),
        pages.render_page_chat_qr(),                                   # 无码: 等待框
        pages.render_page_chat_qr(qr_url="http://x.com/q"),            # url 码
        pages.render_page_wifi_disconnect(mode="ap"),
        pages.render_page_wifi_disconnect(ssid="核桃派-Español", ip="1.2.3.4", mode="client"),
        pages.render_boot_screen(),
        pages.render_error_screen("出错", "test"),
        pages.render_page_qr_expired("WhatsApp"),
        pages.render_page_disconnecting(),
    ]
    for img in imgs:
        assert img.size == (152, 152)


# ---- 21 种语言: 文案键完整 + 脚本字体 + RTL - 方向 ----

def test_all_supported_locales_have_full_string_keys():
    base = set(pages.STRINGS["en"])
    assert len(base) == 26
    for locale in pages.SUPPORTED_LOCALES:
        assert set(pages.STRINGS[locale]) == base, locale


def test_help_title_keeps_hardware_keys_out_of_localized_font_run():
    for locale in pages.SUPPORTED_LOCALES:
        label = pages.STRINGS[locale]["help_buttons"]
        assert label
        assert "K1-K4" not in label, locale


@pytest.mark.parametrize("locale,font_paths", [
    ("ar", ARABIC_FONT_PATHS),
    ("fa", ARABIC_FONT_PATHS),
    ("th", THAI_FONT_PATHS),
    ("hi", DEVANAGARI_FONT_PATHS),
])
def test_script_locale_uses_script_font(locale, font_paths):
    pages.set_locale(locale)
    # 空文本走界面 locale 分支 (不依赖动态字符集检测)
    assert pages._font_paths_for_text("")[0] == font_paths[0]


def test_arabic_text_uses_arabic_font_in_any_locale():
    pages.set_locale("en")
    assert pages._font_paths_for_text("شبكة-WiFi")[0] == ARABIC_FONT_PATHS[0]


def test_thai_text_uses_thai_font_in_any_locale():
    pages.set_locale("en")
    assert pages._font_paths_for_text("ไวไฟ-บ้าน")[0] == THAI_FONT_PATHS[0]


@pytest.mark.parametrize("locale", ["hi", "ar", "fa", "th"])
@pytest.mark.parametrize("text", ["ClawBox", "K1", "192.168.1.5", "1.0"])
def test_ascii_text_uses_latin_font_in_single_script_locale(locale, text):
    pages.set_locale(locale)
    assert pages._font_paths_for_text(text)[0] == LATIN_FONT_PATHS[0]


def test_rtl_locales_switch_text_direction():
    import screen_text
    pages.set_locale("ar")
    assert screen_text._rtl is True
    pages.set_locale("fa")
    assert screen_text._rtl is True
    pages.set_locale("en")
    assert screen_text._rtl is False


def test_direction_follows_text_script_when_raqm_is_available(monkeypatch):
    import screen_text
    monkeypatch.setattr(screen_text, "_raqm", True)
    pages.set_locale("ar")
    assert dir_kwargs("ClawBox-WiFi") == {}
    assert dir_kwargs("شبكة") == {"direction": "rtl"}

    pages.set_locale("en")
    assert dir_kwargs("شبكة") == {"direction": "rtl"}
