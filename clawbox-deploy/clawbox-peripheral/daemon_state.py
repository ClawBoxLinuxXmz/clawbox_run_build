"""
ClawBox 外设守护进程 —— 共享运行时状态
========================================
把 peripheral_daemon.py 旧版的 _g_* 全局变量收敛为单一对象, 让主循环与
后台线程通过显式对象交互, 而不是靠模块级 global。

约定:
  - 外设句柄 (led/fan/keys/obtn/api): 容忍失败, None = 不可用
  - cached: 跨轮询周期共享的状态字典
  - 屏幕对象由 screen_worker.ScreenWorker 持有
    (其可能在 SPI 连续失败后被重建, 故不放这里避免引用过期)
"""

import threading
from typing import TypedDict

from config import DEFAULT_SCREEN_LOCALE


class CachedState(TypedDict):
    """cached 状态字典的键/值类型约束 (2026-08-17 改进点1)。

    键名拼错或写入 None/错误类型时, 静态检查器 (Pylance/mypy) 直接报错,
    而不是静默存默认值 —— 2026-08-17 SSID None 误判 bug 就是此类问题
    (API 返回 null 时 cached 曾存 None, 主循环 None != "" 恒 True 误判变化)。

    线程写者约定 (违反 = 竞态, 无锁 dict 靠此纪律保证安全):
      - 状态轮询线程 (status_poll_loop) 独写: wifi_mode / wifi_ssid / wifi_ip /
        hostname / access_url
      - 主循环独写: chat_qr_url / chat_qr_platform / chat_qr_type /
        chat_qr_updated_at / locale
    新增键必须先声明唯一写者。
    """
    wifi_mode: str
    wifi_ssid: str
    wifi_ip: str
    hostname: str
    chat_qr_url: str
    chat_qr_platform: str
    chat_qr_type: str
    chat_qr_updated_at: float
    locale: str
    access_url: str


class DaemonState:
    """守护进程运行时状态容器 (主线程持有)。

    cached 由主循环与状态轮询线程分别写不同键 (主循环写 chat_qr_* / locale,
    状态线程写 wifi_*/hostname/access_url), 互不重叠, 读可跨线程。
    """

    def __init__(self) -> None:
        # 外设句柄 (容忍失败: None = 不可用)
        self.led = None
        self.fan = None
        self.keys = None
        self.obtn = None
        self.api = None

        # 运行控制
        self.running = True
        self.current_page = 1
        # 状态轮询线程停止信号 (后台线程 wait, 主循环退出时 set)
        self.status_stop = threading.Event()

        # 缓存状态 (跨轮询周期)
        self.cached: CachedState = {
            "wifi_mode": "",
            "wifi_ssid": "",
            "wifi_ip": "",
            "hostname": "",
            "chat_qr_url": "",
            "chat_qr_platform": "wechat",   # 当前二维码所属平台 (触发文件 platform 字段)
            "chat_qr_type": "url",          # 二维码类型: url(编码字符串) / image(图片直显)
            "chat_qr_updated_at": 0.0,      # 最近一次新二维码写入的墙钟时间戳 (过期检测用; 墙钟跨重启连续, 2026-08-25)
            "locale": DEFAULT_SCREEN_LOCALE,  # 墨水屏当前语言 (跟随 locale.json)
            "access_url": "",               # 后端访问地址 (API 返回 accessUrl 时写入)
        }
