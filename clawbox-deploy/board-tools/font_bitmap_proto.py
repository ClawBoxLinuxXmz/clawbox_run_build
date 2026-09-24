# -*- coding: utf-8 -*-
"""取模字库原型：对比 当前矢量渲染 vs 取模位图渲染 的效果。

取模算法模拟 PCtoLCD2002：矢量字体 → 超采样渲染 → 阈值 → 1-bit 位图。
关键参数：字体、字号、阈值、增重策略。
"""
from PIL import Image, ImageDraw, ImageFont, ImageChops

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",      # 微软雅黑
    r"C:\Windows\Fonts\msyhbd.ttc",    # 微软雅黑粗体
    r"C:\Windows\Fonts\simhei.ttf",    # 黑体
    r"C:\Windows\Fonts\simsun.ttc",    # 宋体
    r"C:\Windows\Fonts\Deng.ttf",      # 等线
]

SUPERSAMPLE = 8
THRESHOLD = 170


def render_vector(text, font_path, size, threshold=THRESHOLD, bold_stroke=False):
    """当前守护进程的矢量渲染路径（8x 超采样 + 降采样 + 阈值）。"""
    font = ImageFont.truetype(font_path, size)
    scaled = font.font_variant(size=size * SUPERSAMPLE)
    layer = Image.new("L", (152 * SUPERSAMPLE, 152 * SUPERSAMPLE), 255)
    d = ImageDraw.Draw(layer)
    d.text((4 * SUPERSAMPLE, 4 * SUPERSAMPLE), text, font=scaled, fill=0,
           stroke_width=1 if bold_stroke else 0, stroke_fill=0)
    layer = layer.resize((152, 152), Image.Resampling.BOX)
    return layer.point(lambda p: 0 if p < threshold else 255)


def render_bitmap(text, font_path, size, threshold=THRESHOLD, bold_stroke=False):
    """取模位图渲染：先取模（超采样→阈值→1-bit），再按位图画点。

    与矢量渲染的区别：位图是"设计好的字形"，画点时无抗锯齿损失。
    """
    font = ImageFont.truetype(font_path, size)
    scaled = font.font_variant(size=size * SUPERSAMPLE)
    layer = Image.new("L", (size * SUPERSAMPLE, size * SUPERSAMPLE), 255)
    d = ImageDraw.Draw(layer)
    d.text((0, 0), text, font=scaled, fill=0,
           stroke_width=1 if bold_stroke else 0, stroke_fill=0)
    layer = layer.resize((size, size), Image.Resampling.BOX)
    # 1-bit 位图: 每个字符一个 (size, size) 的 0/1 矩阵
    bitmap = layer.point(lambda p: 0 if p < threshold else 255).convert("1")

    # 按位图画点到 152x152 画布（模拟 EPD_ShowChinese 的 Paint_SetPixel）
    canvas = Image.new("1", (152, 152), 1)
    px = canvas.load()
    bpx = bitmap.load()
    for y in range(size):
        for x in range(size):
            if bpx[x, y] == 0:
                px[4 + x, 4 + y] = 0
    return canvas


def make_comparison(text, size, out_path):
    """生成对比图：上=矢量渲染，下=取模位图渲染，各字体一列。"""
    cols = []
    for font_path in FONT_CANDIDATES:
        try:
            vec = render_vector(text, font_path, size)
            bmp = render_bitmap(text, font_path, size)
            # 拼成上下两半
            combined = Image.new("1", (152, 152 * 2), 1)
            combined.paste(vec, (0, 0))
            combined.paste(bmp, (0, 152))
            cols.append(combined)
        except Exception as e:
            print(f"skip {font_path}: {e}")
    # 横向拼接
    width = 152 * len(cols)
    result = Image.new("1", (width, 152 * 2), 1)
    for i, col in enumerate(cols):
        result.paste(col, (i * 152, 0))
    result = result.resize((width * 2, 152 * 4), Image.Resampling.NEAREST)
    result.save(out_path)
    print("saved:", out_path, "cols:", len(cols))


if __name__ == "__main__":
    make_comparison("按键 K1-K4", 16, r"C:\Users\wenbo\Desktop\核桃派\clawbox-deploy\board-tools\screen_preview\proto_help_title.png")
    make_comparison("聊天渠道", 16, r"C:\Users\wenbo\Desktop\核桃派\clawbox-deploy\board-tools\screen_preview\proto_chat.png")
    make_comparison("二维码已过期", 20, r"C:\Users\wenbo\Desktop\核桃派\clawbox-deploy\board-tools\screen_preview\proto_expired.png")