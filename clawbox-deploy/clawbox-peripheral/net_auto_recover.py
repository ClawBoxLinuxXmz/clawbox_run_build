"""
ClawBox 外设守护进程 —— 无中断网络自动恢复
==========================================
客户端 WiFi 断开且 NetworkManager 快速重连失败时，在独立虚拟接口上提供临时热点。
物理客户端接口保持 managed，NetworkManager 可在后台自然重连，不再周期性拆热点试连。
"""

import logging
import threading
import time
from typing import Optional

from config import RECOVERY_AP_IFACE
from net_utils import count_ap_clients, is_ap_interface, is_wifi_client_connected

logger = logging.getLogger("clawbox.netrecover")


class NetworkAutoRecover:
    """断网检测与临时热点生命周期，不直接执行系统网络命令。"""

    def __init__(self, switcher, grace_s: float, client_stable_s: float,
                 ap_client_grace_s: float, poll_s: float,
                 recovery_iface: str = RECOVERY_AP_IFACE,
                 switch_timeout_s: float = 130.0) -> None:
        self._switcher = switcher
        self._grace_s = grace_s
        self._client_stable_s = client_stable_s
        self._ap_client_grace_s = ap_client_grace_s
        self._poll_s = poll_s
        self._recovery_iface = recovery_iface
        self._switch_timeout_s = switch_timeout_s
        self._lost_since: Optional[float] = None
        self._recovering = False
        self._lock = threading.Lock()
        self._cancel = threading.Event()

    @property
    def recovering(self) -> bool:
        return self._recovering

    def check(self, client_connected: bool, manual_ap: bool, now: float) -> None:
        """主循环周期调用；手动热点优先级永远高于自动恢复。"""
        if manual_ap:
            self._lost_since = None
            if self._recovering:
                self.cancel()
            return
        if self._recovering:
            return
        if client_connected:
            self._lost_since = None
            return
        if self._lost_since is None:
            self._lost_since = now
            return
        if now - self._lost_since < self._grace_s:
            return
        if self._switcher.busy:
            self._lost_since = now
            return
        self._start_recovery()

    def _start_recovery(self) -> None:
        with self._lock:
            if self._recovering:
                return
            self._recovering = True
            self._cancel.clear()
        self._lost_since = None
        logger.info("WiFi 断开超过宽限 → 创建独立临时热点，后台保持自动重连")
        threading.Thread(
            target=self._recovery_loop, daemon=True, name="net-recover",
        ).start()

    def _recovery_loop(self) -> None:
        try:
            if not self._enter_recovery():
                return
            self._monitor_stable_then_teardown()
        finally:
            with self._lock:
                self._recovering = False

    def _enter_recovery(self) -> bool:
        if not self._switcher.trigger_recovery_hotspot(True):
            return False
        if not self._wait_idle() or self._cancel.is_set():
            return False
        if not is_ap_interface(self._recovery_iface):
            if is_wifi_client_connected():
                logger.info("临时热点启动前 WiFi 已自行恢复")
            else:
                logger.warning("独立临时热点未就绪，将在下个宽限周期重试")
            return False
        logger.info(f"临时热点已就绪({self._recovery_iface})，WiFi 客户端接口继续由 NetworkManager 后台重连")
        return True

    def _monitor_stable_then_teardown(self) -> None:
        stable_since: Optional[float] = None
        clients_deferred = False
        while not self._cancel.wait(self._poll_s):
            now = time.monotonic()
            if not is_wifi_client_connected():
                if stable_since is not None:
                    logger.info("WiFi 在稳定期内再次断开，继续保留临时热点")
                stable_since = None
                clients_deferred = False
                continue
            if stable_since is None:
                stable_since = now
                logger.info(f"WiFi 已重连，观察 {self._client_stable_s:.0f}s 确认稳定后再撤临时热点")
                continue
            stable_for = now - stable_since
            if stable_for < self._client_stable_s:
                continue
            clients = count_ap_clients(self._recovery_iface)
            if clients and stable_for < (self._client_stable_s + self._ap_client_grace_s):
                if not clients_deferred:
                    logger.info(f"临时热点仍有 {clients} 个客户端，最多保留 {self._ap_client_grace_s:.0f}s 避免打断配置")
                    clients_deferred = True
                continue
            if clients:
                logger.info("热点客户端保留期已到，撤掉临时热点并回到 WiFi")
            if not self._switcher.trigger_recovery_hotspot(False):
                continue
            if not self._wait_idle() or self._cancel.is_set():
                return
            if is_ap_interface(self._recovery_iface):
                logger.warning("WiFi 已恢复，但临时热点撤除失败")
            else:
                logger.info("自动恢复完成 → WiFi 稳定，临时热点已安全撤除")
            return

    def _wait_idle(self) -> bool:
        """等待单次切换完成；取消或保护超时(switch_timeout_s)均返回 False。"""
        deadline = time.monotonic() + self._switch_timeout_s
        while self._switcher.busy and time.monotonic() < deadline:
            if self._cancel.wait(0.2):
                return False
        return not self._switcher.busy

    def cancel(self) -> None:
        """手动按键接管网络时终止自动决策；当前网络由手动动作继续处理。"""
        self._lost_since = None
        self._cancel.set()

    def reset(self) -> None:
        """守护进程退出时只停决策线程，不擅自改变仍可用的网络。"""
        self.cancel()
