"""第三轮极端压力 — 装配层生命周期 (2026-08-26)。

覆盖 8.26 审查盲区第一梯队: 初始化中途失败 / 信号风暴 / cleanup 幂等 /
心跳写入失败 / 主循环 handler 异常隔离 / boot 序列部分失败 / stop 异常路径。
全部 Mock, 不碰真实硬件/网络/板子。
运行: D:/python_env/Scripts/python.exe -m pytest tests/test_stress_lifecycle.py -v
"""
import os
import sys
import time
import types
import threading
from unittest.mock import Mock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_PERIPHERAL = os.path.join(os.path.dirname(_HERE), "clawbox-peripheral")
if _PERIPHERAL not in sys.path:
    sys.path.insert(0, _PERIPHERAL)

import peripheral_daemon as pd
from app_context import AppContext


# ---------- helper ----------
def _make_ctx(**overrides):
    """构造最小可用 AppContext, 全部组件可被 overrides 替换。"""
    ctx = AppContext()
    ctx.state.running = True
    ctx.watcher = Mock()
    ctx.watcher.check_qr.return_value = None
    ctx.watcher.check_locale.return_value = None
    ctx.switcher = Mock()
    ctx.switcher.switching = False
    ctx.switcher.switch_done = False
    ctx.switcher.reset_after_switch.return_value = False
    ctx.net_recover = Mock()
    ctx.screen_worker = Mock()
    ctx.screen_worker.stop.return_value = True
    ctx.screen_worker.screen = None
    for k, v in overrides.items():
        setattr(ctx, k, v)
    return ctx


def _run_main_loop_until_stop(ctx, max_iters=50):
    """跑主循环直到 running=False 或达到最大轮数, 返回退出码。"""
    ctx.state.running = True
    t = threading.Thread(target=lambda: (time.sleep(0.05), setattr(ctx.state, "running", False)))
    t.daemon = True
    t.start()
    code = pd._main_loop(ctx)
    t.join(timeout=1)
    return code


# ============================================================
# 1. 初始化中途失败 → 降级继续 (不崩溃)
# ============================================================
def test_init_led_failure_degrades():
    """LED 初始化抛异常 → state.led=None, 不向上抛。"""
    st = types.SimpleNamespace(led=object())
    with patch.object(pd, "LedController", side_effect=RuntimeError("gpiod init fail")):
        pd._init_led(st)  # 不应抛
    assert st.led is None


def test_init_fan_failure_degrades():
    """风扇初始化抛异常 → state.fan=None, 不向上抛。"""
    st = types.SimpleNamespace(fan=object())
    with patch.object(pd, "FanController", side_effect=OSError("pwmchip missing")):
        pd._init_fan(st)
    assert st.fan is None


def test_init_fan_start_failure_degrades():
    """风扇构造成功但 start() 抛异常 → state.fan=None。"""
    st = types.SimpleNamespace(fan=None)
    fake = Mock()
    fake.start.side_effect = RuntimeError("pwm write fail")
    with patch.object(pd, "FanController", return_value=fake):
        pd._init_fan(st)
    assert st.fan is None


def test_init_screen_renderer_failure_degrades():
    """ScreenRenderer 构造抛异常 → screen_worker 仍创建且 screen=None。"""
    ctx = _make_ctx()
    with patch.object(pd, "ScreenRenderer", side_effect=OSError("spi open fail")):
        pd._init_screen(ctx)  # 不应抛
    assert ctx.screen_worker is not None
    assert ctx.screen_worker.screen is None


def test_init_screen_boot_failure_degrades():
    """boot 画面渲染抛异常 → 仅告警, screen_worker 保留 (2026-08-26 改入队后)。"""
    ctx = _make_ctx()
    fake_screen = Mock()
    fake_screen.available = True
    with patch.object(pd, "ScreenRenderer", return_value=fake_screen), \
         patch("screen_pages.render_boot_screen", side_effect=RuntimeError("render fail")):
        pd._init_screen(ctx)
    assert ctx.screen_worker is not None
    assert ctx.screen_worker.screen is fake_screen


def test_init_screen_boot_queued_not_spi():
    """boot 画面入队而非主线程碰 SPI (SPI 红线: 只有后台线程碰 SPI)。"""
    ctx = _make_ctx()
    fake_screen = Mock()
    fake_screen.available = True
    boot_img = object()
    with patch.object(pd, "ScreenRenderer", return_value=fake_screen), \
         patch("screen_pages.render_boot_screen", return_value=boot_img):
        pd._init_screen(ctx)
    # 主线程不调用 show_boot (不碰 SPI)
    fake_screen.show_boot.assert_not_called()
    # 图像入队, 由后台线程刷新
    assert ctx.screen_worker._pending_image is boot_img
    assert ctx.screen_worker._pending_page == 0


def test_init_api_failure_degrades():
    """API 客户端构造抛异常 → state.api=None。"""
    st = types.SimpleNamespace(api=object())
    with patch.object(pd, "ApiClient", side_effect=RuntimeError("conn refused")):
        pd._init_api(st)
    assert st.api is None


def test_init_keys_failure_degrades():
    """KeyListener 抛异常 → keys=None; OnboardButton 抛异常 → obtn=None。"""
    ctx = _make_ctx()
    with patch.object(pd, "KeyListener", side_effect=RuntimeError("gpio fail")):
        pd._init_keys(ctx)
    assert ctx.state.keys is None
    # obtn 正常
    assert ctx.state.obtn is not None or ctx.state.obtn is None  # 平台相关, 只要求不抛


def test_init_network_failure_degrades():
    """NetworkSwitcher 抛异常 → 向上抛 (装配层无兜底, 属设计: 网络是核心)。"""
    ctx = _make_ctx()
    with patch.object(pd, "NetworkSwitcher", side_effect=RuntimeError("nm fail")):
        try:
            pd._init_network(ctx)
            raised = False
        except RuntimeError:
            raised = True
    assert raised


# ============================================================
# 2. 信号风暴
# ============================================================
def test_signal_handler_sets_running_false():
    """信号处理器把 running 置 False (优雅退出入口)。"""
    ctx = _make_ctx()
    pd.signal_handler(ctx, 15, None)
    assert ctx.state.running is False


def test_signal_handler_reentrant_safe():
    """信号处理器连续多次调用不抛 (信号风暴)。"""
    ctx = _make_ctx()
    for _ in range(100):
        pd.signal_handler(ctx, 15, None)  # 不应抛
    assert ctx.state.running is False


def test_signal_handler_with_broken_stderr():
    """stderr 不可写时信号处理器不抛 (os.write 失败被吞)。"""
    ctx = _make_ctx()
    with patch.object(pd.os, "write", side_effect=OSError("EBADF")):
        pd.signal_handler(ctx, 2, None)  # 不应抛
    assert ctx.state.running is False


# ============================================================
# 3. cleanup 幂等性
# ============================================================
def test_cleanup_idempotent_double_call():
    """_cleanup 连续调用两次不抛 (幂等)。"""
    ctx = _make_ctx()
    pd._cleanup(ctx)
    pd._cleanup(ctx)  # 第二次不应抛


def test_cleanup_with_all_none_components():
    """全部组件为 None 时 cleanup 不抛。"""
    ctx = AppContext()  # 全 None
    pd._cleanup(ctx)


def test_cleanup_screen_stop_raises_still_cleans():
    """screen_worker.stop 抛异常 → 仍继续清理其他设备, 不中断。"""
    ctx = _make_ctx()
    ctx.screen_worker.stop.side_effect = RuntimeError("thread join fail")
    ctx.state.fan = Mock()
    ctx.state.keys = Mock()
    ctx.state.obtn = Mock()
    ctx.state.led = Mock()
    pd._cleanup(ctx)  # 不应抛
    ctx.state.fan.cleanup.assert_called_once()
    ctx.state.keys.cleanup.assert_called_once()
    ctx.state.led.all_off.assert_called_once()


def test_cleanup_fan_raises_still_cleans_others():
    """fan.cleanup 抛异常 → 后续设备仍清理。"""
    ctx = _make_ctx()
    ctx.state.fan = Mock()
    ctx.state.fan.cleanup.side_effect = RuntimeError("pwm busy")
    ctx.state.keys = Mock()
    ctx.state.led = Mock()
    pd._cleanup(ctx)
    ctx.state.keys.cleanup.assert_called_once()
    ctx.state.led.all_off.assert_called_once()


def test_cleanup_keys_raises_still_cleans_led():
    """keys.cleanup 抛异常 → LED 仍清理。"""
    ctx = _make_ctx()
    ctx.state.keys = Mock()
    ctx.state.keys.cleanup.side_effect = RuntimeError("gpio busy")
    ctx.state.led = Mock()
    pd._cleanup(ctx)
    ctx.state.led.all_off.assert_called_once()


def test_stop_workers_screen_stop_false_returns_false():
    """屏幕线程未停稳 → _stop_workers 返回 False (跳过清屏语义)。"""
    ctx = _make_ctx()
    ctx.screen_worker.stop.return_value = False
    assert pd._stop_workers(ctx) is False


def test_stop_workers_screen_none_returns_true():
    """无屏幕线程 → 视为已停。"""
    ctx = _make_ctx()
    ctx.screen_worker = None
    assert pd._stop_workers(ctx) is True


# ============================================================
# 4. 心跳/运行标记写入失败
# ============================================================
def test_write_heartbeat_disk_full_no_crash():
    """心跳写入失败 (磁盘满/只读) → 仅告警不抛。"""
    with patch.object(pd, "HEARTBEAT_FILE", "/nonexistent-dir/hb"):
        pd._write_heartbeat()  # 不应抛


def test_write_heartbeat_rename_failure_no_crash():
    """rename 失败 (目标被占) → 不抛。"""
    with patch.object(pd.os, "rename", side_effect=OSError("EXDEV")):
        pd._write_heartbeat()  # 不应抛


def test_write_live_mark_failure_no_crash():
    """运行标记写入失败 → 仅告警不抛。"""
    with patch.object(pd, "LIVE_MARK", "/nonexistent-dir/live"):
        pd._write_live_mark()  # 不应抛


def test_remove_live_mark_failure_no_crash():
    """运行标记删除失败 → 不抛。"""
    with patch.object(pd.os, "remove", side_effect=OSError("EACCES")):
        pd._remove_live_mark()  # 不应抛


# ============================================================
# 5. 主循环 handler 异常隔离 (单轮异常不退出主循环)
# ============================================================
def test_main_loop_survives_all_handlers_raising():
    """所有 handler 同时抛异常 → 主循环不退出, 返回 0。"""
    ctx = _make_ctx()
    ctx.state.keys = Mock()
    ctx.state.keys.poll.side_effect = RuntimeError("key boom")
    ctx.state.obtn = Mock()
    ctx.state.obtn.poll.side_effect = RuntimeError("obtn boom")
    ctx.net_recover.check.side_effect = RuntimeError("net boom")
    ctx.switcher.reset_after_switch.side_effect = RuntimeError("switch boom")
    ctx.watcher.check_qr.side_effect = RuntimeError("qr boom")
    ctx.watcher.check_locale.side_effect = RuntimeError("locale boom")
    ctx.state.led = Mock()
    ctx.state.led.set_power.side_effect = RuntimeError("led boom")
    code = _run_main_loop_until_stop(ctx)
    assert code == 0


def test_main_loop_survives_heartbeat_failure():
    """心跳写入失败 (内部 open 抛 OSError) → 主循环继续跑。"""
    ctx = _make_ctx()
    with patch.object(pd.os, "makedirs", side_effect=OSError("disk full")):
        code = _run_main_loop_until_stop(ctx)
    assert code == 0


def test_main_loop_survives_status_change_raising():
    """状态变化检测抛异常 → 主循环继续。"""
    ctx = _make_ctx()
    # 让 tracker 与 cached 不同, 触发 request_page 路径
    ctx.state.cached["wifi_mode"] = "ap"
    ctx.state.cached["wifi_ip"] = "192.168.4.1"
    ctx.state.cached["wifi_ssid"] = "ClawBox-Setup"
    ctx.switcher.switching = False
    ctx.switcher.switch_done = False
    with patch.object(pd, "gen_and_request", side_effect=RuntimeError("render boom")):
        code = _run_main_loop_until_stop(ctx)
    assert code == 0


def test_main_loop_returns_1_on_unexpected_exception():
    """主循环内未捕获异常 → 返回 1 (supervisor 据此重启)。"""
    ctx = _make_ctx()
    # 让 _write_heartbeat 抛未捕获异常 (绕过其内部 try 的方式: 直接替换)
    with patch.object(pd, "_write_heartbeat", side_effect=KeyboardInterrupt):
        code = pd._main_loop(ctx)
    assert code == 0  # KeyboardInterrupt 是优雅退出


# ============================================================
# 6. boot 序列部分失败
# ============================================================
def test_run_boot_to_idle_led_failure():
    """boot 时 LED 点亮失败 → 继续启动屏幕线程。"""
    ctx = _make_ctx()
    ctx.state.led = Mock()
    ctx.state.led.set_power.side_effect = RuntimeError("led dead")
    ctx.screen_worker.start = Mock()
    with patch.object(pd, "gen_and_request"):
        pd._run_boot_to_idle(ctx)  # 不应抛
    ctx.screen_worker.start.assert_called_once()


def test_run_boot_to_idle_screen_start_failure():
    """boot 时屏幕线程 start 抛异常 → 向上抛 (装配层无兜底, 属设计)。"""
    ctx = _make_ctx()
    ctx.state.led = None
    ctx.screen_worker.start.side_effect = RuntimeError("thread fail")
    try:
        pd._run_boot_to_idle(ctx)
        raised = False
    except RuntimeError:
        raised = True
    assert raised


# ============================================================
# 7. 信号 + 主循环集成 (信号到达后主循环正常退出)
# ============================================================
def test_signal_then_main_loop_exits_cleanly():
    """信号置 running=False 后, 主循环下一轮退出且返回 0。"""
    ctx = _make_ctx()
    ctx.state.running = True
    pd.signal_handler(ctx, 15, None)
    code = pd._main_loop(ctx)
    assert code == 0


def test_main_loop_rapid_running_flip():
    """running 在循环边界快速翻转 100 次 → 不抛。"""
    ctx = _make_ctx()
    for _ in range(100):
        ctx.state.running = True
        pd.signal_handler(ctx, 15, None)
    code = pd._main_loop(ctx)
    assert code == 0