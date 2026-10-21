import { writeFileSync } from 'node:fs';
import { isIP } from 'node:net';

const outputPath = process.argv[2] ?? '/tmp/nginx-realip.conf';
const rawTrustedProxies = process.env.WM_TRUSTED_PROXY_CIDRS?.trim() ?? '';

function validateTrustedProxy(value) {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    return isIP(value) !== 0;
  }

  if (slashIndex !== value.lastIndexOf('/')) {
    return false;
  }

  const address = value.slice(0, slashIndex);
  const prefixText = value.slice(slashIndex + 1);
  const addressFamily = isIP(address);
  if (addressFamily === 0 || !/^(0|[1-9]\d*)$/.test(prefixText)) {
    return false;
  }

  const prefix = Number(prefixText);
  return prefix <= (addressFamily === 4 ? 32 : 128);
}

if (!rawTrustedProxies) {
  writeFileSync(outputPath, '# No trusted reverse proxies configured.\n');
} else {
  const trustedProxies = rawTrustedProxies.split(',').map((value) => value.trim());
  const invalidProxy = trustedProxies.find((value) => !value || !validateTrustedProxy(value));

  if (invalidProxy !== undefined) {
    console.error(`Invalid IP or CIDR in WM_TRUSTED_PROXY_CIDRS: ${JSON.stringify(invalidProxy)}`);
    process.exit(1);
  }

  const config = [
    ...trustedProxies.map((value) => `set_real_ip_from ${value};`),
    'real_ip_header X-Forwarded-For;',
    'real_ip_recursive on;',
    '',
  ].join('\n');

  writeFileSync(outputPath, config);
}
