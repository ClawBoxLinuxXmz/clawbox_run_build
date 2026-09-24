"""
ClawBox 外设守护进程 —— 输入校验纯函数模块
============================================
从 peripheral_daemon.py 抽离 (2026-08-11 工程化重构):
  - 环境变量整数解析 / URL scheme 白名单解析
  - QR 触发文件 URL 与图片 data URL 校验

纯逻辑、无硬件/IO 依赖, 可在 PC 上直接单测。
"""

import os
import re
from typing import Any, Set
from urllib.parse import urlsplit

# ============================================================
# 环境变量解析 (支持 CLAWBOX_* 覆盖, 非法值回退默认, 越界收敛)
# ============================================================


def env_int(name: str, default: int, min_value: int, max_value: int) -> int:
    """解析整数环境变量; 缺失/非法回退默认, 越界收敛到 [min,max]。"""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(value, max_value))


def parse_allowed_schemes(raw: str) -> Set[str]:
    """解析逗号分隔的 URL scheme 白名单; 全部非法时回退 {http, https}。"""
    schemes = {
        item.strip().lower()
        for item in raw.split(",")
        if re.fullmatch(r"[a-z][a-z0-9+.-]*", item.strip().lower())
    }
    return schemes or {"http", "https"}


# ============================================================
# QR 输入上限与白名单 (环境变量可覆盖, 默认值与 install.sh
# CONFIG_DEFAULTS 保持一致 —— 改默认需两处同步)
# ============================================================
MAX_QR_URL_LENGTH = env_int("CLAWBOX_QR_MAX_LENGTH", 2048, 128, 8192)
# WhatsApp 图片 data URL 前端上限 16384 字符, 触发文件需能容纳整张图片
MAX_QR_FILE_BYTES = env_int("CLAWBOX_QR_FILE_MAX_BYTES", 20000, 512, 65536)
MAX_QR_DATA_URL_LENGTH = env_int("CLAWBOX_QR_IMAGE_MAX_LENGTH", 16384, 512, 65536)
QR_ALLOWED_SCHEMES = parse_allowed_schemes(
    os.environ.get("CLAWBOX_QR_ALLOWED_SCHEMES", "http,https")
)
QR_DATA_URL_PREFIX = "data:image/png;base64,"


def validate_qr_url(value: Any) -> str:
    """校验可编码二维码 URL: 类型/长度/scheme 白名单/禁止内嵌凭据。

    返回规范化后的字符串; 非法返回 "" (调用方据此丢弃)。
    """
    if not isinstance(value, str):
        return ""
    url = value.strip()
    if not url or len(url) > MAX_QR_URL_LENGTH:
        return ""
    # 控制字符(\x00-\x1f\x7f)不应进入二维码渲染/存储
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        return ""
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in QR_ALLOWED_SCHEMES or not parsed.netloc:
        return ""
    if parsed.username or parsed.password:
        return ""
    return url


def validate_qr_data_url(value: Any) -> str:
    """校验 WhatsApp 等平台的二维码图片 data URL (data:image/png;base64,...)。

    仅校验前缀/长度/base64 字符集, 不解析图片内容 (解码在 qr_generator 层)。
    """
    if not isinstance(value, str):
        return ""
    url = value.strip()
    if not url.startswith(QR_DATA_URL_PREFIX):
        return ""
    if len(url) > MAX_QR_DATA_URL_LENGTH:
        return ""
    b64 = url[len(QR_DATA_URL_PREFIX):]
    if not b64 or not re.fullmatch(r"[A-Za-z0-9+/=]+", b64):
        return ""
    return url
