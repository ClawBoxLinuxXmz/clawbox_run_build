"""
ClawBox 外设守护进程配置。
所有硬件引脚、路径、时间常量集中管理。
"""

import os

# ============================================================
# 版本号（未成品，统一 1.0）
# ============================================================
VERSION = "1.0"

# ============================================================
# 路径配置
# ============================================================
# 中文字体搜索路径（按优先级排列）
CHINESE_FONT_PATHS = [
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
]

# ============================================================
# 墨水屏配置 (1.54" 黑白 152x152, SSD1680)
# 引脚 (RST/DC/BUSY/GPIO_CHIP) 在 epd-driver/epdconfig.py 的 EpdConfig 默认参数
# ============================================================
EPD_WIDTH = 152
EPD_HEIGHT = 152

# ============================================================
# LED 配置 (三色 LED: 红/黄/绿)
# ============================================================
LEDS = {
    "power": {         # 🔴 红灯 - 开机指示
        "chip": "gpiochip1",
        "line": 38,    # PB6, 物理7脚
        "name": "电源",
    },
    "hotspot": {       # 🟡 黄灯 - 热点模式指示
        "chip": "gpiochip1",
        "line": 46,    # PB14, 物理12脚
        "name": "热点",
    },
    "wifi": {          # 🟢 绿灯 - WiFi已连接指示
        "chip": "gpiochip1",
        "line": 268,   # PI12, 物理13脚
        "name": "WiFi",
    },
}

# ============================================================
# 按键配置 (HS-KEY4B, 4键, 按下=低电平)
# ============================================================
KEYS = {
    "k1": {            # 按键1 → 页面1 (局域网URL)
        "chip": "gpiochip1",
        "line": 267,   # PI11, 物理15脚
        "name": "页面1",
    },
    "k2": {            # 按键2 → 页面2 (聊天渠道)
        "chip": "gpiochip1",
        "line": 266,   # PI10, 物理16脚
        "name": "页面2",
    },
    "k3": {            # 按键3 → 页面3 (WiFi 状态)
        "chip": "gpiochip0",
        "line": 6,     # PL6, 物理29脚 (358-352)
        "name": "页面3",
    },
    "k4": {            # 按键4 → 短按重启 / 长按关机
        "chip": "gpiochip0",
        "line": 5,     # PL5, 物理31脚 (357-352)
        "name": "电源",
    },
}

# ============================================================
# API 配置 (clawbox_linux Next.js 后端)
# ============================================================
# ⚠️ 端口说明: 实际启动链路 rc.local → supervisor.sh → runtime_env.sh 会
#    source /etc/default/clawbox-peripheral 注入 CLAWBOX_API_URL；此处为兜底默认值。
#    改 Next.js 端口只需改 /etc/default 的 CLAWBOX_API_URL 即可，config.py 不需单独修改。
API_BASE_URL = os.environ.get("CLAWBOX_API_URL", "http://127.0.0.1:80")
API_TIMEOUT = 5.0           # HTTP 请求超时(秒)
API_POLL_INTERVAL = 3.0     # 状态轮询间隔(秒)

# ============================================================
# 按键参数
# ============================================================
KEY_POLL_INTERVAL = 0.03    # 按键扫描间隔(秒) —— 30ms 快速响应
KEY_DEBOUNCE_MS = 60        # 去抖时间(毫秒)
KEY_LONG_PRESS_MS = 3000    # 长按判定时间(毫秒) - K4关机用

# ============================================================
# 网络模式切换 (板载按键触发)
# ============================================================
# 强制热点标记由板载按键写入；存在时用户选择优先，自动恢复不得撤销热点。
CLAWBOX_ROOT = os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox")
FORCE_AP_FLAG = os.path.join(CLAWBOX_ROOT, "data", "force_ap")
# 临时热点使用独立虚拟接口，避免重连 WiFi 时反复拆掉用户正在使用的热点。
RECOVERY_AP_IFACE = os.environ.get("CLAWBOX_RECOVERY_AP_IFACE", "wlan0ap")
# 网络切换脚本 (与守护进程同目录部署, 见 network_action.sh)
NETWORK_ACTION_SCRIPT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "network_action.sh"
)

# ============================================================
# 断网自动恢复 (独立 AP + NetworkManager 后台自动重连)
# ============================================================
# 先给 NetworkManager 一次快速重连机会，超时后才创建不抢占 wlan0 的临时热点。
NET_RECOVER_GRACE_MS = 5000
# WiFi 连稳后再撤临时热点，避免信号抖动造成热点反复出现/消失。
NET_RECOVER_CLIENT_STABLE_S = 10
# 热点仍有客户端时优先保证配置会话；超过上限才撤掉，避免开放热点永久残留。
NET_RECOVER_AP_CLIENT_GRACE_S = 600
# 检测节流(秒): 主循环与恢复线程共用的低频探测节奏。
NET_RECOVER_CHECK_INTERVAL = 1.0
# 单次网络切换的保护超时(秒): network_action.sh 异常挂起时, 恢复线程不无限等
# 待切换完成, 超时即放弃本轮 (原 hardcode 130.0, 2026-08-25 审查 P4)。
NET_RECOVER_SWITCH_TIMEOUT_S = 130.0

# ============================================================
# 屏幕语言同步 (网页端语言 → 墨水屏)
# ============================================================
# 前端语言变化时经 POST /setup-api/locale 写入此文件:
#   {"locale": "en", "updated_at": ...}
# locale 为前端原样透传的代码 (en/zh-CN/ko/ru/...), 不做白名单;
# 守护进程读取后由 screen_pages.resolve_screen_locale() 决定屏幕用哪套文案
# (21 种语言, 见 screen_pages.SUPPORTED_LOCALES; 未知语种回退英文)
LOCALE_TRIGGER_FILE = os.path.join(
    os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox"),
    "data", "locale.json",
)
# 无语言文件/内容无效时屏幕默认语言 (保持历史中文行为)
DEFAULT_SCREEN_LOCALE = "zh-CN"

# ============================================================
# 屏幕参数
# ============================================================
# 黑白屏支持局刷（SSD1680 芯片级支持，官方例程 0x22=0xDC，~0.5s/次；
# 2026-08-10 官方资料实证）。局刷残留残影 → 每局刷 PARTIAL_REFRESH_EVERY 次
# 后全刷 1 次清除；局刷模式空闲超时自动休眠省电（下次刷新自动重新打底）。
PARTIAL_REFRESH_EVERY = 9        # 每 N 次局刷后全刷 1 次清残影
PARTIAL_IDLE_TIMEOUT = 60.0      # 局刷模式空闲超时(秒)，超时休眠省电

# ============================================================
# 二维码参数
# ============================================================
QR_SIZE = 124               # QR码像素尺寸 (152屏适配; 页面2去掉底部提示文字后最大化)
QR_BOX_SIZE = 5             # 每个小格像素数
QR_BORDER = 2               # 边框格数

# WhatsApp 图片型二维码有效时长(毫秒): Baileys 配对码由服务器每 ~20s 轮换,
# 新登录首码 ~60s; 墨水屏静态快照超过此时长即死码, 自动切过期提示页(页面4)
# (2026-08-07 实测: 03:06:04 出码 → 03:07:04 起每 20s 轮换)
QR_EXPIRE_MS = 60_000
# 过期提示页编号 (页面0说明/1局域网/2聊天渠道/3WiFi; 4 = 二维码已失效提示)
PAGE_QR_EXPIRED = 4

# QR 触发器文件（Next.js 生成平台二维码后写入 → 守护进程检测 mtime 即时刷新）
# 内容格式: {"platform": "wechat"|"feishu"|"qqbot"|"whatsapp"|...,
#            "qr_type": "url"|"image", "qr_url": "...", "updated_at": ...}
#   qr_type="url"   → qr_url 为可编码字符串 (微信/飞书/QQ), qrcode 库生成二维码
#   qr_type="image" → qr_url 为 data:image/png;base64 图片 (WhatsApp), 图片直显
QR_TRIGGER_FILE = os.path.join(
    os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox"),
    "data", "chat-qr.json",
)
# 旧版微信触发文件（升级前旧前端只写此文件，无 platform 字段，默认视为 wechat，向后兼容）
QR_TRIGGER_FILE_LEGACY = os.path.join(
    os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox"),
    "data", "wechat-qr.json",
)

# ============================================================
# 聊天平台显示名 (页面2 二维码标题)
# ============================================================
# 触发文件 platform 字段 → 墨水屏页面2 标题文字, 按屏幕语言分组。
# 语言键与 screen_pages.SUPPORTED_LOCALES 一致; 未知语言回退 "en"。
# 新增平台时只需在两组映射中添加，守护进程无需改动
CHAT_PLATFORM_NAMES = {
    "zh-CN": {
        "wechat": "微信",
        "feishu": "飞书",
        "qqbot": "QQ",
        "whatsapp": "WhatsApp",
        "telegram": "Telegram",
        "line": "LINE",
        "discord": "Discord",
        "zalo": "Zalo",
        "zalouser": "Zalo 个人",
        "zalo-clawbot": "Zalo ClawBot",
        "signal": "Signal",
        "wecom": "企业微信",
    },
    "zh-TW": {
        "wechat": "微信",
        "feishu": "飛書",
        "qqbot": "QQ",
        "whatsapp": "WhatsApp",
        "telegram": "Telegram",
        "line": "LINE",
        "discord": "Discord",
        "zalo": "Zalo",
        "zalouser": "Zalo 個人",
        "zalo-clawbot": "Zalo ClawBot",
        "signal": "Signal",
        "wecom": "企業微信",
    },
    "en": {
        "wechat": "WeChat",
        "feishu": "Feishu",
        "qqbot": "QQ",
        "whatsapp": "WhatsApp",
        "telegram": "Telegram",
        "line": "LINE",
        "discord": "Discord",
        "zalo": "Zalo",
        "zalouser": "Zalo Personal",
        "zalo-clawbot": "Zalo ClawBot",
        "signal": "Signal",
        "wecom": "WeCom",
    },
}

# ============================================================
# 风扇温控配置 (PWM 风扇)
# ============================================================
# PWM 控制器和通道（对应设备树 mcu_pwm0, channel=5）
# 核桃派2B 上 mcu_pwm0 → pwmchip22 (npwm=8)
# 若非 pwmchip22，fan_controller 会自动探测
# 支持环境变量覆盖，方便适配不同风扇型号：
#   FAN_PWM_CHIP=0 FAN_PWM_CHANNEL=3 python3 peripheral_daemon.py
FAN_PWM_CHIP = int(os.environ.get("FAN_PWM_CHIP", "22"))      # pwmchip22 (7103000.mcu_pwm0)
FAN_PWM_CHANNEL = int(os.environ.get("FAN_PWM_CHANNEL", "5"))  # pwm5
FAN_PWM_PERIOD_NS = 10000   # 100kHz (与设备树 period 一致)
FAN_PWM_MAX_DUTY = 9999     # 最大占空比 (period - 1)

# 温度传感器路径 (Allwinner T527 thermal zone)
FAN_TEMP_SENSOR = "/sys/class/thermal/thermal_zone0/temp"

# 温度检测间隔(秒)
FAN_CHECK_INTERVAL = 3.0

# 温度 → 占空比 映射表 [(温度阈值°C, 占空比百分比), ...]
# 温度低于第一个阈值时风扇停转，超过最后一个阈值时全速
# 相邻档位之间线性插值
# 2026-08-25 实机标定 (100kHz 修复后): 13% 不转 / 14% 起转 → 保险 20% 起步
FAN_SPEED_CURVE = [
    (40, 20),    # 40°C: 20% 启动 (保证 40°C 就能转)
    (60, 100),   # 60°C: 达到顶峰全速 (40~60°C 线性)
]

# 最低有效占空比(%)：100kHz 修复后实测 14% 起转, 取 20% 保险
FAN_MIN_EFFECTIVE_DUTY = 20

# 启动/停止回差(°C)：启动温度比停止温度高这么多，防止频繁启停
# 例如：需要30% duty时对应~55°C启动，温度降到55-8=47°C才停止
FAN_START_STOP_HYSTERESIS = 8
# 温度回滞(°C)：温度下降时需低于阈值这么多才降速，避免频繁切换
FAN_HYSTERESIS = 3

# 抗抖动参数 (2026-08-12 审计 OBS-02: 温度噪声致 30%↔36% 每 3s 抖动+日志泛滥)
# 占空比死区(%): 目标与已应用占空比相差小于此值不变速 (吸收温度噪声抖动)
FAN_DUTY_DEAD_BAND = 8.0
# 最小保持采样数: 目标须持续超出死区 N 个控制周期才应用 (拒绝单点温度尖峰)
FAN_MIN_HOLD_SAMPLES = 2
# 温度方向判定死区(°C): 温度变化超过此值才翻转升/降温方向 (抑制方向抖动)
FAN_TEMP_DIRECTION_DEAD_BAND = 0.5
# 风扇日志心跳间隔(秒): 实际占空比不变时每 N 秒打一条存活日志 (防日志泛滥)
FAN_LOG_HEARTBEAT_INTERVAL = 300.0

# ============================================================
# 网络检测
# ============================================================
DEFAULT_WIFI_IFACE = "wlan0"
LOCAL_HOSTNAME_PREFIX = "clawbox"
MDNS_DOMAIN = "local"

# ============================================================
# 运行标记与心跳 (状态观测 + 卡死检测)
# ============================================================
# live 仅作“是否在跑”的存在性探测；heartbeat 为每轮主循环刷新的
# 单调时钟时间戳，供 supervisor 判定“进程活但卡死”。
LIVE_MARK = os.environ.get("CLAWBOX_LIVE_MARK", "/run/clawbox-peripheral.live")
HEARTBEAT_FILE = os.environ.get("CLAWBOX_HEARTBEAT_FILE", "/run/clawbox-peripheral.heartbeat")
HEARTBEAT_STALE_S = 30.0    # 超过视为卡死
HEARTBEAT_GRACE_S = 60.0    # 启动后宽限期
