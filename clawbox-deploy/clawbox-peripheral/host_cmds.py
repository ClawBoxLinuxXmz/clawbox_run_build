"""
ClawBox 外设守护进程 —— 系统命令路径解析
==========================================
核桃派各发行版命令位置不一 (hostname/ip/systemctl/iw/shutdown/reboot),
统一解析一次, 供网络检测与电源管理复用, 避免每次调用重复探测。
"""

import os
import shutil


def resolve_command(name: str, *candidates: str) -> str:
    """按候选路径 + PATH 顺序找到可用命令; 找不到时原样返回 name
    (交给 subprocess 在运行时报错, 比静默失败更易排查)。"""
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return shutil.which(name) or name


CMD_HOSTNAME = resolve_command("hostname", "/usr/bin/hostname", "/bin/hostname")
CMD_IP = resolve_command("ip", "/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip")
CMD_SYSTEMCTL = resolve_command("systemctl", "/usr/bin/systemctl", "/bin/systemctl")
CMD_IW = resolve_command("iw", "/usr/sbin/iw", "/sbin/iw", "/usr/bin/iw")
CMD_SHUTDOWN = resolve_command("shutdown", "/usr/sbin/shutdown", "/sbin/shutdown")
CMD_REBOOT = resolve_command("reboot", "/usr/sbin/reboot", "/sbin/reboot")
