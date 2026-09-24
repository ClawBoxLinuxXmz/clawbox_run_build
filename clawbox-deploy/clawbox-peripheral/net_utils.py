"""
ClawBox 外设守护进程 —— 本地网络状态检测
==========================================
不依赖后端 API 的本机网络探测 (IP/主机名/WiFi 模式/SSID)。
命令输出解析逻辑独立成函数, 可在 PC 上 mock subprocess 单测。

注意: 探测命令失败时返回空值/保守结果, 与"真实断连"统一由上层决策,
不在这里抛出异常 (守护进程主循环各段已有独立 try/except)。
"""

import ipaddress
import logging
import re
import socket
import subprocess

from config import DEFAULT_WIFI_IFACE, LOCAL_HOSTNAME_PREFIX, RECOVERY_AP_IFACE
from host_cmds import CMD_HOSTNAME, CMD_IP, CMD_IW, CMD_SYSTEMCTL

logger = logging.getLogger("clawbox.net")


def _run_stdout(command: list[str], timeout: float) -> str:
    """Run a probe command and normalize failures to an unknown result."""
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False,
            # 显式 UTF-8 + replace: 设备 locale 非 UTF-8 或输出含非法字节时,
            # 默认编码解码会抛 UnicodeDecodeError 炸掉读取线程 (2026-08-26 实测)
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("network probe failed (%s): %s", command[0], exc)
        return ""
    if getattr(result, "returncode", 0) != 0:
        logger.debug("network probe exited %s (%s)", result.returncode, command[0])
        return ""
    return result.stdout or ""


def decode_iw_ssid(raw: str) -> str:
    """iw 命令会把非 ASCII 字符输出为 \\xHH 转义序列，解码回 UTF-8。"""
    try:
        latin1 = re.sub(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m.group(1), 16)), raw)
        return latin1.encode('latin-1').decode('utf-8')
    except ValueError:
        # 非 ASCII 字节序列无法转 UTF-8 时原样返回 (UnicodeError 是 ValueError 子类)
        return raw


def get_local_ip(iface: str = DEFAULT_WIFI_IFACE) -> str:
    """获取指定接口 IPv4（不依赖 API），失败时再回退主机地址。"""
    try:
        # 方法1: 使用 socket + fcntl (Linux)
        import fcntl
        import struct
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            packed = struct.pack("256s", iface[:15].encode("utf-8"))
            result = fcntl.ioctl(s.fileno(), 0x8915, packed)  # SIOCGIFADDR
            ip = socket.inet_ntoa(result[20:24])
        return ip
    except (OSError, ImportError):
        # OSError: ioctl/绑定失败; ImportError: 非 Linux 平台无 fcntl, 均回退下一方法
        pass

    # 按接口查询才能区分合法的 172.x WiFi 与容器虚拟网卡。
    stdout = _run_stdout(
        [CMD_IP, "-4", "-o", "addr", "show", "dev", iface, "scope", "global"],
        timeout=3,
    )
    match = re.search(r"\binet\s+(\d+(?:\.\d+){3})/", stdout)
    if match:
        return match.group(1)

    # 最终兜底不猜私网号段，仅排除不能作为设备访问地址的 IPv4。
    for ip in _run_stdout([CMD_HOSTNAME, "-I"], timeout=3).split():
        try:
            addr = ipaddress.IPv4Address(ip)
        except ipaddress.AddressValueError:
            continue
        if not (addr.is_loopback or addr.is_link_local
                or addr.is_multicast or addr.is_unspecified):
            return ip
    return ""


def get_local_hostname() -> str:
    """获取本机主机名; 失败时回退固定前缀, 保证 QR 链接可构造。"""
    try:
        return socket.gethostname()
    except OSError:
        return f"{LOCAL_HOSTNAME_PREFIX}-device"


def detect_wifi_mode() -> str:
    """本地检测 WiFi 模式 (不依赖 API)。返回 "ap" | "client" | ""。

    判定依据: hostapd 服务 active → ap; iw link 有连接 → client。

    注意 (2026-08-11 重构测试发现并修复): 原实现用子串匹配 "active" in stdout,
    而 systemctl is-active 对未运行服务输出 "inactive" —— 其中包含子串 "active",
    导致客户端模式下 hostapd 未运行也会误判为热点。改为白名单精确匹配。
    """
    mode = local_network_mode()
    if mode:
        return mode

    if _run_stdout(
        [CMD_SYSTEMCTL, "is-active", "hostapd"], timeout=2
    ).strip() in ("active", "activating"):
        return "ap"

    stdout = _run_stdout([CMD_IW, "dev", DEFAULT_WIFI_IFACE, "link"], timeout=2)
    if stdout.strip() and ("Connected to" in stdout or "Not connected" not in stdout):
        return "client"

    return ""


def is_ap_interface(iface: str) -> bool:
    """接口是否正以 AP 模式运行；接口不存在或命令失败均返回 False。"""
    return "type AP" in _run_stdout([CMD_IW, "dev", iface, "info"], timeout=3)


def is_wifi_client_connected(iface: str = DEFAULT_WIFI_IFACE) -> bool:
    """客户端接口是否已经关联 WiFi；临时热点接口不参与此判定。"""
    stdout = _run_stdout([CMD_IW, "dev", iface, "link"], timeout=3)
    return bool(stdout.strip() and "Not connected" not in stdout)


def count_ap_clients(iface: str = RECOVERY_AP_IFACE) -> int:
    """返回热点当前关联客户端数；探测失败按 0 处理，避免永久残留临时 AP。"""
    stdout = _run_stdout([CMD_IW, "dev", iface, "station", "dump"], timeout=3)
    return sum(1 for line in stdout.splitlines()
               if line.lstrip().startswith("Station "))


def local_network_mode() -> str:
    """返回用户可感知模式 (client/ap/'')，同时识别独立恢复热点。

    双接口并存时优先报告 client：上游已经恢复，恢复热点只是等待安全撤场。
    """
    if is_wifi_client_connected(DEFAULT_WIFI_IFACE):
        return "client"
    if is_ap_interface(DEFAULT_WIFI_IFACE) or is_ap_interface(RECOVERY_AP_IFACE):
        return "ap"
    return ""


def get_local_wifi_ssid() -> str:
    """本地获取连接的 WiFi SSID (含非 ASCII 解码)。"""
    for line in _run_stdout(
        [CMD_IW, "dev", DEFAULT_WIFI_IFACE, "link"], timeout=2
    ).split("\n"):
        if "SSID:" in line:
            return decode_iw_ssid(line.split("SSID:")[-1].strip())
    return ""
