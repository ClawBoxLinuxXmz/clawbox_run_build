# ClawBox 部署包 v1.0

> 适用设备：核桃派 2B（Allwinner T527）。
> 屏幕：1.54" 黑白墨水屏 (SSD1680, 152×152)

---

## 文件夹结构

```
clawbox-deploy/
├── README.md
├── clawbox-peripheral/              ← 外设守护进程 + 墨水屏驱动
│   ├── install.sh                    ← 一键部署（一个命令装完驱动+守护进程）
│   ├── epd-driver/                   ← 墨水屏底层驱动
│   │   ├── epdconfig.py              ← 核桃派 GPIO/SPI 适配层 (EpdConfig 类, 实例持有句柄)
│   │   └── epd1in54_152.py          ← SSD1680 152×152 B&W 驱动 (1.1, EPD 接收 EpdConfig)
│   ├── config.py                     ← 配置中心 (单一数据源)
│   ├── peripheral_daemon.py         ← 主守护进程 (装配层: 初始化+主循环, ≤1000行)
│   ├── app_context.py               ← 装配上下文 (收敛模块级全局, 回调经 lambda 注入)
│   ├── daemon_state.py              ← 共享运行时状态容器 (替代旧版 _g_* 全局)
│   ├── validation.py                ← 输入校验纯函数 (QR URL/data URL/环境变量)
│   ├── net_utils.py                 ← 本地网络探测 (IP/主机名/WiFi 模式/SSID)
│   ├── triggers.py                  ← QR/语言触发文件监听 (mtime+校验+损坏清理)
│   ├── screen_worker.py             ← 屏幕生产者-消费者线程 (主线程生成, 后台只做SPI)
│   ├── net_switcher.py              ← 手动/自动网络动作状态机 + LED 切换反馈
│   ├── net_auto_recover.py          ← 无中断恢复 (独立热点接口 + NM 后台自动重连)
│   ├── power.py                     ← 关机/重启公共动作
│   ├── status.py                    ← 状态拉取 (API 优先, 本地兜底)
│   ├── page_render.py               ← 页面图像生成 (各页面 PIL Image)
│   ├── logging_setup.py             ← 日志配置 (进程内自轮转)
│   ├── host_cmds.py                 ← 系统命令路径解析 (hostname/iw/systemctl/…)
│   ├── fan_curve.py                 ← 温控曲线纯计算 (fan_controller/fan_monitor 共享)
│   ├── fan_sysfs.py                 ← 风扇 sysfs 读取/探测 + FanSysfs 操作层 (解绑/初始化/还原)
│   ├── screen_renderer.py           ← B&W 渲染器
│   ├── screen_pages.py              ← 页面渲染（说明页+3页+启动画面）
│   ├── screen_fonts.py              ← 按界面语言/动态文字字符集选择字体
│   ├── screen_text.py               ← 小字轻量增重 + 多行宽度排版
│   ├── font_bitmap.py               ← 取模位图渲染 (每字符独立取模, 小字号更清晰)
│   ├── screen_strings.py            ← 墨水屏 21 种语言文案
│   ├── fan_controller.py            ← PWM 风扇温控
│   ├── fan_monitor.py               ← 风扇实时监控工具
│   ├── key_listener.py              ← 外接按键监听 (K1-K4)
│   ├── onboard_button.py            ← 板载按键监听 (PB7, 直接读PIO寄存器)
│   ├── network_action.sh            ← WiFi/AP 切换与独立恢复热点动作
│   ├── supervisor.sh                ← 监督者: 无停止标记总是拉起(0/非零/信号), 有标记才退出
│   ├── runtime_env.sh               ← rc.local/手动重启统一加载 /etc/default
│   ├── led_controller.py            ← 三色 LED 控制
│   ├── api_client.py                ← Next.js 后端 API 客户端
│   ├── qr_generator.py              ← QR 码生成
│   ├── clawbox-peripheral.service   ← systemd 服务文件
│   └── restart_daemon.sh            ← 重启守护进程脚本（见"六、日常管理"）
├── tests/                           ← PC 端单元测试 (纯逻辑, 不访问硬件)
│   ├── conftest.py                  ← sys.path 指向 clawbox-peripheral
│   ├── test_validation.py           ← QR 校验/环境变量解析
│   ├── test_triggers.py             ← 触发文件监听
│   ├── test_net_utils.py            ← 网络探测 (mock subprocess)
│   ├── test_net_switcher.py         ← 网络切换状态机
│   ├── test_net_auto_recover.py     ← 断网自动恢复检测器
│   ├── test_screen_pages.py         ← 语言映射/排版/冒烟
│   ├── test_screen_worker.py        ← 屏幕线程 (版本号/失败重初始化)
│   ├── test_fan.py                  ← 温控曲线/档位映射
│   └── (运行: cd tests && python -m pytest -q)
> `frontend-patch/`、`frontend-systemd/`、`板上测试工具/` 均已归档到
> `archive/2026-08-12_clawbox-deploy工具归档/`（保留原相对路径，见"四"）。
```

---

## 一、安装

```bash
# 1. 上传部署包
scp -r clawbox-deploy root@<IP>:/home/clawbox/

# 2. 一键安装（墨水屏驱动 + 外设守护进程）
ssh root@<IP>
cd /home/clawbox/clawbox-deploy/clawbox-peripheral && sudo bash install.sh
```

> ⚠️ 前端 AP/连WiFi 脚本 (start-ap.sh / stop-ap.sh) 随**前端源码包**一起分发
> (见 `frontend/src/scripts/`)，部署前端时自动落到
> `/home/clawbox/clawbox/scripts/`。2026-08-05 修复了其中的 awk bug：
> `$2 == "wifi"` 匹配不到任何连接(nmcli 的 WiFi 类型是 `802-11-wireless`)，
> 导致"优先连已保存WiFi"逻辑从未生效，每次开机都强制开热点。
> 另注意：前端重部署时 scripts/ 目录曾整个丢失，导致 clawbox-ap.service
> 开机 203/EXEC 失败。若 scripts/ 丢失，从 `frontend/src/scripts/`
> 复制回 `/home/clawbox/clawbox/scripts/` 并 `chmod +x` 即可。

---

## 二、前端源码内置能力

> **重要更新（2026-08-04 起）**：`code_260728` 新版源码已**直接内置**以下前端改动，
> 部署后**不再需要**旧的多平台二维码 `frontend-patch/` 脚本：
>   1. `src/lib/notify-daemon.ts` 共享模块已随源码分发
>   2. 微信/飞书/QQ/WhatsApp 4 个 `qrcode` route 已直接注入 `notifyDaemonChatQr()` 调用
>   3. `setup-api/ai-models/configure/route.ts` 已修复 AI Key 写入 OpenClaw **SQLite**
>      （旧逻辑只写 auth-profiles.json，OpenClaw 运行时不读 → 网页配 Key 永不生效/网关 401）
>   4. `setup-api/openclaw/runtime-data` 已提供 OpenClaw 运行数据清理：清聊天/会话/运行缓存，
>      保留 WiFi、AI Key、聊天渠道账号和基础配置；服务启动时也会自动清理 30 天前的运行痕迹。
>   5. 前端“System Update”按钮已替换为“Clear OpenClaw Data”；OpenClaw 更新入口按讨论删除。
>
> 需要以脚本方式修改前端源码的场合（如 `start-ap.sh` 的 force_ap 检测），
> 见下方 **四、frontend-patch（已归档）**。

### 构建部署（内置后同标准流程）

```bash
cd /home/clawbox/clawbox
rm -rf .next
npm install
npm run build
# 重启 Next.js（systemctl restart clawbox-setup）
```

### 触发文件格式（`/home/clawbox/clawbox/data/chat-qr.json`）

```json
{ "platform": "feishu", "qr_type": "url", "qr_url": "https://...", "updated_at": 1754200000000 }
```

- `platform` 取值与守护进程 `config.py` 的 `CHAT_PLATFORM_NAMES` 键名一致（wechat/feishu/qqbot/whatsapp），
  平台显示名按屏幕语言分组（`zh-CN` / `zh-TW` / `en`）
- `qr_type`：
  - `url`（默认）：`qr_url` 为可编码字符串 → 墨水屏用 qrcode 库生成二维码（微信/飞书/QQ）
  - `image`：`qr_url` 为 `data:image/png;base64,...` 图片 → 墨水屏图片直显（WhatsApp）
- 守护进程同时兼容旧版 `wechat-qr.json`（无 `platform`/`qr_type` 字段 → 默认 `wechat`/`url`）

### 语言触发文件（`/home/clawbox/clawbox/data/locale.json`）

```json
{ "locale": "ko", "updated_at": 1754200000000 }
```

- 前端语言变化（含首次加载解析出的语言）经 `POST /setup-api/locale` 写入，
  `locale` 为浏览器原样透传的语言代码（en/zh-CN/ko/ru/…），前端不做白名单限制
- 守护进程主循环检测 mtime → `screen_pages.resolve_screen_locale()` 映射：
  支持 21 种语言（与前端 i18n.config.ts 对齐）：中文按简繁细分（`zh-CN`/`zh-TW`，
  zh-HK/zh-MO/zh-Hant 归入 `zh-TW`，pt-BR 归入 `pt`），其余
  en/ja/ko/es/de/fr/pt/it/ru/nl/pl/vi/hi/ar/tr/uk/id/fa/th；未知语种回退英文
  （152px 屏"先放得下、再达意"）
- 界面文案按语言自动选择：简繁中/日/en 用 wqy-zenhei，韩文优先 Noto CJK，
  拉丁/西里尔/越南语系用 DejaVu Sans，阿拉伯/波斯用 Noto Sans Arabic（RTL 渲染），
  泰文用 Noto Sans Thai，印地文用 Noto Sans Devanagari（`install.sh` 装 fonts-noto-core）；
  SSID 等动态文字另按自身字符集选择字体，不会因界面语言不同把中文画成方框
- 简中/繁中/日/英说明页保留各自调优布局，其余 17 种语言使用紧凑按键列表；
  所有页面按真实字体测宽自动选字号，常规文字不低于 12px，避免截断和右侧溢出
- 页面3的 SSID 优先以 17→14px 在两行内完整显示，不再为强塞单行缩到 11px；
  两行仍放不下才在第二行省略。≤13px 的必要小字使用 8×渲染后缩回，得到约
  0.125px 的轻量增重，只作用于文字，不改变二维码与几何线条
- 语言变化时守护进程重绘当前页（局刷 ~0.5s，每 9 局刷 + 1 全刷清残影，见 config.py
  的 PARTIAL_REFRESH_EVERY）；守护进程重启会从该文件恢复上次语言

### 数据流

```
网页 "获取二维码" → POST /setup-api/wechat/qrcode
               或 /setup-api/channels/{feishu,qqbot,whatsapp}/qrcode
  → 平台 QR 会话生成 qrUrl (微信/飞书/QQ) 或 qrDataUrl 图片 (WhatsApp)
  → notifyDaemonChatQr(platform, qrUrl[, qrType]) 写 chat-qr.json
  → 外设守护进程主循环检测 mtime → 即时刷新页面 2（标题 = 平台名）
```

### 平台覆盖（4 平台全覆盖）

| 平台 | route | platform | qr_type | 墨水屏渲染 |
|------|-------|----------|---------|-----------|
| 微信 | `wechat/qrcode` | `wechat` | `url` | qrcode 库生成 |
| 飞书 | `channels/feishu/qrcode` | `feishu` | `url` | qrcode 库生成 |
| QQ | `channels/qqbot/qrcode` | `qqbot` | `url` | qrcode 库生成 |
| WhatsApp | `channels/whatsapp/qrcode` | `whatsapp` | `image` | 图片直显 |

> Telegram / LINE 无二维码接口（无法生成二维码），不接入。

---

## 三、守护进程与前后端的联系

> 守护进程（`clawbox-peripheral`，Python）是唯一直接操作硬件（屏幕/LED/按键/风扇）的进程；
> 前端（Next.js `clawbox`，:80）既是网页也是后端 API；OpenClaw 网关（:18789）提供聊天渠道。
> 守护进程不直接连 OpenClaw，统一经 **共享数据目录 `/home/clawbox/clawbox/data/`** 与 **HTTP API**
> 同前端/脚本协作。下面是全部联结点（2026-08-25 整理）。

### 3.1 联结点总览

| 方向 | 通道 | 文件/接口 | 内容 | 触发方 → 消费方 |
|------|------|-----------|------|-----------------|
| 状态拉取 | HTTP | `GET /setup-api/{setup,wifi,system}/status` | 设置状态/WiFi(SSID,IP,模式)/主机名/accessUrl | 守护进程 3s 轮询 → 前端 |
| 二维码指令 | 文件 | `data/chat-qr.json` | `{platform, qr_type, qr_url, updated_at}` | 前端 `notifyDaemonChatQr()` → 守护进程刷页面2 |
| 语言同步 | 文件 | `data/locale.json` | `{locale, updated_at}` | 前端 `POST /setup-api/locale` → 守护进程重绘当前页 |
| 兼容触发 | 文件 | `data/wechat-qr.json` | 旧版微信二维码（无 platform） | 旧前端 → 守护进程（向后兼容） |
| 共享配置 | 文件 | `data/config.json` | 设备配置（WiFi/渠道等） | 前端 `config-store.ts` 读写；`start-ap.sh` 读取 |
| 设备标识 | 文件 | `data/device-identity.json` | 设备唯一标识/accessUrl | 前端 `device-identity.ts` 读写 |
| 网络环境 | 文件 | `data/network.env` | 网络环境变量 | 前端 setup/reset 保留；网络脚本读取 |
| 强制热点 | 文件 | `data/force_ap` | 用户手动选择热点标记 | 板载按键/`network_action.sh` 写；`start-ap.sh` 检测 |
| 网络动作 | 脚本 | `scripts/start-ap.sh` / `stop-ap.sh` | AP 开关 | 守护进程 `network_action.sh` 调用（前端源码分发） |

### 3.2 守护进程 → 前端（HTTP 状态轮询）

- 每 `API_POLL_INTERVAL`（3s）经 `api_client.ApiClient` 拉状态（`status.status_poll_loop`）：
  `GET /setup-api/setup/status`、`GET /setup-api/wifi/status`、`GET /setup-api/system/info`。
- API 不可达（探测超时 2s）→ 本地兜底（`net_utils` 读 IP/主机名、`ip` 命令判 WiFi/热点模式），
  页面3（WiFi 状态）与说明页据此渲染。
- 基地址 `API_BASE_URL` 默认 `http://127.0.0.1:80`，由 `/etc/default/clawbox-peripheral` 的
  `CLAWBOX_API_URL` 覆盖（改端口只改此文件，`config.py` 不需动）。

### 3.3 前端 → 守护进程（触发文件，mtime 检测）

- `notify-daemon.ts` 原子写（临时文件 + `rename`）到 `data/chat-qr.json` / `data/locale.json`。
- 守护进程 `triggers.TriggerWatcher` 按 mtime 基线检测新写入 → 主循环
  `_handle_qr_trigger` / `_handle_locale_trigger` → 生成图像 → `screen_worker` 刷屏。
- 二维码数据流：网页“获取二维码” → `POST /setup-api/{wechat, channels/feishu, channels/qqbot, channels/whatsapp}/qrcode`
  → 网关生成会话/二维码 → `notifyDaemonChatQr()` → 守护进程刷页面 2（详见第二章“数据流”）。

### 3.4 共享数据目录（前端与守护进程/脚本共同读写）

- 统一根 `/home/clawbox/clawbox`：前端 `CONFIG_ROOT` 与守护进程 `CLAWBOX_ROOT` 同值（均可经
  环境变量覆盖）；`data/` 权限 0770、属主 `clawbox`。
- `config.json`：前端 `config-store.ts` 读写（`.tmp`+rename 防损坏）；`start-ap.sh` 判断
  “是否已配置 WiFi”时读取。
- `force_ap`：板载按键/`network_action.sh` 写（存在=开机强制热点），`start-ap.sh` 检测；
  守护进程 `net_switcher` 也会读写（用户选择优先于自动恢复）。

### 3.5 网络动作调用链

```
板载按键(PB7) 长按/短按
  → 守护进程 onboard_button → network_action.sh（clawbox-peripheral 内）
      ├── 切热点: 写 data/force_ap + 调 scripts/start-ap.sh（前端源码分发）
      └── 切 WiFi: 清 force_ap + 调 scripts/stop-ap.sh + 交 NetworkManager
守护进程 net_auto_recover：断网 >5s → wlan0ap 临时热点 → 连稳 10s 撤掉
```

### 3.6 与 OpenClaw 网关（:18789）的间接联系

- 守护进程**不直接**访问 OpenClaw；聊天二维码由前端 `setup-api/*/qrcode` 路由向网关取会话后，
  经 `notifyDaemonChatQr()` 落盘交守护进程渲染。
- 前端把 AI Key 写入 OpenClaw SQLite（`setup-api/ai-models/configure`）；网关 401 时清
  `setup-api/openclaw/runtime-data`。

---

## 四、frontend-patch（已归档）

`patch_startap_forceap.py` 曾用于为 `start-ap.sh` 幂等注入“强制热点”标记检测
（`data/force_ap` 存在则开机强制开热点）。2026-08-06 起源码已直接内置该检测，
正常部署不再需要；仅当更换/回退 `start-ap.sh` 后需重跑。

该脚本已归档到 `archive/2026-08-12_clawbox-deploy工具归档/frontend-patch/patch_startap_forceap.py`，
需要时取回执行 `python patch_startap_forceap.py /path/to/start-ap.sh` 即可。

> 旧的多平台二维码补丁脚本已于 2026-08-06 删除，相关能力已内置前端源码，
> 归档见 `archive/2026-08-06_11-41_板载按键功能/clawbox-deploy/frontend-patch/`。

---

## 五、接线表 (40Pin 核桃派2B)

### 墨水屏 (152×152 SSD1680)

```
物理脚 | 芯片名   | gpiochip | line | 连接设备     | 功能
--------|----------|----------|------|-------------|------------------
  1    | 3.3V     | —        | —    | 墨水屏       | VCC
  6    | GND      | —        | —    | 墨水屏       | GND
  7    | PB6      | gpiochip1| 38   | LED-R        | 红灯
  9    | GND      | —        | —    | LED-GND      | LED 地
 11    | PB13     | gpiochip1| 45   | 墨水屏       | RES (RST)
 12    | PB14     | gpiochip1| 46   | LED-Y        | 黄灯
 13    | PI12     | gpiochip1| 268  | LED-G        | 绿灯
 14    | GND      | —        | —    | 按键模块     | G (地)
 15    | PI11     | gpiochip1| 267  | 按键模块     | K1
 16    | PI10     | gpiochip1| 266  | 按键模块     | K2
 17    | 3.3V     | —        | —    | 按键模块     | V (供电)
 18    | PI9      | gpiochip1| 265  | 墨水屏       | BUSY (输入)
 19    | PI4      | —        | —    | 墨水屏       | SDA (SPI1 MOSI)
 22    | PI7      | gpiochip1| 263  | 墨水屏       | DC
 23    | PI3      | —        | —    | 墨水屏       | SCL (SPI1 SCLK)
 24    | PI2      | —        | —    | 墨水屏       | CS (SPI1 CS0)
 29    | PL6      | gpiochip0| 6    | 按键模块     | K3 (358-352=6)
 31    | PL5      | gpiochip0| 5    | 按键模块     | K4 (357-352=5)
```

> SPI 引脚 (19/23/24) 由内核自动管理。gpiochip0 的 PL 组 line = 芯片编号 − 352。

---

## 六、屏幕页面

黑白墨水屏，说明页 + 三页 + 启动画面：

| 按键 | 页面 | 内容 |
|------|------|------|
| 开机自动 | 说明页 | 按键功能一览 (K1-K4) |
| K1 短按 | 页面1 | 局域网访问二维码 + "扫码进入网页" |
| K2 短按 | 页面2 | 聊天渠道二维码 |
| K3 短按 | 页面3 | WiFi 状态 (SSID + IP) |
| 自动(页面2 WhatsApp 码超时) | 页面4 | 二维码已失效提示（重新获取） |
| K1 长按 | 说明页 | 随时查看按键说明 |
| K4 短按 | — | 重启设备 |
| K4 长按 3s | — | 关机 |
| 板载按键 短按 | — | 按当前模式反向切换：WiFi↔热点（仅 LED 闪烁反馈） |

> WhatsApp 图片型二维码（Baileys 配对码）由服务器每 ~20s 轮换，墨水屏静态快照
> 超过 `QR_EXPIRE_MS`（默认 60s）即自动切页面4 提示失效（2026-08-07 加）。
> 高密度 WhatsApp 图片码需要 OpenCV 解码后原生重绘；`install.sh` 会优先安装
> Debian 的 `python3-opencv`，不可用时才回退 `opencv-python-headless`。

> 板载按键 = 核桃派2B 板上无标注按键 (PB7)，**全部短按反向切换**（2026-08-06 改）。
> 切换至热点 → 写 `data/force_ap` 标记（开机强制热点）；切换至 WiFi → 清除标记。
> 切换期间仅**目标 LED 闪烁**（黄=热点 / 绿=WiFi）作反馈，墨水屏保持当前页不动
> （2026-08-06 用户决定去掉屏幕跳转）。断连状态短按 = 尝试连 WiFi，失败回退热点。

### 断网自动恢复（双接口）

- `wlan0` 始终作为 WiFi 客户端，由 NetworkManager 负责已保存网络的自动重连。
- 客户端断开超过 5 秒后，在 `wlan0ap` 创建临时 `ClawBox-Setup` 热点；两接口可同时
  工作，因此后台重连不会再每隔一段时间拆掉热点等待 15/45 秒。
- WiFi 连续稳定 10 秒后撤掉临时热点；热点仍有客户端时最多保留 10 分钟，避免中断
  正在进行的配置。热点使用 `ipv4.method shared`，可经 `wlan0` NAT 共享上游网络。
- `data/force_ap` 代表用户手动选择，优先级高于所有自动动作；板载按键会先取消旧的
  自动决策再执行切换。切回 WiFi 时会先让 NetworkManager 自选已保存配置，再沿用
  原 20 秒轮询与热点兜底，不由脚本解析可能转义的中文 SSID。开机快速重连窗口由
  45 秒缩短为 12 秒，随后热点可用且 NetworkManager 仍在后台继续连接。

---

## 七、日常管理

```bash
# 查看日志（日志由守护进程内 RotatingFileHandler 自轮转: 5MB×3 保留,
# 不依赖外部 logrotate, 启动日志不再被轮转竞态吞掉 —— 2026-08-11）
tail -f /var/log/clawbox-peripheral.log

# 崩溃 traceback 兜底（正常情况下为空文件）
tail -f /var/log/clawbox-peripheral-crash.log

# 风扇实时监控
cd /home/clawbox/clawbox-deploy/clawbox-peripheral
sudo python3 fan_monitor.py

# 停止守护进程（先写停止标记 → 监督者识别为"主动停止"并退出, 不会自动拉起）
# 注意: 直接 pkill 守护进程而不写标记, 监督者会把它重新拉起 (2026-08-26 起)
sudo touch /run/clawbox-peripheral.stop
sudo pkill -f peripheral_daemon.py
# （保险起见也可一并停掉监督者: sudo pkill -f supervisor.sh）
# 恢复运行: 删除停止标记后重启
sudo rm -f /run/clawbox-peripheral.stop
sudo bash /home/clawbox/clawbox-deploy/clawbox-peripheral/restart_daemon.sh

# 重启守护进程（推荐：自动清理旧实例并打印初始化结果; 末尾会自动拉起监督者）
sudo bash /home/clawbox/clawbox-deploy/clawbox-peripheral/restart_daemon.sh

# 重装
cd /home/clawbox/clawbox-deploy/clawbox-peripheral && sudo bash install.sh

# 修改后端 API 地址
sudo nano /etc/default/clawbox-peripheral
# 然后重启守护进程: sudo pkill -f peripheral_daemon.py && sudo bash install.sh
```

> **restart_daemon.sh（2026-08-07 实机验证）**：先清理旧实例——若
> `clawbox-peripheral.service` 处于 active 会自动先 `systemctl stop`
> （避免 `Restart=always` 自动拉起与手动实例冲突）；再 pkill 并等待退出
> （最长 10s，超时强制 -9）；启动前确认旧实例已清空，有残留则中止，绝不双实例；
> 随后 nohup 拉起新实例，6s 后打印进程与 LED/按键/板载按键初始化结果。
> 2026-08-07 两条路径均实测单实例重启成功：普通路径（服务 inactive）与
> systemd 服务 active 路径，均无 Device or resource busy；测试后服务已恢复为
> disabled。历史故障：2026-08-07 曾出现 pkill 未生效致双实例抢屏幕 SPI，
> 已清回单实例。

> **supervisor.sh（2026-08-12 增强）—— 异常退出自动拉起，正常退出不自启**：
> 监督者直接启动并 `wait` 守护进程，以真实退出码判断：非零退出或被信号杀死
> → 自动重新拉起（连续 5 次快速崩溃退避 60s）；正常退出 status=0 → 用户主动
> 停止 → 监督者退出、绝不自启。该机制也覆盖尚未来得及写运行标记便启动失败，
> 以及主循环未知异常在清理资源后退出的场景。`/run/clawbox-peripheral.live`
> 继续保留作运行状态观测，不再参与恢复判定。rc.local 与 install.sh 均以监督者为唯一启动入口；
> 停止守护进程用 `sudo pkill -f peripheral_daemon.py`（监督者随之退出），
> 重装/重启脚本会先停监督者再停守护进程，避免停止途中被拉起或双实例。
> `supervisor.sh`、`restart_daemon.sh` 与备用 systemd unit 都读取同一份
> `/etc/default/clawbox-peripheral`；若配置 `CLAWBOX_LIVE_MARK`，Python 与监督者
> 也会使用同一路径。

`/etc/default/clawbox-peripheral` 可调整的参数：

```bash
CLAWBOX_API_URL=http://127.0.0.1:80
CLAWBOX_QR_MAX_LENGTH=2048
CLAWBOX_QR_FILE_MAX_BYTES=20000
CLAWBOX_QR_ALLOWED_SCHEMES=http,https
```

> 该文件带 `CONFIG_VERSION` 版本标记（2026-08-11 起）。install.sh 检测到版本
> 低于当前会自动备份旧文件、保留自定义键（默认表之外的键）、按新默认重写；
> 版本一致则不动。升级代码后无需手动清理 `/etc/default`。修改后使用
> `sudo bash clawbox-peripheral/restart_daemon.sh` 重新启动即可进入实际进程环境。

---

## 八、常见问题

| 现象 | 排查 |
|------|------|
| 屏幕不刷新 | 检查接线；`dmesg \| grep spi` 确认 SPI 启用 |
| 字体模糊 | 安装中文字体 `sudo apt install fonts-wqy-zenhei` |
| 按键没反应 | `gpio readall` 确认引脚；是否 root 运行 |
| 风扇不转 | 查看温控日志 `tail -f /var/log/clawbox-peripheral.log` |
| SPI 设备不存在 | 启用 spidev overlay 后重启 |

---

## 九、技术参考

- **控制器**: SSD1680 (内置温度传感器、OTP LUT)
- **分辨率**: 152 × 152 像素
- **颜色**: 黑白，每像素 1 位
- **刷新**: 全刷 ~2 秒 (0x22=0xF4 → 0x20)；支持局刷 ~0.5 秒 (0x22=0xDC)，
  局刷前需 `init_partial`+`prepare_partial` 打底，每 N 次局刷全刷一次清残影
  （`config.py` 的 `PARTIAL_REFRESH_EVERY=9`，即 9 局刷 + 1 全刷）
- **接口**: 4 线 SPI (MOSI/SCLK/CS/DC) + BUSY + RES
- **驱动**: `epd-driver/epd1in54_152.py` 基于 ZJYE154S08R0G11 官方 C 驱动；
  1.1 起补齐 SSD1680 官方局刷序列（波形加载/0x26 备份/0xDC 控制字）；
  GPIO/SPI 经 `epdconfig.py` 的 `EpdConfig` 类（实例持有句柄，无模块级全局）
- **BUSY 极性**: 高电平有效 (BUSY=1=忙碌)，与部分开发板极性相反属正常差异
