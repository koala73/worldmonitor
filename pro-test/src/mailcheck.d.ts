declare module 'mailcheck' {
  interface Suggestion { address: string; domain: string; full: string; }
  interface RunOpts { email: string; suggested: (s: Suggestion) => void; empty: () => void; }
  const Mailcheck: { run: (opts: RunOpts) => void };
  export default Mailcheck;
}
