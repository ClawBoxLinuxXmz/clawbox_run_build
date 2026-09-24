"""单实例 PID 锁：防止 daemon 双实例抢 SPI/GPIO。"""

import fcntl
import logging
import os

logger = logging.getLogger("clawbox.lock")
LOCK_PATH = "/run/clawbox-peripheral.lock"


class DaemonLock:
    def __init__(self, path: str = LOCK_PATH) -> None:
        self.path = path
        self.fd: int | None = None

    def acquire(self) -> bool:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self.fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.ftruncate(self.fd, 0)
            os.write(self.fd, f"{os.getpid()}\n".encode())
            return True
        except OSError as e:
            if self.fd is not None:
                try: os.close(self.fd)
                except OSError:  # best-effort cleanup after a failed acquisition
                    logger.debug("关闭未持有的 PID 锁文件失败", exc_info=True)
                self.fd = None
            if getattr(e, "errno", None) == 11:  # EAGAIN
                try:
                    with open(self.path, encoding="utf-8") as f:
                        holder = f.read().strip()
                except OSError:
                    holder = "unknown"
                logger.error(f"已有守护进程运行 (pid={holder})，拒绝双实例")
            else:
                logger.error(f"PID 锁获取失败: {e}")
            return False

    def release(self) -> None:
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            except OSError:
                logger.debug("释放 PID 锁失败", exc_info=True)
            try:
                os.close(self.fd)
            except OSError:
                logger.debug("关闭 PID 锁文件失败", exc_info=True)
            self.fd = None
