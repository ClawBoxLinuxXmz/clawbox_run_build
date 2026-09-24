# AGENTS.md

This repository is the setup UI and local dashboard for ClawBox.

## Project purpose

- The device first exposes a setup hotspot named `ClawBox-Setup`.
- Users open `http://192.168.4.1/setup` from a phone.
- After Wi‑Fi credentials are submitted, the device joins the target LAN through `NetworkManager + nmcli`.
- The device keeps DHCP for IPv4 assignment.
- The default zero-config access path is `http://clawbox-<suffix>.local/`.
- If `.local` is unavailable on the client, the OLED screen shows the IPv4 fallback.

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

## Key routes

- `/setup` — hotspot setup page
- `/setup-api/wifi/scan` — trigger/poll Wi‑Fi scan
- `/setup-api/wifi/connect` — submit Wi‑Fi credentials and begin async cutover
- `/setup-api/wifi/status` — stable Wi‑Fi status payload with `mdnsHost`, `accessUrl`, `ipv4`
- `/setup-api/system/info` — system status plus current access entrypoints
- `/` — redirects to `/setup`; no account or administrator sign-in is required

The user flow stays on the setup surface: Wi‑Fi, AI provider, optional message channels, then use. Channel configuration is not moved to a separate signed-in portal.

## Important files

- `src/lib/network.ts` — `nmcli` wrapper for scan, connect, DHCP wait, hotspot restore
- `src/lib/device-identity.ts` — stable hostname generation and `.local` access info
- `src/lib/system-info.ts` — system metrics plus LAN access metadata
- `scripts/start-ap.sh` — AP startup and boot-time saved-Wi‑Fi reconnect with DHCP wait
- `scripts/oled-display.py` — OLED display for hostname, `.local`, and IPv4 fallback
- `config/clawbox-http.service.xml` — Avahi `_http._tcp` advertisement

## Behavior notes

- Do not introduce device-side static IPv4 as the default path.
- The connect flow is only considered successful after a DHCP IPv4 lease is present.
- On Wi‑Fi connect failure or DHCP timeout, the device should restore `ClawBox-Setup`.
- Multi-device LAN collisions are avoided through `clawbox-<suffix>` hostnames.

## Working expectations

- Prefer minimal, targeted edits over broad refactors.
- Keep device networking behavior aligned with DHCP-first discovery and `.local` access semantics.
- Run the smallest relevant validation command after changes (usually the targeted test file or lint check for the touched area).
- If you need to change setup/network logic, follow the existing flow in `src/lib/network.ts`, `src/lib/device-identity.ts`, and the relevant route handlers before adding new abstractions.
