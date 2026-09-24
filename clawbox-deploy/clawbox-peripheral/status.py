"""
ClawBox 外设守护进程 —— 状态更新 (API 优先, 本地兜底)
=======================================================
从 API 拉取 WiFi/系统状态; API 不可达时用本机命令探测 (net_utils)。
纯状态刷新, 不做任何屏幕/LED 动作 —— 由主循环按需调用。
"""

import logging
import threading
import time
from typing import Dict, Optional

from config import RECOVERY_AP_IFACE
from daemon_state import CachedState, DaemonState
from net_utils import (
    detect_wifi_mode,
    get_local_hostname,
    get_local_ip,
    get_local_wifi_ssid,
    local_network_mode,
)

logger = logging.getLogger("clawbox.status")

# 状态探测统一短超时: API 不可达时尽快回退本地, 不再长时间串行重试
_STATUS_TIMEOUT = 2.0
# API 整体不可达的告警节流间隔(秒): 状态轮询 3s 一轮, 不节流会刷屏
_API_WARN_INTERVAL = 60.0


def _fetch_setup(api) -> Optional[Dict]:
    """探测设置状态; 失败返回 None (调用方据此走本地兜底)。

    探测用短超时: 首次 setup 请求失败即本地兜底, 避免后端不可达时
    串行重试多个接口造成长时间阻塞 (2026-08-14 审查 P0-2)。
    """
    try:
        setup = api.get_setup_status(timeout=_STATUS_TIMEOUT)
    except Exception as e:
        logger.debug(f"获取设置状态失败: {e}")
        return None
    if setup.get("_error"):
        return None
    return setup


def _fetch_wifi(api, cached: CachedState) -> None:
    """拉取 WiFi 状态写入缓存 (失败静默, 保持已有缓存)。"""
    try:
        wifi = api.get_wifi_status(timeout=_STATUS_TIMEOUT)
        if wifi.get("_error"):
            return
        cached["wifi_mode"] = wifi.get("mode") or cached.get("wifi_mode") or ""
        cached["wifi_ssid"] = wifi.get("ssid") or ""
        if wifi.get("ipv4"):
            cached["wifi_ip"] = wifi["ipv4"]
        if wifi.get("accessUrl"):
            cached["access_url"] = wifi["accessUrl"]
    except Exception as e:
        logger.debug(f"获取 WiFi 状态失败: {e}")


def _fetch_system(api, cached: CachedState) -> None:
    """拉取系统信息写入缓存 (失败静默, 保持已有缓存)。"""
    try:
        sys_info = api.get_system_info(timeout=_STATUS_TIMEOUT)
        if sys_info.get("_error"):
            return
        cached["hostname"] = sys_info.get("hostname") or cached.get("hostname") or ""
        if sys_info.get("accessUrl"):
            cached["access_url"] = sys_info["accessUrl"]
    except Exception as e:
        logger.debug(f"获取系统信息失败: {e}")


def _local_fallback(cached: CachedState) -> None:
    """本地兜底: 仅当缓存为空时探测, 避免空字符串触发重复调用。"""
    if not cached.get("wifi_ip"):
        local_ip = get_local_ip()
        if local_ip:
            cached["wifi_ip"] = local_ip
    if not cached.get("hostname"):
        cached["hostname"] = get_local_hostname()


def _apply_local_mode(cached: CachedState) -> None:
    """本地模式覆盖: API 只认识主 wlan0; 自动恢复热点位于 wlan0ap 时,
    本机事实必须覆盖 API 的 disconnected, 否则屏幕和 LED 会在热点可用时
    错误显示"断开"。"""
    local_mode = local_network_mode()
    if not local_mode:
        return
    cached["wifi_mode"] = local_mode
    if local_mode == "ap":
        cached["wifi_ssid"] = ""
        local_ip = get_local_ip(RECOVERY_AP_IFACE) or get_local_ip()
    else:
        local_ip = get_local_ip()
    if local_ip:
        cached["wifi_ip"] = local_ip


def update_status_from_api(state: DaemonState) -> bool:
    """拉取最新状态; API 不可达时回退本地检测 (写入 state.cached)。

    返回 True/False: 供调用方 (status_poll_loop) 判断 API 是否整体不可达,
    以节流频率打 warning —— 纯 debug 日志在生产排查时不可见 (2026-08-25 审查)。
    """
    api = state.api
    if not api:
        return False

    setup = _fetch_setup(api)
    if setup is None:
        # API 不可达 → 直接本地兜底, 不再串行探测其余接口
        # 各本地探测均加兜底: 板端接口缺失/驱动异常不应让状态线程冒异常
        try:
            state.cached["wifi_mode"] = detect_wifi_mode()
        except Exception:
            state.cached["wifi_mode"] = state.cached.get("wifi_mode") or ""
        try:
            state.cached["wifi_ssid"] = get_local_wifi_ssid()
        except Exception:
            state.cached["wifi_ssid"] = state.cached.get("wifi_ssid") or ""
        try:
            state.cached["wifi_ip"] = get_local_ip()
        except Exception:
            state.cached["wifi_ip"] = state.cached.get("wifi_ip") or ""
        try:
            state.cached["hostname"] = get_local_hostname()
        except Exception:
            state.cached["hostname"] = state.cached.get("hostname") or ""
        return False

    # 拉取设置状态
    state.cached["wifi_mode"] = setup.get("wifi_mode") or ""
    if setup.get("wifi_ssid"):
        state.cached["wifi_ssid"] = setup["wifi_ssid"]

    _fetch_wifi(api, state.cached)
    _fetch_system(api, state.cached)
    _local_fallback(state.cached)
    _apply_local_mode(state.cached)
    return True


def status_poll_loop(state: DaemonState, stop_event: threading.Event, interval: float) -> None:
    """后台线程: 周期拉取状态, 写 state.cached (主循环只读)。

    放后台的原因: API 不可达时重试 + 本地子进程探测可达数秒~十几秒,
    若在主循环同步执行会阻塞按键扫描与屏幕刷新 (2026-08-14 审查 P0-2)。
    """
    last_api_warn = 0.0
    while not stop_event.is_set():
        try:
            ok = update_status_from_api(state)
            if not ok:
                now = time.monotonic()
                if now - last_api_warn >= _API_WARN_INTERVAL:
                    last_api_warn = now
                    logger.warning("API 不可达, 已切换本地状态兜底 (后续每 60s 提示一次)")
        except Exception as e:
            logger.debug(f"状态轮询线程异常: {e}")
        stop_event.wait(interval)
