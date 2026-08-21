const sessionSecret = process.env.WM_SESSION_SECRET ?? '';

if (sessionSecret.length < 32) {
  console.error('WM_SESSION_SECRET must be at least 32 characters');
  process.exit(1);
}
