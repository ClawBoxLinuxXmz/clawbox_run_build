# -*- coding: utf-8 -*-
"""设备端：渲染页面2 效果图（微信二维码页 + 新平台名）。"""
import sys
sys.path.insert(0, "/home/clawbox/clawbox-deploy/clawbox-peripheral")

from screen_pages import set_locale, render_page_chat_qr, render_page_qr_expired

# 微信二维码页 (zh-CN)
set_locale("zh-CN")
img = render_page_chat_qr(
    qr_url="https://liteapp.weixin.qq.com/test", chat_name="微信", qr_type="url",
)
img.save("/tmp/page2_wechat.png")
print("saved page2_wechat", img.size)

# 新平台: Signal 二维码页
img2 = render_page_chat_qr(
    qr_url="sgnl://linkdevice?test=1", chat_name="Signal", qr_type="url",
)
img2.save("/tmp/page2_signal.png")
print("saved page2_signal", img2.size)

# 新平台: Zalo 个人
img3 = render_page_chat_qr(
    qr_url="https://zalo.me/test", chat_name="Zalo 个人", qr_type="url",
)
img3.save("/tmp/page2_zalouser.png")
print("saved page2_zalouser", img3.size)

# 二维码过期页 (Signal)
img4 = render_page_qr_expired(chat_name="Signal")
img4.save("/tmp/page2_signal_expired.png")
print("saved page2_signal_expired", img4.size)