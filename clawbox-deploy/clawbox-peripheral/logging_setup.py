"""
ClawBox 外设守护进程 —— 日志配置
=================================
进程内自轮转日志 (RotatingFileHandler, rename 模式), 不依赖外部 logrotate。

背景(2026-08-11 实机复现): 原实现输出到 stdout 由外部 logrotate copytruncate
轮转, 与进程启动竞态会吞掉启动初始化日志(开机后 banner/初始化序列不在任何
日志文件)。进程内自轮转不依赖外部工具, 启动日志永不因轮转丢失。
"""

import logging
import logging.handlers
import os
import sys

from validation import env_int

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
LOG_DATE_FORMAT = "%H:%M:%S"

LOG_FILE = os.environ.get("CLAWBOX_LOG_FILE", "/var/log/clawbox-peripheral.log")
# 非法值回退默认, 避免笔误的环境变量在 import 阶段抛 ValueError 崩掉进程
LOG_MAX_BYTES = env_int("CLAWBOX_LOG_MAX_BYTES", 5 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024)
LOG_BACKUP_COUNT = env_int("CLAWBOX_LOG_BACKUP_COUNT", 3, 0, 100)


def setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    root = logging.getLogger()
    # 清理可能已挂上的默认 handler (防御: 本函数只调用一次, 保证幂等)
    for h in list(root.handlers):
        root.removeHandler(h)
        try:
            h.close()
        except OSError:
            pass
    fmt = logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT)

    # 主日志: 进程内自轮转写文件 (唯一文件通道, 见模块注释)
    try:
        fh = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
        fh.setLevel(level)
        fh.setFormatter(fmt)
        root.addHandler(fh)
    except OSError as e:
        # 日志文件不可写时退回 stdout, 避免完全无日志
        print(f"warning: 日志文件不可用 {LOG_FILE}: {e}", file=sys.stderr)

    # --debug: 额外输出到 stdout 便于前台调试
    if verbose:
        sh = logging.StreamHandler(sys.stdout)
        sh.setLevel(logging.DEBUG)
        sh.setFormatter(fmt)
        root.addHandler(sh)

    root.setLevel(level)
    # 抑制 gpiod 内部的调试噪音
    logging.getLogger("gpiod").setLevel(logging.WARNING)
