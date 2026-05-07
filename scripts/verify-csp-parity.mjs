import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function extractCSPDirective(content, directive) {
  const match = content.match(new RegExp(`${directive}\\s+([^;]+)`, 'i'));
  return match ? match[1].trim().split(/\s+/) : [];
}

function normalizeWildcard(src) {
  // Convert vercel's .domain to *.domain for comparison
  return src.replace(/^https?:\/\./g, 'https://*.');
}

function parseVercelCSP() {
  const vercelPath = join(root, 'vercel.json');
  const raw = readFileSync(vercelPath, 'utf8');
  const json = JSON.parse(raw);
  const headersConfig = json.headers || [];
  
  // Find the main app CSP (the one for /((?!docs).*))
  const mainAppConfig = headersConfig.find(h => h.source === '/((?!docs).*)');
  if (!mainAppConfig) throw new Error('Main app header config not found in vercel.json');
  
  const cspHeader = mainAppConfig.headers.find(h => h.key === 'Content-Security-Policy');
  if (!cspHeader) throw new Error('CSP header not found in vercel.json main app config');
  
  const value = cspHeader.value;
  const scriptSrcMatch = value.match(/script-src\s+([^;]+)/);
  if (!scriptSrcMatch) throw new Error('script-src directive not found');
  return scriptSrcMatch[1].trim().split(/\s+/).map(normalizeWildcard);
}

function parseNginxCSP() {
  const nginxPath = join(root, 'docker', 'nginx-security-headers.conf');
  const raw = readFileSync(nginxPath, 'utf8');
  const match = raw.match(/add_header Content-Security-Policy "([^"]+)"/);
  if (!match) throw new Error('CSP header not found in nginx config');
  const value = match[1];
  const scriptSrcMatch = value.match(/script-src\s+([^;]+)/);
  if (!scriptSrcMatch) throw new Error('script-src directive not found');
  return scriptSrcMatch[1].trim().split(/\s+/);
}

function main() {
  const vercelSrc = parseVercelCSP();
  const nginxSrc = parseNginxCSP();

  // Compare sets (order doesn't matter)
  const vercelSet = new Set(vercelSrc);
  const nginxSet = new Set(nginxSrc);

  const missing = [...vercelSet].filter(x => !nginxSet.has(x));
  const extra = [...nginxSet].filter(x => !vercelSet.has(x));

  if (missing.length || extra.length) {
    console.error('❌ CSP drift detected between vercel.json and nginx-security-headers.conf');
    if (missing.length) console.error('Missing in nginx:', missing);
    if (extra.length) console.error('Extra in nginx:', extra);
    process.exit(1);
  }
  console.log('✅ CSP script-src directives are in sync');
}

main();
