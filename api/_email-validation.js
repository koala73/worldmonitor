const DISPOSABLE_DOMAINS = new Set([
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamailblock.com', 'grr.la', 'sharklasers.com', 'spam4.me',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io',
  'throwaway.email', 'throwaway.com',
  'mailinator.com', 'mailnesia.com', 'maildrop.cc',
  'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'trashmail.com', 'trashmail.me', 'trashmail.net',
  'dispostable.com', 'discard.email',
  'fakeinbox.com', 'fakemail.net',
  'getnada.com', 'nada.email',
  'tempinbox.com', 'tempr.email', 'tempmailaddress.com',
  'emailondeck.com', '33mail.com',
  'mohmal.com', 'mohmal.im', 'mohmal.in',
  'harakirimail.com', 'crazymailing.com',
  'inboxbear.com', 'mailcatch.com',
  'mintemail.com', 'mt2015.com',
  'spamgourmet.com', 'spamgourmet.net',
  'mailexpire.com', 'mailforspam.com',
  'safetymail.info', 'trashymail.com',
  'mytemp.email', 'tempail.com',
  'burnermail.io',
  'passinbox.com', 'passmail.net', 'passmail.com',
  'silomails.com', 'slmail.me',
  'spam.me', 'spambox.us',
]);

const OFFENSIVE_RE = /(nigger|faggot|fuckfaggot)/i;

const TYPO_TLDS = new Set(['con', 'coma', 'comhade', 'gmai', 'gmial']);

async function hasMxRecords(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return true;
    const data = await res.json();
    return Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch {
    return true;
  }
}

export async function validateEmail(email) {
  const normalized = email.trim().toLowerCase();
  const atIdx = normalized.indexOf('@');
  if (atIdx < 1) return { valid: false, reason: 'Invalid email format' };

  const domain = normalized.slice(atIdx + 1);
  const localPart = normalized.slice(0, atIdx);

  if (OFFENSIVE_RE.test(localPart) || OFFENSIVE_RE.test(domain)) {
    return { valid: false, reason: 'Email address not accepted' };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, reason: 'Disposable email addresses are not allowed. Please use a permanent email.' };
  }

  const tld = domain.split('.').pop();
  if (tld && TYPO_TLDS.has(tld)) {
    return { valid: false, reason: 'This email domain looks like a typo. Please check the ending.' };
  }

  const mx = await hasMxRecords(domain);
  if (!mx) {
    return { valid: false, reason: 'This email domain does not accept mail. Please check for typos.' };
  }

  return { valid: true };
}
