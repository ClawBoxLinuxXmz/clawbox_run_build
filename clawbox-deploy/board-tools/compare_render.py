# -*- coding: utf-8 -*-
"""设备端对比脚本：矢量渲染 vs 取模位图渲染 同一页面。"""
import sys
sys.path.insert(0, "/home/clawbox/clawbox-deploy/clawbox-peripheral")

from PIL import Image, ImageDraw

# 旧路径: 直接调用 screen_text 的矢量绘制 (绕过位图)
import screen_text
from screen_fonts import load_font
from screen_pages import _new_canvas, _finalize, _str, _current_locale, _bbox

# 新路径: 走 paint_text (内部自动选位图)
from screen_pages import render_help_page, render_page_chat_qr, render_page_wifi_disconnect

# 1. 帮助页对比
img_new = render_help_page()

# 旧路径: 手动重绘帮助页 (禁用位图)
import font_bitmap
font_bitmap._glyph_cache.clear()
orig_paint = screen_text.paint_text

def vector_only(image, xy, text, font, fill=0):
    """强制走矢量路径 (临时禁用位图)。"""
    size = int(getattr(font, "size", 0) or 0)
    layer = Image.new("L", (image.width * 8, image.height * 8), 255)
    d = ImageDraw.Draw(layer)
    scaled = font.font_variant(size=size * 8)
    d.text((int(xy[0]) * 8, int(xy[1]) * 8), text, font=scaled, fill=fill,
           stroke_width=1 if size <= 13 else 0, stroke_fill=fill)
    layer = layer.resize(image.size, Image.Resampling.BOX)
    image.paste(ImageChops.darker(image, layer))

from PIL import ImageChops
screen_text.paint_text = vector_only
img_old = render_help_page()
screen_text.paint_text = orig_paint

# 拼接: 上=旧(矢量) 下=新(位图)
combined = Image.new("1", (152, 152 * 2), 1)
combined.paste(img_old, (0, 0))
combined.paste(img_new, (0, 152))
combined = combined.resize((152 * 3, 152 * 6), Image.Resampling.NEAREST)
combined.save("/tmp/compare_help.png")
print("saved /tmp/compare_help.png")

# 2. 聊天二维码页对比
img_new2 = render_page_chat_qr(qr_url="https://example.com/chat", chat_name="微信", qr_type="url")
screen_text.paint_text = vector_only
img_old2 = render_page_chat_qr(qr_url="https://example.com/chat", chat_name="微信", qr_type="url")
screen_text.paint_text = orig_paint
combined2 = Image.new("1", (152, 152 * 2), 1)
combined2.paste(img_old2, (0, 0))
combined2.paste(img_new2, (0, 152))
combined2 = combined2.resize((152 * 3, 152 * 6), Image.Resampling.NEAREST)
combined2.save("/tmp/compare_chat.png")
print("saved /tmp/compare_chat.png")