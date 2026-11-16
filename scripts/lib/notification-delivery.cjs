'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

function deliveryErrorClass(error, fallback = 'Delivery failed') {
  const value = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(value)) return 'DNS lookup failed';
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(value)) return 'Request timed out';
  if (/ECONN|socket|network/i.test(value)) return 'Connection failed';
  return fallback;
}

function createDeliveryReporter({ siteUrl, secret, source }) {
  const deliveryReports = new AsyncLocalStorage();

  async function submitDeliveryReports(results) {
    try {
      const response = await fetch(`${siteUrl}/relay/delivery-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': `worldmonitor-${source}/1.0` },
        body: JSON.stringify({ results }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) console.warn(`[${source}] Delivery results not recorded: HTTP ${response.status}`);
    } catch {
      console.warn(`[${source}] Delivery results not recorded`);
    }
  }

  async function withDeliveryReports(deliver) {
    if (deliveryReports.getStore()) return deliver();
    const results = [];
    return deliveryReports.run(results, async () => {
      try {
        return await deliver();
      } finally {
        for (let i = 0; i < results.length; i += 100) {
          await submitDeliveryReports(results.slice(i, i + 100));
        }
      }
    });
  }

  async function recordDelivery(userId, channelType, channel, error = null) {
    if (!channel?._id || !Number.isFinite(channel.linkedAt)) return error === null;
    const result = { userId, channelType, delivery: { channelId: channel._id, linkedAt: channel.linkedAt, error } };
    const results = deliveryReports.getStore();
    if (results) results.push(result);
    else await submitDeliveryReports([result]);
    return error === null;
  }

  return { recordDelivery, withDeliveryReports };
}

module.exports = { createDeliveryReporter, deliveryErrorClass };
