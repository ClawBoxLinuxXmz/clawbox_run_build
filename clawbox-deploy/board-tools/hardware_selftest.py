#!/usr/bin/env python3
"""
hardware_selftest.py —— 屏幕/按键/LED 硬件自检（2026-08-27）
============================================================
用途: 外设接好后一键验证 屏幕/按键/LED 功能是否正常。
安全: 必须先停守护进程(否则双实例抢 SPI/GPIO → Device busy/按键失灵),
      测完自动恢复(停止标记契约, 与 restart_daemon.sh 同款)。

用法:
  sudo python3 hardware_selftest.py            # 全测(屏幕+按键+LED)
  sudo python3 hardware_selftest.py --screen   # 只测屏幕
  sudo python3 hardware_selftest.py --keys     # 只测按键
  sudo python3 hardware_selftest.py --led      # 只测 LED
  sudo python3 hardware_selftest.py --no-restore  # 测完不恢复守护进程

流程:
  1. 停止守护进程(停止标记契约, 防双实例)
  2. 屏幕: boot画面 → 棋盘格 → 局域网二维码页 (每页 2 秒, 肉眼确认)
  3. 按键: 10 秒窗口, 按 K1-K4/板载按键, 终端有反馈
  4. LED: 红/黄/绿 依次亮 1 秒
  5. 恢复守护进程(除非 --no-restore)

退出码: 0=全部通过, 1=有失败项
"""

import argparse
import logging
import os
import subprocess
import sys
import time

# ── 路径设置: 本脚本放部署包根目录 板上测试工具/ 下 ──
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DEPLOY_DIR = os.path.dirname(_SCRIPT_DIR)  # 上一级 = 部署包根目录
_PERIPHERAL_DIR = os.path.join(_DEPLOY_DIR, "clawbox-peripheral")
if os.path.isdir(_PERIPHERAL_DIR) and _PERIPHERAL_DIR not in sys.path:
    sys.path.insert(0, _PERIPHERAL_DIR)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("selftest")

STOP_FLAG = "/run/clawbox-peripheral.stop"
SUPERVISOR_CMD = os.path.join(_PERIPHERAL_DIR, "supervisor.sh")
DAEMON_CMD = os.path.join(_PERIPHERAL_DIR, "peripheral_daemon.py")

_results: list = []


def report(name: str, ok: bool, detail: str = "") -> None:
    tag = "✅ PASS" if ok else "❌ FAIL"
    _results.append(ok)
    print(f"  {tag} {name}" + (f"  ({detail})" if detail else ""), flush=True)


def _pids_of(script_path: str, pattern: str) -> list:
    """按命令行参数精确匹配本部署脚本，避免误杀同名进程。"""
    expected = os.path.realpath(script_path)
    out = subprocess.run(
        ["pgrep", "-f", pattern], capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    ).stdout.split()
    pids = []
    for pid in out:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                argv = [
                    arg.decode("utf-8", "replace")
                    for arg in f.read().split(b"\0")
                    if arg
                ]
        except OSError:
            continue
        if any(os.path.realpath(arg) == expected for arg in argv):
            pids.append(pid)
    return pids


def stop_daemon() -> bool:
    """停止标记契约: touch 标记 → 停 supervisor → 停 daemon → 等退出"""
    print("== 停止守护进程 (停止标记契约) ==", flush=True)
    try:
        open(STOP_FLAG, "w").close()
    except OSError as e:
        print(f"  ⚠️ 写停止标记失败: {e}", flush=True)
    for pid in _pids_of(SUPERVISOR_CMD, "[s]upervisor.sh"):
        subprocess.run(["kill", pid], capture_output=True)
    for pid in _pids_of(DAEMON_CMD, "[p]eripheral_daemon.py"):
        subprocess.run(["kill", pid], capture_output=True)
    for _ in range(20):  # 最多等 10s
        if not _pids_of(DAEMON_CMD, "[p]eripheral_daemon.py") and not _pids_of(SUPERVISOR_CMD, "[s]upervisor.sh"):
            print("  ✅ 守护进程已停止", flush=True)
            return True
        time.sleep(0.5)
    print("  ⚠️ 守护进程未完全退出, 继续测试 (风险: 可能抢 GPIO/SPI)", flush=True)
    return False


def restore_daemon() -> None:
    """删标记 → nohup supervisor.sh (与 rc.local 同链路)"""
    print("== 恢复守护进程 ==", flush=True)
    try:
        os.remove(STOP_FLAG)
    except OSError:
        pass
    if os.path.isfile(SUPERVISOR_CMD):
        subprocess.Popen(
            ["nohup", "bash", SUPERVISOR_CMD],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("  ✅ supervisor 已拉起 (守护进程数秒内恢复)", flush=True)
    else:
        print(f"  ⚠️ 找不到 {SUPERVISOR_CMD}, 请手动重启守护进程", flush=True)


# ── 屏幕测试 ──
def test_screen() -> None:
    print("== 屏幕测试 (每页 2 秒, 肉眼确认显示) ==", flush=True)
    try:
        from screen_renderer import ScreenRenderer
        from screen_pages import render_boot_screen, render_page_lan_qr
    except ImportError as e:
        report("屏幕模块导入", False, str(e))
        return

    try:
        renderer = ScreenRenderer()
    except Exception as e:
        report("屏幕初始化", False, str(e))
        return
    if not renderer.available:
        report("屏幕初始化", False, "EPD 不可用 (检查接线/驱动)")
        return
    report("屏幕初始化", True, "EPD 实例可用")

    pages = [
        ("boot 画面", render_boot_screen),
        ("局域网二维码页", lambda: render_page_lan_qr("http://192.168.1.225")),
    ]
    for name, fn in pages:
        try:
            img = fn()
            renderer.show_image(img)
            report(f"显示 {name}", True)
        except Exception as e:
            report(f"显示 {name}", False, str(e))
        time.sleep(2)

    # 棋盘格: 验证像素级渲染 (黑白交替)
    try:
        from PIL import Image
        img = Image.new("L", (152, 152), 255)
        px = img.load()
        for y in range(152):
            for x in range(152):
                if (x // 19 + y // 19) % 2 == 0:
                    px[x, y] = 0
        renderer.show_image(img)
        report("显示棋盘格", True)
    except Exception as e:
        report("显示棋盘格", False, str(e))
    time.sleep(2)

    try:
        renderer.clear()
        report("清屏", True)
    except Exception as e:
        report("清屏", False, str(e))


# ── 按键测试 ──
def test_keys() -> None:
    print("== 按键测试 (10 秒窗口, 请依次按 K1-K4 和板载按键) ==", flush=True)
    try:
        from config import KEYS, KEY_DEBOUNCE_MS, KEY_LONG_PRESS_MS
        from key_listener import KeyListener
        from onboard_button import OnboardButton
    except ImportError as e:
        report("按键模块导入", False, str(e))
        return

    seen: set = set()

    def on_key(key_id: str, event: str) -> None:
        seen.add(key_id)
        print(f"  🎯 按键 {key_id} → {event}", flush=True)

    listeners = []
    try:
        kl = KeyListener(KEYS, on_key, debounce_ms=KEY_DEBOUNCE_MS,
                         long_press_ms=KEY_LONG_PRESS_MS)
        listeners.append(kl)
        report("K1-K4 初始化", True)
    except Exception as e:
        report("K1-K4 初始化", False, str(e))

    try:
        ob = OnboardButton(on_key, debounce_ms=KEY_DEBOUNCE_MS,
                           long_press_ms=KEY_LONG_PRESS_MS)
        if ob.is_available():
            listeners.append(ob)
            report("板载按键初始化", True)
        else:
            report("板载按键初始化", False, "不可用")
    except Exception as e:
        report("板载按键初始化", False, str(e))

    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.1)
    for l in listeners:
        try:
            l.cleanup()
        except Exception:
            pass

    expected = {"k1", "k2", "k3", "k4", "board"}
    missing = expected - seen
    if missing:
        report("按键响应", False, f"未检测到: {sorted(missing)}")
    else:
        report("按键响应", True, "K1-K4 + 板载按键全部响应")


# ── LED 测试 ──
def test_led() -> None:
    print("== LED 测试 (红/黄/绿 依次亮 1 秒, 肉眼确认) ==", flush=True)
    try:
        from config import LEDS
        from led_controller import LedController
    except ImportError as e:
        report("LED 模块导入", False, str(e))
        return

    try:
        led = LedController(LEDS)
    except Exception as e:
        report("LED 初始化", False, str(e))
        return

    steps = [("电源(红)", "set_power"), ("热点(黄)", "set_hotspot"),
             ("WiFi(绿)", "set_wifi")]
    for name, method in steps:
        try:
            getattr(led, method)(True)
            time.sleep(1)
            getattr(led, method)(False)
            report(f"LED {name}", True)
        except Exception as e:
            report(f"LED {name}", False, str(e))
    try:
        led.all_off()
        led.cleanup()
    except Exception:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(description="ClawBox 硬件自检")
    ap.add_argument("--screen", action="store_true", help="只测屏幕")
    ap.add_argument("--keys", action="store_true", help="只测按键")
    ap.add_argument("--led", action="store_true", help="只测 LED")
    ap.add_argument("--no-restore", action="store_true", help="测完不恢复守护进程")
    args = ap.parse_args()

    if os.geteuid() != 0:
        print("请以 root 运行: sudo python3 hardware_selftest.py", file=sys.stderr)
        sys.exit(1)

    only = [args.screen, args.keys, args.led]
    if not any(only):
        args.screen = args.keys = args.led = True

    if not stop_daemon():
        report("停止守护进程", False, "进程未完全退出, 为避免双实例抢占硬件而跳过自检")
        if not args.no_restore:
            restore_daemon()
        sys.exit(1)
    try:
        if args.screen:
            test_screen()
        if args.keys:
            test_keys()
        if args.led:
            test_led()
    finally:
        if not args.no_restore:
            restore_daemon()

    passed = sum(1 for r in _results if r)
    total = len(_results)
    print(f"\n===== 自检完成: {passed}/{total} 通过 =====", flush=True)
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
