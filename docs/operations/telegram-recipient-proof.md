# Telegram recipient proof

Issue #7896 restricts Telegram binding to the secret-authenticated bot callback.
Generic channel setters reject Telegram. Pairing-token redemption is internal;
the callback supplies the chat ID from a recent private-chat Telegram update.
Successful pairing writes `telegramOwnership: "verified_callback"`.

## Existing connections

Existing rows without this marker cannot prove how their chat ID was bound.
Account and relay channel reads report them as unverified. Realtime, held-alert,
and digest delivery also require the marker. No customer rows are rewritten.

After deployment, users with an existing Telegram connection must connect again
in notification settings and follow the bot pairing link. A successful callback
replaces the old destination with the update's chat ID. It preserves existing
alert-rule channel choices; users can enable Telegram on their rules if needed.

## Deployment and acceptance

Deploy Convex first, then the notification relay and digest worker. The Convex
read guard protects older consumers during this order. Deploying workers first
suspends Telegram delivery until Convex writes the marker through new pairing.
Do not roll back the guards to restore delivery to unproven rows.

With separate deployment and live-message authorization, verify one test account:

- Its old connection shows disconnected and receives no alerts.
- A fresh private-chat pairing connects the account and sends one welcome.
- A reused or expired link does not change its destination or send a welcome.
- Realtime and digest messages reach only the newly paired chat.
- Deactivation stops delivery even when the marker remains on the stored row.

Local tests use synthetic users, fake secrets, and mocked Telegram transport.
They do not establish deployment or production acceptance.
