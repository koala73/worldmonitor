---
title: "Build a Custom OSINT Dashboard Without Coding"
description: "Create a World Monitor widget with a plain-language prompt, inspect its preview and save it to your dashboard. Understand access, storage and data limits."
metaTitle: "Build a Custom OSINT Dashboard Without Coding"
keywords: "custom OSINT dashboard, custom widgets, no-code intelligence dashboard"
audience: "Analysts and researchers"
heroImage: "/blog/images/blog/what-is-worldmonitor-real-time-global-intelligence.jpg"
pubDate: "2026-11-17"
---

You can use World Monitor's custom-widget builder to describe a monitoring view in plain language, inspect the generated preview and add it to your dashboard. Hosted generation requires the appropriate paid access. A saved widget is a useful presentation of information, not proof that its data is complete, correct or continuously refreshed.

*Cover: an archived dashboard image. Displayed readings and interface details are illustrative, not current observations.*

## Start with a narrow prompt

A useful prompt defines the question, the layout and what to do when evidence is unavailable. For example:

> Create a compact monitoring widget for a region I specify. Show available observations with their source links and timestamps. Keep unavailable values marked unavailable. Do not invent historical values or imply that nearby events have the same cause.

This is a prompt template, not a promise that every requested source or field is available. Ask for a small view first. A request to “monitor every risk automatically” makes the result harder to evaluate.

## Create, preview and save

1. Go to the end of the dashboard panel grid and choose **Create Interactive Widget**, available with premium access. Describe the view you need.
2. Wait for generation to finish. An error or incomplete preview is not a successful widget.
3. Inspect the preview before choosing **Add to Dashboard**. Check labels, dates, source links and what happens to missing values.
4. Add the widget, then reload the same browser profile and confirm it remains available.
5. Use **Modify widget with AI** for a small revision, such as changing the layout or requesting clearer source labels. Inspect the revised result again.

The controlled browser checks for this guide use fixture responses to exercise generation, preview, save, reload and modification. They test the interface flow; they do not establish live provider availability or factual accuracy for an arbitrary prompt.

## Review the data, not only the design

A polished chart can hide a weak source. Open linked material and compare what it supports with the widget's labels. Distinguish World Monitor observations from external web research, and distinguish a source's observation time from the time the widget was generated.

Check a few concrete cases: Does a blank result become an invented zero? Is a number missing its units? Does a historical chart have dated source observations? Does an apparent comparison use the same measurement period?

If you cannot verify a claim, ask for a revision or leave it out. Generated content still needs review; see [AI intelligence reliability](/blog/posts/ai-intelligence-summary-reliability/).

## Understand what saving means

The custom-widget store uses browser local storage for saved widget content and conversation history. Reloading the same browser can restore that saved content. Clearing site data, using another profile or encountering a storage limit can affect it. The local store retains the ten most recently saved widgets. Saving an eleventh removes the earliest saved widget from that store, so reloading will not restore it. This local storage limit is separate from any plan allowance for dashboards.

Do not infer cross-device synchronization, team sharing or scheduled regeneration from a successful save. Those are separate capabilities. A stored widget can still display older information; check [data timestamps and freshness](/blog/posts/real-time-intelligence-data-freshness/) rather than treating persistence as an update guarantee.

## Keep revisions focused

After saving a first version, change one thing at a time. For example: “Keep the same sources, but show the observation date beside each value.” Compare the new preview with the previous version before accepting it.

Avoid putting credentials or sensitive material into a prompt simply to make a view work. A generated widget renders inside an iframe sandboxed to script execution alone, with no same-origin access to your dashboard's storage or to any other site; MDN documents what [that sandbox attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox) permits. This tutorial does not require private-data uploads, custom connectors or external message delivery. If your task needs a programmatic integration, use the relevant API or MCP documentation instead of assuming the widget can access any service.

## Access and limits

The public dashboard and hosted custom-widget generation have different access requirements. Check [current plans](/docs/pricing) for the workflow and licensing you need. Model availability, upstream sources and browser storage can each limit a session.

A custom widget is also different from choosing a [dashboard variant](/blog/posts/five-dashboards-one-platform-worldmonitor-variants/). Variants provide a curated starting view; a widget adds a focused view for your own question.

The public [widget storage implementation](https://github.com/koala73/worldmonitor/blob/5c50df116c/src/services/widget-store.ts) documents the behavior behind this guide.

## Frequently Asked Questions

**Do I need to write code?**

The builder accepts plain-language requests. You still need to inspect the result, sources and limitations before relying on it.

**Is hosted widget generation free?**

It has paid access requirements separate from the public dashboard. Consult current plans rather than assuming all AI actions are included in free access.

**Does a saved widget update itself continuously?**

Saving establishes persistence of the widget content. It does not, by itself, establish an automatic refresh schedule for every data source.

**Will the widget appear on another device?**

Do not assume so from this local save workflow. Browser storage and any separate synchronization or sharing capability are different things.

Open [World Monitor](https://www.worldmonitor.app), request one small view, and review its evidence before adding it to your dashboard.
