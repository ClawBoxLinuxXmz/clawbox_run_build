"""font_bitmap 取模位图渲染单测。

覆盖: 位图适用性判定 / 单字符取模 / 整行绘制 / 缺字回退 / 缓存清理。
"""

import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "clawbox-peripheral"))

import font_bitmap
from font_bitmap import (
    bitmap_supported,
    clear_cache,
    paint_bitmap_text,
)
from screen_fonts import load_font


@pytest.fixture(autouse=True)
def _clean_cache():
    clear_cache()
    yield
    clear_cache()


def _font(size: int = 16):
    return load_font(size, "zh-CN", "测试")


class TestBitmapSupported:
    def test_cjk_supported(self):
        assert bitmap_supported("zh-CN", "按键") is True

    def test_ascii_supported(self):
        assert bitmap_supported("zh-CN", "ClawBox 123") is True

    def test_arabic_not_supported(self):
        assert bitmap_supported("ar", "مرحبا") is False

    def test_thai_not_supported(self):
        assert bitmap_supported("th", "สวัสดี") is False

    def test_devanagari_not_supported(self):
        assert bitmap_supported("hi", "नमस्ते") is False


class TestGlyph:
    def test_glyph_bitmap_shape(self):
        font = _font(16)
        glyph = font_bitmap._glyph(font, "测")
        assert glyph is not None
        bitmap, advance = glyph
        assert bitmap is not None
        assert bitmap.mode == "1"
        assert bitmap.width <= 16 and bitmap.height <= 16
        assert advance > 0

    def test_glyph_cache_hit(self):
        font = _font(16)
        g1 = font_bitmap._glyph(font, "试")
        g2 = font_bitmap._glyph(font, "试")
        assert g1 is g2  # 缓存命中同一对象

    def test_glyph_blank_char(self):
        font = _font(16)
        glyph = font_bitmap._glyph(font, " ")
        assert glyph is not None
        # 空格: 位图存在但无黑像素 (抗锯齿残留可能产生全白位图, 画上去无影响)
        assert glyph[0].histogram()[0] == 0


class TestPaintBitmapText:
    def test_paint_draws_black_pixels(self):
        img = Image.new("1", (152, 152), 1)
        font = _font(16)
        ok = paint_bitmap_text(img, (4, 4), "按键", font)
        assert ok is True
        # 位图绘制后应有黑像素
        assert img.histogram()[0] > 0

    def test_paint_advance_layout(self):
        """字符 x 位置按矢量 advance 累加, 与测宽一致。"""
        img = Image.new("1", (152, 152), 1)
        font = _font(16)
        paint_bitmap_text(img, (4, 4), "按键", font)
        # 第二个字符应画在第一个字符右侧 (advance 累加)
        # 直接验证: 两字都画出来, 黑像素数 > 单字
        single = Image.new("1", (152, 152), 1)
        paint_bitmap_text(single, (4, 4), "按", font)
        assert img.histogram()[0] > single.histogram()[0]

    def test_paint_missing_glyph_returns_false(self):
        """字体加载失败/异常时返回 False, 调用方回退矢量。

        注意: PIL 对缺字画 notdef 框 (豆腐块), 与矢量路径行为一致,
        因此生僻字本身不会触发回退; 回退只用于渲染异常场景。
        """
        img = Image.new("1", (152, 152), 1)
        # 用一个非法字体对象触发异常路径
        ok = paint_bitmap_text(img, (4, 4), "测", None)
        assert ok is False

    def test_paint_empty_text(self):
        img = Image.new("1", (152, 152), 1)
        font = _font(16)
        assert paint_bitmap_text(img, (4, 4), "", font) is True

    def test_paint_l_mode_image(self):
        """L 模式画布也能绘制 (页面渲染主路径)。"""
        img = Image.new("L", (152, 152), 255)
        font = _font(16)
        ok = paint_bitmap_text(img, (4, 4), "测试", font)
        assert ok is True
        assert img.histogram()[0] > 0  # 有黑像素


class TestClearCache:
    def test_clear_resets(self):
        font = _font(16)
        font_bitmap._glyph(font, "清")
        assert font_bitmap._glyph_cache
        clear_cache()
        assert not font_bitmap._glyph_cache