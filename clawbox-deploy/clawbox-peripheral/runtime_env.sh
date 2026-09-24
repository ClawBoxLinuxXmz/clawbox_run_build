#!/usr/bin/env bash
# 统一加载外设守护进程环境。所有非 systemd 启动入口都 source 本文件，
# 避免 /etc/default 已更新、实际 Python 进程仍使用代码默认值。

CLAWBOX_ENV_FILE="${CLAWBOX_ENV_FILE:-/etc/default/clawbox-peripheral}"

if [ -r "$CLAWBOX_ENV_FILE" ]; then
    set -a
    # /etc/default 由 root 创建并按 shell KEY=VALUE 格式维护。
    # shellcheck disable=SC1090
    if ! . "$CLAWBOX_ENV_FILE"; then
        set +a
        echo "[clawbox-env] 无法加载环境配置: $CLAWBOX_ENV_FILE" >&2
        return 1 2>/dev/null || exit 1
    fi
    set +a
fi

