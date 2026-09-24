"""
ClawBox 外设守护进程 —— 屏幕页面图像生成
==========================================
主线程调用: 根据当前缓存状态生成各页面 PIL Image。
纯图像生成, 不做 SPI 传输 (SPI 由 screen_worker.ScreenWorker 负责)。
"""

import logging
from typing import Any, Optional

from config import (
    CHAT_PLATFORM_NAMES,
    DEFAULT_SCREEN_LOCALE,
    MDNS_DOMAIN,
    PAGE_QR_EXPIRED,
)
from daemon_state import DaemonState
from net_utils import get_local_hostname, get_local_ip
from screen_pages import (
    render_error_screen,
    render_help_page,
    render_page_chat_qr,
    render_page_lan_qr,
    render_page_qr_expired,
    render_page_wifi_disconnect,
)

logger = logging.getLogger("clawbox.pages")


def chat_platform_name(state: DaemonState, platform: str) -> str:
    """平台标识 → 当前语言下的显示名 (未知平台原样返回)。"""
    locale = state.cached.get("locale", DEFAULT_SCREEN_LOCALE)
    names = CHAT_PLATFORM_NAMES.get(locale) or CHAT_PLATFORM_NAMES.get("en", {})
    return names.get(platform, platform)


def render_page_image(state: DaemonState, page: int) -> Optional[Any]:
    """根据当前页面生成 PIL Image（只在主线程调用，不做 SPI 传输）。"""
    try:
        if page == 0:
            return render_help_page()

        elif page == 1:
            ip = state.cached.get("wifi_ip", "") or get_local_ip()
            hostname = state.cached.get("hostname", "") or get_local_hostname()
            mdns = f"{hostname}.{MDNS_DOMAIN}" if hostname else ""

            if ip:
                url = f"http://{ip}/setup"
            else:
                url = state.cached.get("access_url", "")
                if not url:
                    if mdns:
                        url = f"http://{mdns}/setup"
                    else:
                        url = f"http://{hostname}.{MDNS_DOMAIN}/setup" if hostname else "http://clawbox.local/setup"

            return render_page_lan_qr(url, hostname=hostname, ip=ip)

        elif page == 2:
            qr_url = state.cached.get("chat_qr_url", "")
            # 平台名: 触发文件 platform 字段 → 当前语言下的显示名 (未知平台原样显示)
            platform = state.cached.get("chat_qr_platform", "wechat")
            chat_name = chat_platform_name(state, platform)
            # 二维码类型: url(编码字符串) / image(WhatsApp 图片直显)
            qr_type = state.cached.get("chat_qr_type", "url")
            return render_page_chat_qr(
                qr_url=qr_url, chat_name=chat_name, qr_type=qr_type,
            )

        elif page == 3:
            ssid = state.cached.get("wifi_ssid", "")
            ip = state.cached.get("wifi_ip", "")
            mode = state.cached.get("wifi_mode", "")
            return render_page_wifi_disconnect(ssid=ssid, ip=ip, mode=mode)

        elif page == PAGE_QR_EXPIRED:
            # 二维码过期提示页: 平台名小字一行(WhatsApp), 标题"二维码已过期"
            platform = state.cached.get("chat_qr_platform", "wechat")
            chat_name = chat_platform_name(state, platform)
            return render_page_qr_expired(chat_name=chat_name)

        else:
            return None

    except Exception as e:
        logger.error(f"生成页面 {page} 图像失败: {e}")
        return render_error_screen(message=str(e)[:80])
