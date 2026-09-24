# -*- coding: utf-8 -*-
"""设备端临时脚本：渲染当前各页面为 PNG，供拉回 PC 检查效果。"""
import sys
sys.path.insert(0, "/home/clawbox/clawbox-deploy/clawbox-peripheral")

from screen_pages import (
    render_help_page,
    render_page_lan_qr,
    render_page_chat_qr,
    render_page_wifi_disconnect,
    render_page_qr_expired,
)

pages = {
    "help_zh": render_help_page(),
    "lan_qr": render_page_lan_qr("http://192.168.1.225/setup", hostname="clawbox", ip="192.168.1.225"),
    "chat_qr": render_page_chat_qr(qr_url="https://example.com/chat", chat_name="微信", qr_type="url"),
    "wifi_disconnect": render_page_wifi_disconnect(ssid="野比大熊文艺工作室_5G", ip="", mode=""),
    "qr_expired": render_page_qr_expired(chat_name="微信"),
}

for name, img in pages.items():
    path = f"/tmp/{name}.png"
    img.save(path)
    print(name, img.size, path)