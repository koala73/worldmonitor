---
title: "Geopolitical Alerts in Slack and Telegram"
description: "Connect Slack or Telegram to World Monitor, choose supported alerts or digests, and configure scope and quiet hours. Understand access and delivery limits."
metaTitle: "Geopolitical Alerts in Slack and Telegram"
keywords: "geopolitical alerts app, telegram news alerts, discord intelligence alerts, microsoft teams alerts, web push breaking news, alert fatigue quiet hours, intelligence notifications"
audience: "Analysts, ops and security teams, traders, journalists, anyone who can't watch a dashboard all day"
heroImage: "/blog/images/blog/alerts-notification-channels-worldmonitor.jpg"
pubDate: "2026-07-21"
modifiedDate: "2026-11-17"
---

World Monitor can deliver geopolitical alerts through Slack and Telegram using its notification settings. Connect the destination, choose supported event types and delivery modes, then check scope and quiet hours. Slack and Telegram require paid access; the free alert options shown in the product use a more limited set of channels and rules.

*Cover: an archived dashboard image. Displayed readings and interface details are illustrative, not current observations.*

## Connect the destination

Open the dashboard's notification settings while signed in. For Slack, choose **Add to Slack**, complete the authorization flow and select the permitted destination. Workspace permissions can affect which destination you can connect. Return to World Monitor and check the connection state.

For Telegram, choose **Connect** and follow the generated pairing link or command. Complete the bot's confirmation step; opening the bot alone does not finish pairing. Return to the dashboard and wait for the connected state.

Keep pairing links, QR codes and webhook addresses out of screenshots and shared notes. This guide describes setup; it does not claim that a message was sent to a real Slack workspace or Telegram chat during editorial validation.

## Match sensitivity to the delivery mode

| Mode | Supported use |
| --- | --- |
| Realtime | Uses critical sensitivity; high/all settings are not supported. Event-specific exceptions are described below. |
| Scheduled digest | Broader supported sensitivity and a chosen cadence, where enabled. |

Paid users can also receive enabled watched-site and reservoir alerts in realtime at their actual, non-critical severity. Aviation traffic-collapse recovery notices also bypass the critical-only delivery check. These exceptions do not enable high/all realtime sensitivity settings, and quiet hours still apply according to the event's actual severity.

Choose a narrower rule first. A digest helps review a collection of material; it is not a guaranteed replay of every individual event. Deployment configuration can affect whether a digest option is enabled. Use the controls actually available in your account.

## Scope the event, not just the country

Country selection narrows attributed events and excludes unattributed global market and shipping-stress events. Some unattributed news-origin events remain eligible so relevant reporting is not lost. Chokepoint-disruption alerts require explicit event selection and use chokepoint scope rather than a country filter: an empty chokepoint selection matches every chokepoint. Select identifiers to narrow it.

Start with the place or corridor you genuinely monitor and the supported event type that answers your question. Do not assume that arbitrary market thresholds, private portfolio rules or every observed map change can trigger a notification.

## Set the schedule and quiet hours

Review the selected timezone as well as the clock time. A schedule that looks correct in your local browser can still be wrong for the team receiving the briefing. Check the supported quiet-hours behavior in the current settings before assuming that an alert will pass through or be held.

For a daily review, choose a digest cadence where available and retain source links in the resulting research process. An automated delivery saves you a dashboard visit; it does not remove the need to inspect important claims.

## Other delivery channels

Across its seven channels, the settings also support email, browser push, Discord, Microsoft Teams and webhooks, subject to access and channel configuration. Browser push needs browser permission. Teams setup uses its supported Workflows connection. A webhook requires a receiving system and is a developer integration, not a prerequisite for native Slack or Telegram setup.

Use the [notification documentation](/docs/api-notifications) for channel-specific requirements and [current plans](/docs/pricing) for access. Do not assume every channel has the same test control; the documented send-test action is Teams-specific.

## When a notification does not arrive

Check the connection state, whether the rule is enabled, the event type, its scope, the sensitivity/mode combination, and the timezone/quiet hours. Then distinguish “no matching event” from a failed connection or delivery.

Do not reconnect repeatedly or purchase another plan solely because an entitlement check is temporarily unavailable. Record the error and follow its retry guidance. A configured rule is not proof that a qualifying event occurred, and a delivered story is not proof its claim is true.

For each important delivered item, open the original source and inspect the timestamp. Coverage labels describe available source coverage, not a verdict of truth. The [AI reliability guide](/blog/posts/ai-intelligence-summary-reliability/) applies to generated digests too.

The public [notification settings implementation](https://github.com/koala73/worldmonitor/blob/5c50df116c/src/services/notifications-settings.ts) documents the behavior behind this guide.

## Frequently Asked Questions

**Do Slack and Telegram alerts require code?**

The native connection flows do not require writing a webhook receiver. You do need the relevant account access and destination permissions.

**Can I receive every event in realtime?**

Realtime uses the critical sensitivity setting. Enabled watched-site and reservoir alerts, and aviation traffic-collapse recovery notices, have event-specific delivery exceptions. Broader high/all sensitivity settings belong in a digest cadence where enabled.

**Does Country Scope filter chokepoint alerts?**

Chokepoint alerts use their own explicit event selection and chokepoint scope. An empty chokepoint selection matches all chokepoints; select identifiers to narrow it. Country metadata does not apply uniformly to all events.

**Does a connected channel guarantee delivery?**

No. A matching rule, eligible event, schedule and functioning destination are also necessary. Check each stage when diagnosing a missing notification.

Open [World Monitor](https://www.worldmonitor.app) and configure one destination with a narrow rule before expanding your alert coverage.
