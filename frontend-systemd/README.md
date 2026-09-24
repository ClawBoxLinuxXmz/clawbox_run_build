# 前端 systemd 服务模板

> 来源: 旧设备(192.168.1.137) 2026-08-10 导出, 用于新设备部署。
> 原始快照: 备份/_旧设备导出_20260810/

## 文件清单

| 文件 | 部署目标 | 说明 |
|------|---------|------|
| `clawbox-setup.service` | `/etc/systemd/system/` | 前端 Next.js Web 服务(:80) |
| `clawbox-gateway.service` | `/etc/systemd/system/` | OpenClaw 网关(:18789) |
| `clawbox-ap.service` | `/etc/systemd/system/` | WiFi 热点 + captive portal |
| `production-server.cjs` | `/home/clawbox/clawbox/` | 前端生产启动脚本 |

## 与新设备的差异说明

- `clawbox-setup.service`: ExecStart 旧设备为 `/usr/bin/node`(v20),
  新设备统一用 `/opt/node22/bin/node`(v22.23.2), 已改好。
- 旧设备模板中重复的 AmbientCapabilities 块已清理(只留一份)。
- start-ap.sh / stop-ap.sh 随前端源码包分发(`src/scripts/`), 不在本目录。
- clawbox-root-update@.service 旧设备引用不存在的 install.sh, 已废弃不部署。
