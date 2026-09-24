"""
ClawBox 外设守护进程 —— 板载按键网络切换状态机
================================================
板载按键 (PB7) 全部短按: 按当前模式反向切换 WiFi↔热点。
反馈: 切换期间目标 LED 闪烁 (黄=热点 / 绿=WiFi); 屏幕保持当前页不动,
完成后由主循环统一跳转页面3 (2026-08-06 用户决定去掉屏幕跳转)。

状态机:
  on_button() → 置 net_busy → 后台线程执行 network_action.sh
              → 完成后置 switch_done → 主循环收尾跳页面3
"""

import logging
import subprocess
import threading
import time
from typing import Optional

from config import (
    NET_RECOVER_SWITCH_TIMEOUT_S,
    NETWORK_ACTION_SCRIPT,
    RECOVERY_AP_IFACE,
)
from net_utils import is_ap_interface, local_network_mode

logger = logging.getLogger("clawbox.netswitch")


class NetworkSwitcher:
    """板载按键网络切换状态机 (on_button 主线程调用, 执行在后台线程)。"""

    def __init__(self, led, action_timeout_s: float = NET_RECOVER_SWITCH_TIMEOUT_S) -> None:
        self._led = led
        # network_action.sh 单次执行保护超时: 与 net_auto_recover._wait_idle
        # 共用同一配置, 避免硬编码与配置中心脱节 (2026-08-25 审查 P4 补全)。
        self._action_timeout_s = action_timeout_s
        self._net_busy = False
        self._net_lock = threading.Lock()
        self._blink_lock = threading.Lock()
        self._blink_target: Optional[str] = None      # 闪烁目标: "hotspot"/"wifi"
        self._blink_keep: Optional[str] = None        # 切换前老状态灯: 常亮提示
        self._blink_stop = threading.Event()
        self._pending_button: Optional[tuple[str, str]] = None
        self._switching = False   # 切换进行中: 抑制模式变化引起的中间重绘
        self._switch_done = False  # 切换完成标记: 后台线程设置, 主循环跳转页面3

    # ============================================================
    # 状态查询 (主循环 / 清理用)
    # ============================================================

    @property
    def busy(self) -> bool:
        """是否有网络切换正在进行。"""
        return self._net_busy

    @property
    def switching(self) -> bool:
        """切换进行中 (只读): 主循环据此抑制模式变化引起的中间重绘。"""
        return self._switching

    @property
    def switch_done(self) -> bool:
        """切换完成标记 (只读): 后台线程设置, 主循环经 reset_after_switch 消费。"""
        return self._switch_done

    @property
    def blink_active(self) -> bool:
        """LED 是否处于切换闪烁期 (期间 _update_leds 应跳过)。"""
        return self._blink_target is not None

    def reset_after_switch(self) -> bool:
        """主循环收尾调用: 消费 switch_done 标记。

        Returns: 是否发生了"切换完成" (调用方应跳转页面3)。
        """
        if not self._switch_done:
            return False
        self._switch_done = False
        return True

    def cleanup(self) -> None:
        """清理: 停闪烁线程 + 复位切换状态 (优雅退出时调用)。"""
        self._stop_blink()
        self._switch_done = False
        self._switching = False
        with self._net_lock:
            self._pending_button = None

    # ============================================================
    # 切换逻辑
    # ============================================================

    @staticmethod
    def decide_action(wifi_mode: str) -> str:
        """根据当前模式决定短按切换目标 (断连/未知 → 尝试连WiFi, 失败回热点)。"""
        if wifi_mode == "ap":
            return "wifi"        # 热点 → 切回 WiFi
        if wifi_mode == "client":
            return "hotspot"     # WiFi → 切热点
        return "wifi"            # 断连/未知 → 尝试连WiFi

    def on_button(self, wifi_mode: str, event: str) -> None:
        """板载按键回调 (全部短按): 反向切换 WiFi↔热点。

        回调签名由 OnboardButton 约定: (key_id, event), event 为
        "press"(短按) 或 "long"(长按)。key_id 固定为 "board"。
        """
        if event == "long":
            # 长按已取消 (改为全部短按切换), 仅记录
            logger.info("板载按键长按已取消(全部短按切换), 忽略")
            return

        with self._net_lock:
            if self._net_busy:
                # 自动恢复动作不可被同步中断；先记下用户操作，当前动作
                # 释放 busy 后立即执行，避免用户按键在长超时内静默丢失。
                self._pending_button = (wifi_mode, event)
                logger.warning("网络切换进行中，排队本次手动按键")
                return
            self._net_busy = True

        action = self.decide_action(wifi_mode)
        if action == "hotspot":
            logger.info("板载按键短按 → 切换至热点模式")
        else:
            logger.info("板载按键短按 → 切换至已保存WiFi")

        # 反馈: 目标灯闪烁 + 老状态灯常亮 (屏幕保持当前页不动, 完成后跳页面3)
        # keep 用灯名 ("hotspot"/"wifi"), 与 _blink_target 一致, 供 _blink_worker 常亮老灯
        keep = "wifi" if wifi_mode == "client" else "hotspot" if wifi_mode == "ap" else None
        self._start_blink(action, keep=keep)
        self._switching = True

        t = threading.Thread(
            target=self._run_network_action, args=(action,),
            daemon=True, name="net-action",
        )
        t.start()

    def trigger_recovery_hotspot(self, enable: bool) -> bool:
        """创建/撤除独立临时热点；物理 WiFi 客户端接口始终保持可重连。"""
        with self._net_lock:
            if self._net_busy:
                logger.warning("网络切换进行中, 跳过临时热点动作")
                return False
            self._net_busy = True

        action = "auto-hotspot" if enable else "auto-hotspot-stop"
        if enable:
            logger.info("自动恢复 → 在独立接口创建临时热点")
            self._start_blink("hotspot")
        else:
            logger.info("WiFi 已稳定 → 撤除独立临时热点")
            self._start_blink("wifi", keep="hotspot")
        self._switching = True
        t = threading.Thread(
            target=self._run_recovery_hotspot, args=(action, enable),
            daemon=True, name="net-recovery-ap",
        )
        t.start()
        return True

    def _run_recovery_hotspot(self, action: str, enable: bool) -> None:
        """后台线程执行独立临时热点动作，并用实际接口类型验收。"""
        try:
            proc = subprocess.run(
                ["bash", NETWORK_ACTION_SCRIPT, action],
                timeout=self._action_timeout_s, capture_output=True, text=True,
                # 脚本输出中文, 显式 UTF-8 + replace 防 locale 非 UTF-8 时解码崩溃
                encoding="utf-8", errors="replace",
            )
            for line in (proc.stdout or "").strip().splitlines():
                logger.info(f"[net] {line}")
            for line in (proc.stderr or "").strip().splitlines():
                logger.warning(f"[net] {line}")
            if getattr(proc, "returncode", 0) != 0:
                logger.error(f"临时热点动作失败: {action}, rc={proc.returncode}")

            time.sleep(1)
            actual = is_ap_interface(RECOVERY_AP_IFACE)
            if actual == enable:
                logger.info("独立临时热点已就绪" if enable else "独立临时热点已撤除")
            else:
                expected = "启动" if enable else "撤除"
                logger.warning(f"独立临时热点未按预期{expected}")
        except Exception as e:
            logger.error(f"独立临时热点动作异常({action}): {e}")
        finally:
            self._stop_blink()
            self._switching = False
            self._switch_done = True
            self._finish_action()

    def _run_network_action(self, action: str) -> None:
        """后台线程执行网络切换 (不阻塞主循环, 完成后通知主循环跳转页面3)。"""
        try:
            logger.info(f"执行网络动作: {action}")
            proc = subprocess.run(
                ["bash", NETWORK_ACTION_SCRIPT, action],
                timeout=self._action_timeout_s, capture_output=True, text=True,
                # 脚本输出中文, 显式 UTF-8 + replace 防 locale 非 UTF-8 时解码崩溃
                encoding="utf-8", errors="replace",
            )
            for line in (proc.stdout or "").strip().splitlines():
                logger.info(f"[net] {line}")

            # 等待网络状态稳定后, 以实际模式判断成败(仅记录日志, 不跳屏)
            time.sleep(2)
            mode = local_network_mode()
            if action == "hotspot":
                ok = (mode == "ap")
                label = "热点"
            else:
                ok = (mode == "client")
                label = "WiFi"
            if ok:
                logger.info(f"网络切换完成 → {label} 模式")
            else:
                logger.warning(f"网络切换未达预期 → 未进入{label}模式 (实际: {mode or '未知'})")
        except Exception as e:
            logger.error(f"网络动作 {action} 异常: {e}")
        finally:
            self._stop_blink()
            self._switching = False
            self._switch_done = True     # 通知主循环: 切换结束, 强制跳转页面3
            self._finish_action()

    def _finish_action(self) -> None:
        """释放当前动作并启动排队的手动按键（用户操作优先）。"""
        with self._net_lock:
            self._net_busy = False
            pending = self._pending_button
            self._pending_button = None
            # 若有排队的手动按键，当前动作的完成不应先触发页面收尾；
            # 等手动动作完成后再由其完成标记通知主循环。
            if pending is not None:
                self._switch_done = False
        if pending is not None:
            self.on_button(*pending)

    # ============================================================
    # LED 闪烁反馈
    # ============================================================

    def _start_blink(self, target: str, keep: Optional[str] = None) -> None:
        """切换期间让目标 LED 闪烁 (hotspot→黄灯, wifi→绿灯)。

        keep: 切换前老状态灯 ("hotspot"/"wifi"), 闪烁期间保持常亮,
        让用户知道"老状态还在, 正在切到新状态" (2026-08-14 用户要求)。
        """
        with self._blink_lock:
            self._blink_stop.set()
            stop_event = threading.Event()
            self._blink_stop = stop_event
            self._blink_target = target
            self._blink_keep = keep
        threading.Thread(
            target=self._blink_worker,
            args=(stop_event, target, keep),
            daemon=True,
            name="led-blink",
        ).start()

    def _stop_blink(self) -> None:
        """停止闪烁 (LED 由 _update_leds 按实际模式重新设置)。"""
        self._blink_stop.set()
        self._blink_target = None
        self._blink_keep = None

    def _blink_worker(
        self,
        stop_event: threading.Event,
        target: str,
        keep: Optional[str],
    ) -> None:
        """闪烁线程: 切换期间目标灯 0.4s 周期闪动, 老状态灯保持常亮。"""
        on = False
        while not stop_event.wait(0.4):
            on = not on
            try:
                if self._led is None:
                    break
                self._led.set_power(True)
                if target == "hotspot":
                    self._led.set_hotspot(on)
                    self._led.set_wifi(keep == "wifi")
                else:
                    self._led.set_wifi(on)
                    self._led.set_hotspot(keep == "hotspot")
            except Exception as e:
                logger.warning(f"LED 闪烁异常: {e}")
                break
        with self._blink_lock:
            is_current = stop_event is self._blink_stop
        if not is_current:
            return
        # 退出: 熄灯, 主循环 _update_leds 会按模式重新点亮
        try:
            if self._led:
                self._led.set_hotspot(False)
                self._led.set_wifi(False)
        except Exception as e:
            logger.warning(f"LED 闪烁线程退出清理失败: {e}")
