"""
ClawBox 外设守护进程 —— 装配上下文
====================================
把 peripheral_daemon.py 旧版的模块级全局 (_state/_watcher/_screen_worker/
_switcher/_net_recover) 收敛为单一装配上下文对象, 由 main() 创建并填充,
回调通过 lambda 包装捕获, 模块级不再有任何可变全局。

约定:
  - state: DaemonState (共享运行时状态容器, 见 daemon_state.py)
  - watcher/screen_worker/switcher/net_recover: 装配组件, 初始化失败容忍
    (None = 不可用), 与 daemon_state 的外设句柄约定一致
"""

from typing import TYPE_CHECKING, Optional

from daemon_state import DaemonState

if TYPE_CHECKING:
    from net_auto_recover import NetworkAutoRecover
    from net_switcher import NetworkSwitcher
    from screen_worker import ScreenWorker
    from triggers import TriggerWatcher


class AppContext:
    """守护进程装配上下文 (main() 创建, 经 lambda 捕获传给回调, 不跨模块共享)。

    为什么用独立容器而不是塞进 DaemonState: DaemonState 是"跨线程共享的
    运行时状态", 而 watcher/screen_worker/switcher/net_recover 是"装配组件",
    职责不同; 分开后状态容器保持轻量, 装配层只负责把组件组装起来。
    """

    def __init__(self) -> None:
        self.state = DaemonState()
        self.watcher: Optional["TriggerWatcher"] = None
        self.screen_worker: Optional["ScreenWorker"] = None
        self.switcher: Optional["NetworkSwitcher"] = None
        self.net_recover: Optional["NetworkAutoRecover"] = None