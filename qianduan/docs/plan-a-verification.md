# DHCP 自动联网与局域网自动发现验收清单

## 目标

验证设备能够通过热点完成配网，接入目标局域网后通过 DHCP 自动拿到 IPv4，并优先通过 `clawbox-<suffix>.local` 访问；若客户端不支持 `.local`，仍可通过 OLED 上显示的 IPv4 正常访问。

## 前提

- 目标路由器正常提供 DHCP
- 设备镜像已烧录并包含当前仓库构建结果
- 局域网允许 mDNS 广播
- `clawbox.home.arpa` 只在明确配置了本地 DNS 时再测

## 验收步骤

1. 启动设备，确认热点 `ClawBox-Setup` 出现并可连接
2. 在手机上打开 `http://192.168.4.1/setup`
3. 提交正确 Wi‑Fi 凭据，确认热点断开
4. 等待设备加入目标 Wi‑Fi，确认 OLED 显示：
   - 设备主机名 `clawbox-<suffix>`
   - `clawbox-<suffix>.local`
   - 当前 IPv4
5. 手机重新连回家庭 Wi‑Fi，优先访问 `http://clawbox-<suffix>.local/`
6. 如果手机不支持 `.local`，改用 OLED 上显示的 IPv4 访问
7. 进入页面后检查 Dashboard 是否可打开，确认系统信息接口与当前访问入口一致
8. 重启设备，复测：
   - 自动重连保存过的 Wi‑Fi
   - DHCP IPv4 重新获取成功
   - `http://clawbox-<suffix>.local/` 仍可访问
   - IPv4 兜底仍可访问
9. 换到另一个局域网后复测：
   - 主机名不变
   - IPv4 可以变化
   - `.local` 入口仍可访问
10. 如果现场额外配置了本地 DNS，再测试 `clawbox.home.arpa`

## 失败判定

- 提交正确 Wi‑Fi 后长时间拿不到 IPv4，且没有自动回到热点
- 设备重启后不再自动连接已保存 Wi‑Fi
- `.local` 主机名和 OLED/IP 显示口径不一致
- 多台设备同网时主机名冲突

## 建议补测

- 错误 Wi‑Fi 密码后是否自动恢复热点
- Wi‑Fi 扫描是否还能正常使用
- 系统重置、更新、系统信息页面是否继续可用
- OpenClaw 页面是否能通过同一入口正常打开
