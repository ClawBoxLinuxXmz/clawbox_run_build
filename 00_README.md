# ClawBox Deployment Package 2026.8.28

This package combines the latest verified peripheral daemon, frontend source, and systemd configuration.

## Contents

- `clawbox-deploy/`: peripheral daemon, SSD1680 driver, install script, tests, and board tools.
- `前端源码/`: latest frontend负责人 source with Discord, Zalo, Signal, WeCom and existing channels.
- `frontend-systemd/`: setup, gateway, AP services and installation helper.
- `deploy_all.sh`: device-side zero-to-deploy script.
- `04_本次复核结论.md`: source, rendering, and verification notes.

## Verification

- Peripheral tests: 359 passed.
- Frontend tests: 274 passed.
- Frontend production build: passed with Next.js 16.1.6.
- No Lizard complexity findings or Bandit security findings.

## Deployment

Copy `clawbox-deploy/`, `frontend-systemd/`, `前端源码/`, `deploy_all.sh`, and the documentation to the device as described in `01_部署说明_一步步.md`, then run:

```bash
bash /home/clawbox/deploy_all.sh
```

Do not copy `node_modules/` or `.next/`; the device build step creates them.
