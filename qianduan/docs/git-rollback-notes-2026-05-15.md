# Git rollback notes (2026-05-15)

## Baseline checkpoint
- Commit: `7a995c0`
- Message: `chore: bootstrap local git baseline for clawbox takeover (2026-05-15)`

## Quick rollback commands
```bash
git log --oneline -n 20
git reset --hard 7a995c0
```

## Safer rollback (keep local uncommitted work)
```bash
git stash push -u -m "temp-before-rollback"
git reset --hard 7a995c0
```

## Restore stashed work (if needed)
```bash
git stash list
git stash pop
```

## Deployment caution
When syncing from Windows archive to Raspberry Pi, script execute bits may be lost.
Always restore script permissions after extraction before restarting services:

```bash
chmod 750 /home/clawbox/clawbox/scripts/*.sh /home/pi/clawbox-src/scripts/*.sh
chown clawbox:clawbox /home/clawbox/clawbox/scripts/*.sh /home/pi/clawbox-src/scripts/*.sh
```
