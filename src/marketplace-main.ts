import {
  getClerkToken,
  getCurrentClerkUser,
  initClerk,
  openSignIn,
  subscribeClerk,
} from './services/clerk';
import catalog from '../shared/product-catalog.generated.json';
import type { AwsMarketplaceLicenseView } from '../shared/aws-marketplace';

type License = AwsMarketplaceLicenseView;
type Key = License['keys'][number];
type Account = { licenses: License[]; pendingRegistration: boolean };
type ApiError = { error?: string };

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};
const text = (id: string, value: string): void => { $(id).textContent = value; };
const show = (id: string, visible: boolean): void => { $(id).hidden = !visible; };

let account: Account | null = null;
let loadedForUser: string | null = null;
let requestGeneration = 0;
let mutationGeneration = 0;
let busy = false;
let revealed: { licenseId: string; key: string } | null = null;

function setStatus(message: string, error = false): void {
  text('status', message);
  $('status').classList.toggle('error', error);
}

function date(value: number | undefined, withTime = false): string {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' as const } : {}) }).format(new Date(value))
    : 'Unknown';
}

function make(tag: string, className = '', value = ''): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function detail(list: HTMLElement, label: string, value: string): void {
  const cell = make('div');
  cell.append(make('dt', '', label), make('dd', '', value));
  list.append(cell);
}

function planDetails(planKey: string | undefined, quantity: number | undefined): { label: string; limits: string } {
  const plan = catalog.facts.plans.find((entry) => entry.planKey === planKey);
  const tier = plan?.tierGroup ? catalog.tierConfig[plan.tierGroup as keyof typeof catalog.tierConfig] : undefined;
  const limits = tier?.planLimits;
  if (!limits) return { label: 'Marketplace plan', limits: 'See your AWS Marketplace agreement for included usage.' };
  const multiplier = quantity !== undefined && Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
  const daily = limits.apiRequestsPerDay * multiplier;
  return {
    label: tier.name,
    limits: `${daily.toLocaleString()} API units/day · ${limits.apiBurstRequestsPerMinute} requests/minute · ${limits.mcpDailyBudgetSharedWithRest ? 'MCP calls share the API allowance' : 'MCP has a separate allowance'}`,
  };
}

async function api<T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: object): Promise<T> {
  const token = await getClerkToken();
  if (!token) throw new Error('Sign in to continue.');
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => null) as T & ApiError | null;
  if (!response.ok) {
    const code = result?.error;
    if (response.status === 401) throw new Error('Your sign-in expired. Sign in again.');
    if (code === 'REGISTRATION_EXPIRED' || code === 'REGISTRATION_REQUIRED') {
      throw new Error('The AWS setup link expired. Return to AWS Marketplace and choose Set up your account again.');
    }
    if (response.status === 409) throw new Error('This registration or key changed. Refresh the page and try again.');
    throw new Error(response.status >= 500
      ? 'Marketplace service is temporarily unavailable. Try again.'
      : 'This request could not be completed. Check your license status and try again.');
  }
  if (!result || typeof result !== 'object') throw new Error('Marketplace service returned an invalid response.');
  return result;
}

function renderLicense(license: License): HTMLElement {
  const item = make('article', 'license');
  item.dataset.licenseId = license.id;
  const plan = planDetails(license.planKey, license.quantity);
  const head = make('div', 'license-head');
  const name = make('div');
  name.append(make('h3', '', plan.label), make('span', 'minor', `License ${license.id.slice(-8)}`));
  const active = license.status === 'active' && (license.validUntil ?? 0) > Date.now();
  head.append(name, make('span', `badge${active ? '' : ' inactive'}`, license.status));
  item.append(head);

  const details = make('dl');
  detail(details, 'Included use', plan.limits);
  detail(details, 'Quantity', license.quantity === undefined ? 'Pending AWS verification' : String(license.quantity));
  detail(details, 'Current access valid until', date(license.validUntil, true));
  detail(details, 'AWS status checked', date(license.checkedAt, true));
  item.append(details);

  item.append(make('h3', '', 'API and MCP keys'));
  const keys = make('ul', 'key-list');
  const activeKeys = license.keys.filter((key) => !key.revokedAt);
  if (activeKeys.length === 0) keys.append(make('li', 'minor', 'No active keys yet.'));
  for (const key of activeKeys) {
    const row = make('li');
    const label = make('div');
    label.append(make('strong', '', key.name), document.createElement('br'), make('span', '', `${key.keyPrefix}… · Created ${date(key.createdAt)}`));
    const revoke = make('button', 'danger', 'Revoke key') as HTMLButtonElement;
    revoke.type = 'button';
    revoke.setAttribute('aria-label', `Revoke ${key.name} key ${key.keyPrefix}`);
    revoke.disabled = busy;
    revoke.addEventListener('click', () => { void revokeKey(license, key); });
    row.append(label, revoke);
    keys.append(row);
  }
  item.append(keys);

  if (active) {
    const form = make('form', 'key-form') as HTMLFormElement;
    const input = make('input') as HTMLInputElement;
    input.name = 'name';
    input.type = 'text';
    input.maxLength = 64;
    input.required = true;
    input.placeholder = 'Key name, e.g. production-agent';
    input.setAttribute('aria-label', 'New key name');
    const create = make('button', 'primary', 'Create key') as HTMLButtonElement;
    create.type = 'submit';
    create.disabled = busy;
    form.append(input, create);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void createKey(license.id, input.value.trim());
    });
    item.append(form);
  } else {
    item.append(make('p', 'minor', 'Key creation is paused while this AWS license is inactive. Existing keys cannot access API or MCP until the license is active.'));
  }

  if (revealed?.licenseId === license.id) {
    const oneTimeKey = revealed.key;
    const box = make('div', 'secret');
    box.append(make('p', '', 'Copy this key now. It is shown once and will disappear when you leave or refresh this page.'), make('code', '', oneTimeKey));
    const copy = make('button', 'secondary', 'Copy key') as HTMLButtonElement;
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(oneTimeKey);
        copy.textContent = 'Copied';
      } catch {
        setStatus('Clipboard access failed. Select and copy the key shown above.', true);
      }
    });
    box.append(copy);
    item.append(box);
  }
  return item;
}

function render(): void {
  const user = getCurrentClerkUser();
  show('signedOut', !user);
  show('setup', !!user && !!account?.pendingRegistration);
  show('licensesPanel', !!user && !!account?.licenses.length);
  show('emptyPanel', !!user && !!account && account.licenses.length === 0 && !account.pendingRegistration);
  const list = $('licenses');
  if (!user || !account) {
    list.replaceChildren();
    return;
  }
  list.replaceChildren(...account.licenses.map(renderLicense));
}

function mutationIsCurrent(userId: string, request: number, mutation: number): boolean {
  return getCurrentClerkUser()?.id === userId
    && loadedForUser === userId
    && requestGeneration === request
    && mutationGeneration === mutation;
}

async function refresh(): Promise<void> {
  const user = getCurrentClerkUser();
  const generation = ++requestGeneration;
  if (!user) {
    loadedForUser = null;
    account = null;
    revealed = null;
    busy = false;
    mutationGeneration++;
    $('claimButton').removeAttribute('disabled');
    setStatus('Sign in to see your Marketplace license.');
    render();
    return;
  }
  if (loadedForUser !== user.id) {
    account = null;
    revealed = null;
    busy = false;
    mutationGeneration++;
    $('claimButton').removeAttribute('disabled');
    loadedForUser = user.id;
    render();
  }
  setStatus('Loading your Marketplace licenses…');
  try {
    const result = await api<Account>('/api/marketplace/account');
    if (generation !== requestGeneration || getCurrentClerkUser()?.id !== user.id) return;
    if (!Array.isArray(result.licenses) || typeof result.pendingRegistration !== 'boolean') throw new Error('Marketplace service returned an invalid account.');
    account = result;
    setStatus(result.pendingRegistration
      ? 'AWS registration is ready. Claim it for this signed-in WorldMonitor account.'
      : result.licenses.length > 0 ? 'Your Marketplace licenses are ready.' : 'No license is linked to this account.');
  } catch (error) {
    if (generation !== requestGeneration || getCurrentClerkUser()?.id !== user.id) return;
    account = null;
    revealed = null;
    setStatus(error instanceof Error ? error.message : 'Unable to load Marketplace licenses.', true);
  }
  render();
}

async function claim(): Promise<void> {
  if (busy || !account?.pendingRegistration) return;
  const userId = getCurrentClerkUser()?.id;
  if (!userId || loadedForUser !== userId) return;
  const request = requestGeneration;
  const mutation = ++mutationGeneration;
  busy = true;
  $('claimButton').setAttribute('disabled', '');
  try {
    await api<{ licenseId: string }>('/api/marketplace/claim', 'POST', {});
    if (!mutationIsCurrent(userId, request, mutation)) return;
    history.replaceState({}, '', '/marketplace');
    await refresh();
  } catch (error) {
    if (mutationIsCurrent(userId, request, mutation)) {
      setStatus(error instanceof Error ? error.message : 'Unable to claim the license.', true);
    }
  } finally {
    if (mutationGeneration === mutation) {
      busy = false;
      $('claimButton').removeAttribute('disabled');
      render();
    }
  }
}

async function createKey(licenseId: string, name: string): Promise<void> {
  if (busy || !name) return;
  const userId = getCurrentClerkUser()?.id;
  if (!userId || loadedForUser !== userId) return;
  const request = requestGeneration;
  const mutation = ++mutationGeneration;
  busy = true;
  render();
  setStatus('Creating your key…');
  try {
    const result = await api<{ keyId: string; key: string }>('/api/marketplace/keys', 'POST', { licenseId, name });
    if (!mutationIsCurrent(userId, request, mutation)) return;
    if (!/^wm_[a-f0-9]{40}$/.test(result.key)) throw new Error('Key response was invalid. Contact support before retrying.');
    const license = account?.licenses.find((entry) => entry.id === licenseId);
    license?.keys.push({ id: result.keyId, name, keyPrefix: result.key.slice(0, 8), createdAt: Date.now() });
    revealed = { licenseId, key: result.key };
    setStatus('Key created. Copy it now; it will not be shown again.');
  } catch (error) {
    if (mutationIsCurrent(userId, request, mutation)) {
      setStatus(error instanceof Error ? error.message : 'Unable to create a key.', true);
    }
  } finally {
    if (mutationGeneration === mutation) {
      busy = false;
      render();
    }
  }
}

async function revokeKey(license: License, key: Key): Promise<void> {
  if (busy || !window.confirm(`Revoke ${key.name} (${key.keyPrefix}…)? Apps using this key will lose access.`)) return;
  const userId = getCurrentClerkUser()?.id;
  if (!userId || loadedForUser !== userId) return;
  const request = requestGeneration;
  const mutation = ++mutationGeneration;
  busy = true;
  render();
  try {
    await api<{ ok: true }>('/api/marketplace/keys', 'DELETE', { licenseId: license.id, keyId: key.id });
    if (!mutationIsCurrent(userId, request, mutation)) return;
    key.revokedAt = Date.now();
    setStatus(`${key.name} was revoked. Update apps that used it.`);
  } catch (error) {
    if (mutationIsCurrent(userId, request, mutation)) {
      setStatus(error instanceof Error ? error.message : 'Unable to revoke the key.', true);
    }
  } finally {
    if (mutationGeneration === mutation) {
      busy = false;
      render();
    }
  }
}

void initClerk().then(() => {
  $('signInButton').addEventListener('click', () => openSignIn());
  $('claimButton').addEventListener('click', () => { void claim(); });
  subscribeClerk(() => { void refresh(); });
  void refresh();
}).catch(() => setStatus('Sign-in service is unavailable. Try again later.', true));
