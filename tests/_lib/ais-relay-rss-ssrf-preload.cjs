// Transport shim preloaded into a spawned relay by tests/ais-relay-rss-ssrf-e2e.test.mjs.
// The mode is read from a control file on every call so the test can flip it
// between requests without restarting the relay:
//   reroute -> connections to TARGET go to 127.0.0.1:LOCAL_PORT (no lookup runs)
//   private -> dns.promises.lookup(TARGET) answers 10.0.0.5 after a short delay
//   mixed   -> answers [93.184.216.34, 10.0.0.5]
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const dns = require('node:dns');

const TARGET = process.env.RSS_TEST_TARGET;
const LOCAL_PORT = Number(process.env.RSS_TEST_LOCAL_PORT);
const CTL = process.env.RSS_TEST_CTL;
const mode = () => fs.readFileSync(CTL, 'utf8').trim();

const originalCreateConnection = http.globalAgent.createConnection;
http.globalAgent.createConnection = function createConnection(options, callback) {
  if (options.host === TARGET && mode() === 'reroute') {
    const local = { ...options, host: '127.0.0.1', port: LOCAL_PORT };
    delete local.lookup;
    return net.createConnection(local, callback);
  }
  return originalCreateConnection.call(this, options, callback);
};

const originalLookup = dns.promises.lookup;
dns.promises.lookup = async function lookup(hostname, options) {
  if (hostname === TARGET) {
    const current = mode();
    if (current === 'private') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return [{ address: '10.0.0.5', family: 4 }];
    }
    if (current === 'mixed') return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  }
  return originalLookup.call(this, hostname, options);
};
