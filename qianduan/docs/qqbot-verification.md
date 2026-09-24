# QQ Bot channel verification

This checklist covers the official QQ Bot API integration exposed by the ClawBox setup page.

## Platform preparation

1. Open <https://q.qq.com/qqbot/openclaw/> and sign in by scanning the QR code with mobile QQ.
2. Create a bot, or select an existing bot, then open its settings page.
3. Copy the complete `AppID` and `AppSecret`. Save the AppSecret before leaving the page because the platform may require regenerating it later.
4. Use the bot owner's QQ account for the first private-chat test. Public release is not required for this initial C2C check.
5. No webhook URL or event callback is required; OpenClaw connects to QQ over WebSocket.

To make the bot available to other users later, configure experience-user and visibility settings at <https://q.qq.com/qqbot/dashboard/>. Tencent may require additional agreements or review for broader access.

## ClawBox setup

1. Configure an AI provider first.
2. Open **QQ Official Bot** on the setup page.
3. Enter the complete AppID and AppSecret, keep the channel enabled, and select **Save & Connect**.
4. Confirm the page reports that the QQ Bot channel is online.
5. Open the bot in QQ and send a private message. Confirm the AI replies.

The first ClawBox version writes the following access policy:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "YOUR_APP_ID",
      "clientSecret": "YOUR_APP_SECRET",
      "dmPolicy": "open",
      "allowFrom": ["*"],
      "groupPolicy": "disabled"
    }
  }
}
```

OpenClaw's current `qqbot` plugin does not support the Telegram-style pairing command. Direct messages are accepted after the platform makes the bot available; group messages remain disabled by ClawBox.

## Failure checks

- Invalid credentials must return HTTP 400 and must not modify the existing OpenClaw config.
- Platform or network failures must return HTTP 502 and keep the submitted AppSecret out of the response.
- A Gateway restart or online-status failure after saving must return `saved: true` so the UI can explain that the credentials were stored but the channel is not live yet.
- `GET /setup-api/channels/qqbot` and `GET /setup-api/channels/qqbot/status` must never return the AppSecret.

## Security

- Do not commit AppID/AppSecret values to Git, documentation, screenshots, issue reports, or chat messages.
- Rotate the AppSecret in the QQ Open Platform immediately if it is exposed.
- Keep group chat disabled until an explicit group access policy is configured and verified.
