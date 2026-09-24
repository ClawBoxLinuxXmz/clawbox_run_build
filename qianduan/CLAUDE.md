# CLAUDE.md

This repository is the setup UI and local dashboard for ClawBox.

## Project Shape

- The device first exposes a setup hotspot named `ClawBox-Setup`
- Users open `http://192.168.4.1/setup` from a phone
- After Wi‑Fi credentials are submitted, the device joins the target LAN through `NetworkManager + nmcli`
- The device keeps DHCP for IPv4 assignment
- The default zero-config access path is `http://clawbox-<suffix>.local/`
- If `.local` is unavailable on the client, the OLED screen shows the IPv4 fallback

`clawbox.home.arpa` is optional local DNS only. It is not the default discovery mechanism.

## Stack

- Runtime: Node.js 22 for production
- Dev/build: Bun
- Framework: Next.js App Router
- Language: TypeScript
- Wi‑Fi control: `nmcli`
- mDNS: `avahi-daemon`
- Display helper: Python OLED script

## Commands

```bash
bun install
bun run dev
bun run build
node production-server.js
bun run test
bun run lint
sudo bash install.sh
sudo bash install.sh --step NAME
```

## Key Routes

- `/setup`
  Hotspot setup page
- `/setup-api/wifi/scan`
  Trigger/poll Wi‑Fi scan
- `/setup-api/wifi/connect`
  Submit Wi‑Fi credentials and begin async cutover
- `/setup-api/wifi/status`
  Stable Wi‑Fi status payload with `mdnsHost`, `accessUrl`, `ipv4`
- `/setup-api/system/info`
  System status plus current access entrypoints
- `/`
  Redirects to `/setup`; no account or administrator sign-in is required

The user flow stays on the setup surface: Wi-Fi, AI provider, optional message channels, then use. Channel configuration is not moved to a separate signed-in portal.

## Important Files

- `src/lib/network.ts`
  `nmcli` wrapper for scan, connect, DHCP wait, hotspot restore
- `src/lib/device-identity.ts`
  Stable hostname generation and `.local` access info
- `src/lib/system-info.ts`
  System metrics plus LAN access metadata
- `scripts/start-ap.sh`
  AP startup and boot-time saved-Wi‑Fi reconnect with DHCP wait
- `scripts/oled-display.py`
  OLED display for hostname, `.local`, and IPv4 fallback
- `config/clawbox-http.service.xml`
  Avahi `_http._tcp` advertisement

## Behavior Notes

- Do not introduce device-side static IPv4 as the default path
- The connect flow is only considered successful after a DHCP IPv4 lease is present
- On Wi‑Fi connect failure or DHCP timeout, the device should restore `ClawBox-Setup`
- Multi-device LAN collisions are avoided through `clawbox-<suffix>` hostnames
