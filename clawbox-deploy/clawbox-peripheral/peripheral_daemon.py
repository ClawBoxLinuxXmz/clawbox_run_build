#!/usr/bin/env python3
"""
ClawBox Peripheral Daemon
==========================
Manages e-ink screen, LED, keys, fan.

鲁棒性设计:
  - 任一外设缺失不影响其他外设
  - 后端 API 不可达时使用本地信息
  - 所有异常被捕获，不会崩溃退出
  - 支持 SIGTERM/SIGINT 优雅退出

架构 (2026-08-21 工程化重构后):
  main()
    ├── 初始化各模块 (容忍失败)
    ├── 显示启动画面
    ├── 主循环 (30ms, 每轮原子写 heartbeat):
    │     ├── 按键扫描 (KEY_POLL_INTERVAL=0.03)
    │     ├── API 状态轮询 (~3s)
    │     ├── LED 状态同步
    │     ├── QR/语言触发文件检测 (triggers.TriggerWatcher, 成功才前移基线)
    │     └── 屏幕页面更新 (screen_worker.ScreenWorker, version去重)
    └── 清理退出 (stop 6s超时跳过清屏防SPI并发)

模块划分 (clawbox-peripheral/):
  config.py         配置中心 (单一数据源)
  validation.py     输入校验纯函数 (QR URL/data URL/环境变量)
  net_utils.py      本地网络探测 (IP/主机名/WiFi 模式/SSID)
  triggers.py       QR/语言触发文件监听
  screen_worker.py  屏幕生产者-消费者线程 (主线程生成, 后台只做 SPI)
  net_switcher.py   板载按键网络切换状态机 + LED 闪烁反馈
  power.py          关机/重启
  daemon_state.py   共享运行时状态容器
  led/fan/key/onboard/api 外设控制器
"""

import os
import signal
import sys
import time

try:
    from peripheral_lock import DaemonLock
    _HAS_LOCK = True
except ImportError:
    DaemonLock = None  # type: ignore
    _HAS_LOCK = False
import logging
import threading
from typing import Callable, Dict

# ── 确保能找到同目录模块 ──
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from app_context import AppContext
from config import (
    API_BASE_URL,
    API_POLL_INTERVAL,
    DEFAULT_SCREEN_LOCALE,
    FAN_CHECK_INTERVAL,
    FAN_DUTY_DEAD_BAND,
    FAN_HYSTERESIS,
    FAN_LOG_HEARTBEAT_INTERVAL,
    FAN_MIN_EFFECTIVE_DUTY,
    FAN_MIN_HOLD_SAMPLES,
    FAN_PWM_CHANNEL,
    FAN_PWM_CHIP,
    FAN_PWM_MAX_DUTY,
    FAN_PWM_PERIOD_NS,
    FAN_SPEED_CURVE,
    FAN_START_STOP_HYSTERESIS,
    FAN_TEMP_DIRECTION_DEAD_BAND,
    FAN_TEMP_SENSOR,
    FORCE_AP_FLAG,
    HEARTBEAT_FILE,
    KEY_DEBOUNCE_MS,
    KEY_LONG_PRESS_MS,
    KEY_POLL_INTERVAL,
    KEYS,
    LEDS,
    LIVE_MARK,
    LOCALE_TRIGGER_FILE,
    NET_RECOVER_AP_CLIENT_GRACE_S,
    NET_RECOVER_CHECK_INTERVAL,
    NET_RECOVER_CLIENT_STABLE_S,
    NET_RECOVER_GRACE_MS,
    NET_RECOVER_SWITCH_TIMEOUT_S,
    PAGE_QR_EXPIRED,
    PARTIAL_IDLE_TIMEOUT,
    PARTIAL_REFRESH_EVERY,
    QR_EXPIRE_MS,
    QR_TRIGGER_FILE,
    QR_TRIGGER_FILE_LEGACY,
    RECOVERY_AP_IFACE,
    VERSION,
)
from daemon_state import DaemonState
from logging_setup import LOG_BACKUP_COUNT, LOG_FILE, setup_logging
from net_utils import is_wifi_client_connected
from page_render import render_page_image
from power import do_reboot, do_shutdown
from screen_pages import (
    resolve_screen_locale,
    set_locale,
)
from validation import MAX_QR_FILE_BYTES

# Hardware-specific modules are optional at import time.  A partial deployment
# must still bring up the daemon and the remaining devices instead of failing
# before logging and graceful degradation can run.
try:
    from api_client import ApiClient
except ImportError:
    ApiClient = None  # type: ignore[assignment,misc]
try:
    from fan_controller import FanController
except ImportError:
    FanController = None  # type: ignore[assignment,misc]
try:
    from key_listener import KeyListener
except ImportError:
    KeyListener = None  # type: ignore[assignment,misc]
try:
    from led_controller import LedController
except ImportError:
    LedController = None  # type: ignore[assignment,misc]
try:
    from net_auto_recover import NetworkAutoRecover
except ImportError:
    NetworkAutoRecover = None  # type: ignore[assignment,misc]
try:
    from net_switcher import NetworkSwitcher
except ImportError:
    NetworkSwitcher = None  # type: ignore[assignment,misc]
try:
    from onboard_button import OnboardButton
except ImportError:
    OnboardButton = None  # type: ignore[assignment,misc]
try:
    from screen_renderer import ScreenRenderer
except ImportError:
    ScreenRenderer = None  # type: ignore[assignment,misc]
try:
    from screen_worker import ScreenWorker
except ImportError:
    ScreenWorker = None  # type: ignore[assignment,misc]
try:
    from status import status_poll_loop
except ImportError:
    status_poll_loop = None  # type: ignore[assignment]
try:
    from triggers import TriggerWatcher
except ImportError:
    TriggerWatcher = None  # type: ignore[assignment,misc]

logger = logging.getLogger("clawbox.daemon")

# 高频告警节流: 同标签 interval 秒内只打一次, 防止外设持续故障刷屏 (2026-08-11)
_warn_throttle: Dict[str, float] = {}

# SSD1680 常规刷新 BUSY 最长约 5 秒。清理最多等 6 秒；若线程仍未退出，
# 跳过主线程的 sleep()，避免与后台 SPI 传输并发。
_SCREEN_STOP_TIMEOUT = 6.0


def _log_warn_throttled(tag: str, msg: str, interval: float = 60.0) -> None:
    now = time.monotonic()
    if now - _warn_throttle.get(tag, 0.0) >= interval:
        _warn_throttle[tag] = now
        logger.warning(f"[{tag}] {msg}")


# ============================================================
# 回调函数 (ctx 由 main() 创建, 经 lambda 捕获注入 —— 模块级零全局)
# ============================================================

def on_key_event(ctx: AppContext, key_id: str, event: str) -> None:
    """按键事件回调（所有短按在松手时触发）"""
    state = ctx.state
    if event == "press":
        # 短按（松手触发）
        page_map = {"k1": 1, "k2": 2, "k3": 3}
        if key_id in page_map:
            new_page = page_map[key_id]
            if new_page != state.current_page:
                logger.info(f"{key_id} → 请求页面 {new_page}")
                state.current_page = new_page
                gen_and_request(ctx, new_page)
        elif key_id == "k4":
            # K4 短按 → 重启
            logger.info("K4短按 → 重启")
            do_reboot(state, ctx.screen_worker)
    elif event == "long":
        if key_id == "k1":
            # K1 长按 → 说明页 (page 0)
            logger.info("K1长按 → 说明页")
            state.current_page = 0
            gen_and_request(ctx, 0)
        elif key_id == "k4":
            logger.info("K4长按 → 关机")
            do_shutdown(state, ctx.screen_worker)


def on_onboard_button(ctx: AppContext, key_id: str, event: str) -> None:
    """板载按键回调 (全部短按): 按当前模式反向切换 WiFi↔热点。"""
    switcher = ctx.switcher
    if switcher is None:
        return
    if event == "press" and ctx.net_recover is not None:
        # 用户操作必须立即取得最高优先级，旧自动恢复线程只退出、不再改网络。
        ctx.net_recover.cancel()
    # 用状态轮询线程的缓存模式做切换决策: 现场探测 (iw/nmcli subprocess)
    # 在无线驱动异常时可达数秒, 会卡住按键回调 (2026-08-14 审查 P1-3)。
    switcher.on_button(ctx.state.cached.get("wifi_mode", ""), event)


# ============================================================
# 屏幕页面生成
# ============================================================

def gen_and_request(ctx: AppContext, page: int) -> None:
    """主线程调用: 生成页面图像, 交给后台屏幕线程显示。"""
    if ctx.screen_worker is None:
        return
    img = render_page_image(ctx.state, page)
    if img is None:
        return
    ctx.screen_worker.request(page, img)


# ============================================================
# 状态更新逻辑 (实现见 status.py)
# ============================================================

def _update_leds(state: DaemonState, switcher) -> None:
    """根据缓存状态更新 LED (切换闪烁期间跳过, 由闪烁线程控制)。"""
    led = state.led
    if not led:
        return

    # 板载按键切换期间: LED 由闪烁线程控制, 此处跳过避免抢状态
    if switcher is not None and switcher.blink_active:
        return

    mode = state.cached.get("wifi_mode", "")
    led.set_power(True)                            # 红灯始终亮 (开机)
    led.set_hotspot(mode == "ap")                   # 黄灯 = 热点模式
    led.set_wifi(mode == "client")                  # 绿灯 = WiFi客户端模式


# ============================================================
# 主循环 handler (从 main() 主循环抽出的独立函数, 便于逐段单测)
# 依赖通过参数显式传入 (state/switcher/watcher/recover), 不在函数内读
# 模块全局, 使每个处理段可在 PC 上用桩对象隔离测试 (2026-08-18 问题3)。
# 每段保留独立 try/except —— 偶发异常只记录不退出主循环, 避免任一处理段
# 抛异常导致整个守护进程静默退出 (rc.local 不会自动重启) 2026-08-11
# ============================================================

class _StatusTracker:
    """主循环跨轮缓存: 上次 WiFi 模式/IP/SSID (10b 状态变化检测用)。

    原为主循环局部变量 last_mode/last_ip/last_ssid; 抽成小对象后
    10b 逻辑可被独立单测, 且不引入新的模块级全局。
    """

    def __init__(self, state) -> None:
        self.mode = state.cached.get("wifi_mode") or ""
        self.ip = state.cached.get("wifi_ip") or ""
        self.ssid = state.cached.get("wifi_ssid") or ""


def _handle_keys(state) -> None:
    """主循环 10a: 物理按键扫描 (始终优先, 不阻塞)。"""
    if state.keys:
        try:
            state.keys.poll()
        except Exception as e:
            logger.error(f"按键扫描异常: {e}")


def _handle_onboard(state) -> None:
    """主循环 10a2: 板载按键扫描 (PB7, 直接读 PIO 寄存器)。"""
    if state.obtn:
        try:
            state.obtn.poll()
        except Exception as e:
            logger.error(f"板载按键扫描异常: {e}")


def _handle_net_recover(recover, last_check: float, loop_start: float) -> float:
    """主循环 10a3: 断网自动恢复检测 (手动热点标记永远优先)。

    返回更新后的上次检查时间; 未到检查间隔时原样返回。
    """
    if recover is None or loop_start - last_check < NET_RECOVER_CHECK_INTERVAL:
        return last_check
    try:
        recover.check(
            is_wifi_client_connected(),
            os.path.exists(FORCE_AP_FLAG),
            time.monotonic(),
        )
        return loop_start
    except Exception as e:
        logger.error(f"断网自动恢复检测异常: {e}")
        return last_check


def _handle_status_change(state, tracker, switcher, request_page: Callable[[int], None]) -> None:
    """主循环 10b: 状态变化检测 (状态由后台轮询线程写入, 这里只比较, 不阻塞)。

    注意: API 字段可能为 null, cached 里可能存 None; 统一 or "" 归一化,
    否则 None != "" 恒为 True, 会误判 SSID 变化并频繁重绘 (2026-08-17 实机)。
    """
    new_mode = state.cached.get("wifi_mode") or ""
    new_ip = state.cached.get("wifi_ip") or ""
    new_ssid = state.cached.get("wifi_ssid") or ""
    if new_mode == tracker.mode and new_ip == tracker.ip and new_ssid == tracker.ssid:
        return

    if new_mode != tracker.mode:
        logger.info(f"WiFi 模式变化: {tracker.mode} → {new_mode}")
    if new_ip != tracker.ip:
        logger.info(f"IP 变化: {tracker.ip} → {new_ip}")
    # SSID 变化 (AP 间漫游且 IP 不变) 也要刷新页面3 (2026-08-14 审查 P2-6)
    if new_ssid != tracker.ssid:
        logger.info(f"SSID 变化: {tracker.ssid or '无'} → {new_ssid or '无'}")
    tracker.mode = new_mode
    tracker.ip = new_ip
    tracker.ssid = new_ssid
    # 板载按键切换期间/刚完成: 不重绘当前页, 由 10f 统一跳转页面3
    if switcher is None or (not switcher.switching and not switcher.switch_done):
        request_page(state.current_page)


def _handle_leds(state, switcher, update_leds: Callable = _update_leds) -> None:
    """主循环 10d: LED 状态同步。"""
    if state.led:
        try:
            update_leds(state, switcher)
        except Exception as e:
            _log_warn_throttled("led", f"LED 状态同步异常: {e}")


def _handle_qr_trigger(state, watcher, request_page: Callable[[int], None]) -> None:
    """主循环 10e: QR 触发器文件检测 (Next.js 写入 → 即时刷新页面2)。"""
    if watcher is None:
        return
    try:
        qr = watcher.check_qr()
        if qr and qr["qr_url"] != state.cached.get("chat_qr_url", ""):
            # 记录新码写入时刻 → 10g 据此检测 WhatsApp 码过期自动切提示页
            # 用墙钟 time.time() 而非 monotonic: 守护进程重启后 monotonic 归零,
            # 旧值(重启前)比新值大 → 时间差为负 → 过期检测在重启后最长一个过期
            # 周期内失效 (2026-08-25 审查 P2)。墙钟跨重启连续, 即时恢复生效。
            state.cached["chat_qr_url"] = qr["qr_url"]
            state.cached["chat_qr_platform"] = qr["platform"]
            state.cached["chat_qr_type"] = qr["qr_type"]
            state.cached["chat_qr_updated_at"] = time.time()
            logger.info(
                f"QR触发器: 收到新的二维码 (platform={qr['platform']}, "
                f"type={qr['qr_type']})"
            )
            logger.info(
                f"QR触发器生效, 当前页面={state.current_page}, 强制跳转页面2"
            )
            state.current_page = 2
            request_page(2)
    except Exception as e:
        logger.error(f"QR 触发器处理异常: {e}")


def _handle_locale_trigger(state, watcher, request_page: Callable[[int], None]) -> None:
    """主循环 10e2: 语言触发文件检测 (网页语言变化 → 重绘当前页)。"""
    if watcher is None:
        return
    try:
        raw_locale = watcher.check_locale()
        if raw_locale:
            resolved = resolve_screen_locale(raw_locale)
            if resolved != state.cached.get("locale", DEFAULT_SCREEN_LOCALE):
                state.cached["locale"] = resolved
                set_locale(resolved)
                logger.info(f"语言切换: {raw_locale} → {resolved}")
                logger.info(f"语言触发生效, 重绘当前页 page={state.current_page}")
                request_page(state.current_page)
    except Exception as e:
        logger.error(f"语言触发器处理异常: {e}")


def _handle_qr_expiry(state, request_page: Callable[[int], None]) -> None:
    """主循环 10g: WhatsApp 二维码过期检测。

    页面2 的图片型码超过 QR_EXPIRE_MS 未更新 (Baileys 每 ~20s 轮换, 静态快照
    过了有效期就是死码, 手机扫描会被服务器拒绝) → 自动切过期提示页。
    """
    try:
        if (state.current_page == 2
                and state.cached.get("chat_qr_type") == "image"
                and state.cached.get("chat_qr_platform") == "whatsapp"):
            qr_ts = state.cached.get("chat_qr_updated_at", 0.0)
            if qr_ts and (time.time() - qr_ts) > QR_EXPIRE_MS / 1000.0:
                logger.info("WhatsApp 二维码已超过有效期, 切换过期提示页")
                state.current_page = PAGE_QR_EXPIRED
                request_page(PAGE_QR_EXPIRED)
    except Exception as e:
        logger.error(f"WhatsApp 过期检测异常: {e}")


def _handle_switch_done(state, switcher, request_page: Callable[[int], None]) -> None:
    """主循环 10f: 网络切换完成 → 强制跳转页面3 (WiFi 状态页)。"""
    try:
        if switcher is not None and switcher.reset_after_switch():
            logger.info("网络切换完成 → 强制跳转页面3")
            state.current_page = 3
            request_page(3)
    except Exception as e:
        logger.error(f"网络切换收尾异常: {e}")


# ============================================================
# 主函数
# ============================================================

def signal_handler(ctx: AppContext, signum, _frame):
    """信号处理: SIGTERM / SIGINT → 优雅退出

    ⚠️ 不在信号处理器里调 logger.info: 若恰逢日志轮转(emit)中途被信号打断,
    重入 RotatingFileHandler 会触发 "reentrant call" RuntimeError (2026-08-21 实机),
    改用 os.write 直写 stderr(信号上下文更安全), 避免重入日志句柄。
    """
    try:
        os.write(2, f"[clawbox] 收到信号 {signum}，准备退出...\n".encode("utf-8", "replace"))
    except (OSError, ValueError):
        pass
    ctx.state.running = False


def _write_live_mark() -> None:
    try:
        tmp = LIVE_MARK + ".tmp"
        with open(tmp, "w", encoding="utf-8") as _f:
            _f.write(f"{os.getpid()} {time.monotonic():.3f}\n")
        os.rename(tmp, LIVE_MARK)
    except OSError as e:
        logger.warning(f"运行标记写入失败({LIVE_MARK}): {e}")


def _write_heartbeat() -> None:
    try:
        os.makedirs(os.path.dirname(HEARTBEAT_FILE), exist_ok=True)
        tmp = HEARTBEAT_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as _f:
            _f.write(f"{time.monotonic():.3f} {int(time.time())}\n")
        os.rename(tmp, HEARTBEAT_FILE)
    except OSError as e:
        logger.warning(f"心跳写入失败({HEARTBEAT_FILE}): {e}")


def _setup_signals(ctx: AppContext) -> None:
    signal.signal(signal.SIGTERM, lambda s, f: signal_handler(ctx, s, f))
    signal.signal(signal.SIGINT, lambda s, f: signal_handler(ctx, s, f))


def _init_locale(ctx: AppContext) -> None:
    if TriggerWatcher is None:
        logger.error("触发器模块缺失，跳过 QR/语言文件监听")
        ctx.watcher = None
        set_locale(ctx.state.cached.get("locale", DEFAULT_SCREEN_LOCALE))
        return
    ctx.watcher = TriggerWatcher(
        qr_files=(("chat", QR_TRIGGER_FILE), ("legacy", QR_TRIGGER_FILE_LEGACY)),
        locale_file=LOCALE_TRIGGER_FILE,
        max_qr_file_bytes=MAX_QR_FILE_BYTES,
    )
    ctx.watcher.sync_locale_mtime()
    raw_locale = ctx.watcher.read_locale()
    if raw_locale:
        resolved = resolve_screen_locale(raw_locale)
        ctx.state.cached["locale"] = resolved
        set_locale(resolved)
        logger.info(f"启动语言: {raw_locale} → {resolved}")
    else:
        set_locale(ctx.state.cached.get("locale", DEFAULT_SCREEN_LOCALE))


def _init_led(state) -> None:
    logger.info("--- 初始化 LED ---")
    if LedController is None:
        logger.error("LED 模块缺失，跳过 LED 初始化")
        state.led = None
        return
    try:
        state.led = LedController(LEDS)
    except Exception as e:
        logger.error(f"LED 初始化失败: {e}")
        state.led = None


def _init_fan(state) -> None:
    logger.info("--- 初始化风扇温控 ---")
    if FanController is None:
        logger.error("风扇模块缺失，跳过风扇初始化，其他外设继续运行")
        state.fan = None
        return
    try:
        state.fan = FanController(
            pwm_chip=FAN_PWM_CHIP, pwm_channel=FAN_PWM_CHANNEL,
            period_ns=FAN_PWM_PERIOD_NS, max_duty=FAN_PWM_MAX_DUTY,
            temp_sensor=FAN_TEMP_SENSOR, speed_curve=FAN_SPEED_CURVE,
            hysteresis=FAN_HYSTERESIS, check_interval=FAN_CHECK_INTERVAL,
            min_effective_duty=FAN_MIN_EFFECTIVE_DUTY,
            start_stop_hysteresis=FAN_START_STOP_HYSTERESIS,
            duty_dead_band=FAN_DUTY_DEAD_BAND,
            min_hold_samples=FAN_MIN_HOLD_SAMPLES,
            temp_direction_dead_band=FAN_TEMP_DIRECTION_DEAD_BAND,
            log_heartbeat_interval=FAN_LOG_HEARTBEAT_INTERVAL,
        )
        state.fan.start()
    except Exception as e:
        logger.error(f"风扇初始化失败: {e}")
        state.fan = None


def _init_screen(ctx: AppContext) -> None:
    logger.info("--- 初始化墨水屏 ---")
    if ScreenWorker is None:
        logger.error("屏幕工作线程模块缺失，跳过屏幕，其他外设继续运行")
        ctx.screen_worker = None
        return
    try:
        screen = ScreenRenderer() if ScreenRenderer is not None else None
    except Exception as e:
        logger.error(f"屏幕初始化失败: {e}")
        screen = None
    ctx.screen_worker = ScreenWorker(screen=screen)
    if ctx.screen_worker.screen and ctx.screen_worker.screen.available:
        try:
            # boot 画面走后台线程队列, 不在主线程碰 SPI (2026-08-26 修复):
            # 原实现主线程同步 show_boot() 直接操作 SPI, 屏幕 BUSY 时主线程
            # 卡在等待循环 (225 幽灵面板实测卡 25s+), SIGTERM 的 running=False
            # 无人检查 → 守护进程假死无法退出。渲染是纯 CPU 安全, 刷新交给
            # screen_worker 后台线程 (SPI 红线: 只有它能碰 SPI)。
            from screen_pages import render_boot_screen
            boot_img = render_boot_screen()
            if boot_img is not None:
                ctx.screen_worker.request(0, boot_img)
                logger.info("启动画面已入队, 由屏幕线程刷新")
        except Exception as e:
            logger.warning(f"生成启动画面失败: {e}")


def _init_api(state) -> None:
    logger.info("--- 初始化 API 客户端 ---")
    if ApiClient is None:
        logger.error("API 模块缺失，切换本地状态兜底")
        state.api = None
        return
    try:
        state.api = ApiClient()
    except Exception as e:
        logger.error(f"API 客户端初始化失败: {e}")
        state.api = None


def _init_status_thread(state) -> None:
    if status_poll_loop is None:
        logger.error("状态轮询模块缺失，跳过 API 状态轮询")
        return
    threading.Thread(
        target=status_poll_loop,
        args=(state, state.status_stop, API_POLL_INTERVAL),
        daemon=True, name="status-poll",
    ).start()


def _init_keys(ctx: AppContext) -> None:
    logger.info("--- 初始化按键 ---")
    if KeyListener is None:
        logger.error("按键模块缺失，跳过 GPIO 按键初始化")
        ctx.state.keys = None
    else:
        try:
            ctx.state.keys = KeyListener(
                KEYS,
                lambda key_id, event: on_key_event(ctx, key_id, event),
                debounce_ms=KEY_DEBOUNCE_MS, long_press_ms=KEY_LONG_PRESS_MS,
            )
        except Exception as e:
            logger.error(f"按键初始化失败: {e}")
            ctx.state.keys = None
    logger.info("--- 初始化板载按键 ---")
    if OnboardButton is None:
        logger.error("板载按键模块缺失，跳过 PB7 按键初始化")
        ctx.state.obtn = None
    else:
        try:
            ctx.state.obtn = OnboardButton(
                lambda key_id, event: on_onboard_button(ctx, key_id, event),
                debounce_ms=KEY_DEBOUNCE_MS, long_press_ms=KEY_LONG_PRESS_MS,
            )
            if not ctx.state.obtn.is_available():
                logger.warning("板载按键不可用, 跳过")
        except Exception as e:
            logger.error(f"板载按键初始化失败: {e}")
            ctx.state.obtn = None


def _init_network(ctx: AppContext) -> None:
    if NetworkSwitcher is None or NetworkAutoRecover is None:
        logger.error("网络模块缺失，跳过网络切换与自动恢复")
        ctx.switcher = None
        ctx.net_recover = None
        return
    ctx.switcher = NetworkSwitcher(led=ctx.state.led)
    ctx.net_recover = NetworkAutoRecover(
        ctx.switcher,
        grace_s=NET_RECOVER_GRACE_MS / 1000.0,
        client_stable_s=NET_RECOVER_CLIENT_STABLE_S,
        ap_client_grace_s=NET_RECOVER_AP_CLIENT_GRACE_S,
        poll_s=NET_RECOVER_CHECK_INTERVAL,
        recovery_iface=RECOVERY_AP_IFACE,
        switch_timeout_s=NET_RECOVER_SWITCH_TIMEOUT_S,
    )


def _run_boot_to_idle(ctx: AppContext) -> None:
    state = ctx.state
    if state.led:
        try:
            state.led.set_power(True)
        except Exception as e:
            logger.warning(f"点亮电源 LED 失败: {e}")
    logger.info("--- 启动屏幕刷新线程 ---")
    if ctx.screen_worker is not None:
        ctx.screen_worker.start()
    _update_leds(state, ctx.switcher)
    time.sleep(2.5)
    logger.info("自动切换到说明页")
    state.current_page = 0
    gen_and_request(ctx, 0)
    if ctx.watcher is not None:
        ctx.watcher.sync_qr_mtimes()


def _main_loop(ctx: AppContext) -> int:
    state = ctx.state
    tracker = _StatusTracker(state)
    last_recover = 0.0
    exit_code = 0
    try:
        while state.running:
            loop_start = time.monotonic()
            _write_heartbeat()
            _handle_keys(state)
            _handle_onboard(state)
            last_recover = _handle_net_recover(ctx.net_recover, last_recover, loop_start)
            _handle_status_change(state, tracker, ctx.switcher, lambda p: gen_and_request(ctx, p))
            _handle_leds(state, ctx.switcher, _update_leds)
            _handle_qr_trigger(state, ctx.watcher, lambda p: gen_and_request(ctx, p))
            _handle_locale_trigger(state, ctx.watcher, lambda p: gen_and_request(ctx, p))
            _handle_qr_expiry(state, lambda p: gen_and_request(ctx, p))
            _handle_switch_done(state, ctx.switcher, lambda p: gen_and_request(ctx, p))
            elapsed = time.monotonic() - loop_start
            time.sleep(max(0, KEY_POLL_INTERVAL - elapsed))
    except KeyboardInterrupt:
        logger.info("收到 Ctrl+C")
    except Exception as e:
        logger.exception(f"主循环异常退出: {e}")
        exit_code = 1
    return exit_code


def main():
    ctx = AppContext()
    setup_logging(verbose=("--debug" in sys.argv or "-d" in sys.argv))
    # 单实例锁：旧 daemon 未退出时新实例直接失败，防止双实例抢 SPI/GPIO
    lock = None
    if _HAS_LOCK:
        lock = DaemonLock()
        if not lock.acquire():
            return 2
    _write_live_mark()
    logger.info("=" * 50)
    logger.info(f"ClawBox Peripheral Daemon starting... v{VERSION}")
    logger.info("=" * 50)
    logger.info(
        f"配置摘要: API={API_BASE_URL} 轮询={API_POLL_INTERVAL}s "
        f"按键={KEY_POLL_INTERVAL}s 局刷节奏={PARTIAL_REFRESH_EVERY}局刷+1全刷 "
        f"局刷空闲={PARTIAL_IDLE_TIMEOUT}s 语言={DEFAULT_SCREEN_LOCALE} "
        f"日志={LOG_FILE}(自轮转 {LOG_BACKUP_COUNT} 份)"
    )
    _setup_signals(ctx)
    _init_locale(ctx)
    _init_led(ctx.state)
    _init_fan(ctx.state)
    _init_screen(ctx)
    _init_api(ctx.state)
    _init_status_thread(ctx.state)
    _init_keys(ctx)
    _init_network(ctx)
    _run_boot_to_idle(ctx)
    logger.info("--- 进入主循环 ---")
    try:
        exit_code = _main_loop(ctx)
    finally:
        _cleanup(ctx)
        if lock is not None:
            lock.release()
    return exit_code


def _stop_workers(ctx: AppContext) -> bool:
    state = ctx.state
    state.running = False
    state.status_stop.set()
    stopped = _stop_screen_worker(ctx)
    _remove_live_mark()
    return stopped


def _stop_screen_worker(ctx: AppContext) -> bool:
    if ctx.screen_worker is None:
        return True
    try:
        ok = ctx.screen_worker.stop(timeout=_SCREEN_STOP_TIMEOUT)
        if not ok:
            logger.warning("屏幕工作线程仍在刷新，跳过休眠以避免并发访问 SPI")
        return ok
    except Exception as e:
        logger.warning(f"屏幕线程清理异常: {e}")
        return False


def _remove_live_mark() -> None:
    try:
        if os.path.exists(LIVE_MARK):
            os.remove(LIVE_MARK)
    except OSError as e:
        logger.warning(f"健康标记删除失败: {e}")


def _cleanup_fan(ctx: AppContext) -> None:
    if ctx.state.fan:
        try: ctx.state.fan.cleanup()
        except Exception as e: logger.warning(f"风扇清理异常: {e}")


def _cleanup_screen(ctx: AppContext, ok: bool) -> None:
    if ok and ctx.screen_worker is not None and ctx.screen_worker.screen is not None:
        try: ctx.screen_worker.screen.sleep()
        except Exception as e: logger.warning(f"屏幕休眠异常: {e}")


def _cleanup_keys(ctx: AppContext) -> None:
    if ctx.state.keys:
        try: ctx.state.keys.cleanup()
        except Exception as e: logger.warning(f"按键清理异常: {e}")
    if ctx.state.obtn:
        try: ctx.state.obtn.cleanup()
        except Exception as e: logger.warning(f"板载按键清理异常: {e}")
        ctx.state.obtn = None


def _cleanup_network(ctx: AppContext) -> None:
    if ctx.net_recover is not None:
        try: ctx.net_recover.reset()
        except Exception: pass
    if ctx.switcher is not None:
        try: ctx.switcher.cleanup()
        except Exception: pass


def _cleanup_led(ctx: AppContext) -> None:
    if ctx.state.led:
        try:
            ctx.state.led.all_off()
            ctx.state.led.cleanup()
        except Exception as e: logger.warning(f"LED清理异常: {e}")


def _cleanup_devices(ctx: AppContext, screen_stopped: bool) -> None:
    logger.info("正在清理资源...")
    _cleanup_fan(ctx)
    _cleanup_screen(ctx, screen_stopped)
    _cleanup_keys(ctx)
    _cleanup_network(ctx)
    _cleanup_led(ctx)


def _cleanup(ctx: AppContext) -> None:
    """清理所有资源（快速版 —— 避免阻塞）。"""
    stopped = _stop_workers(ctx)
    _cleanup_devices(ctx, stopped)
    logger.info("ClawBox Peripheral Daemon stopped")


# ============================================================
if __name__ == "__main__":
    raise SystemExit(main())
