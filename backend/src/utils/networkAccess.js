const net = require('net');

// Restricts STAFF accounts (the users table — Admin, HR, and every other
// manually-created account) to the company network. Employee self-service
// logins are never checked here — an employee can still reach their own
// salary slips from anywhere.
//
// Configured with ALLOWED_STAFF_IPS in backend/.env — a comma-separated
// list of any mix of:
//   - a single address:      203.0.113.10
//   - a CIDR range:          192.168.1.0/24
//   - an inclusive range:    192.168.1.10-192.168.1.50
// IPv4 and IPv6 both work. Left unset or empty, the restriction is OFF and
// every staff login is allowed; set to anything at all, it's ON and a staff
// account is refused from every address not on the list.
//
// An entry that can't be parsed is skipped with a warning at startup —
// which only ever makes the restriction stricter, never looser. If every
// entry is invalid the restriction is still ON, so nobody gets in until
// it's fixed (fail closed, not open).
//
// Loopback (127.0.0.1 / ::1) is deliberately NOT allowed automatically. If
// the app sits behind a reverse proxy on the same machine, every request
// can appear to come from loopback, and auto-allowing it would let the
// whole internet straight through. Add 127.0.0.1,::1 to the list yourself
// for local development.

let cached = null;

function getConfig() {
  if (cached) return cached;

  const entries = (process.env.ALLOWED_STAFF_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = new net.BlockList();
  const invalid = [];

  for (const entry of entries) {
    try {
      if (entry.includes('/')) {
        const [addr, prefix] = entry.split('/').map((s) => s.trim());
        const family = net.isIP(addr);
        const bits = Number(prefix);
        if (!family || prefix === '' || !Number.isInteger(bits)) throw new Error('bad CIDR');
        list.addSubnet(addr, bits, family === 4 ? 'ipv4' : 'ipv6');
      } else if (entry.includes('-')) {
        const [start, end] = entry.split('-').map((s) => s.trim());
        const family = net.isIP(start);
        if (!family || net.isIP(end) !== family) throw new Error('bad range');
        list.addRange(start, end, family === 4 ? 'ipv4' : 'ipv6');
      } else {
        const family = net.isIP(entry);
        if (!family) throw new Error('bad address');
        list.addAddress(entry, family === 4 ? 'ipv4' : 'ipv6');
      }
    } catch (err) {
      invalid.push(entry);
    }
  }

  cached = { enabled: entries.length > 0, list, invalid, count: entries.length };
  return cached;
}

// Node reports an IPv4 client on a dual-stack socket as "::ffff:1.2.3.4".
function normalizeIp(ip) {
  if (!ip) return '';
  const mapped = String(ip).match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : String(ip);
}

// { allowed, ip } for one request. req.ip is Express's view of the client
// address — the real visitor only if TRUST_PROXY is set correctly for
// however this app is deployed (see server.js).
function checkStaffNetwork(req) {
  const cfg = getConfig();
  const ip = normalizeIp(req.ip);
  if (!cfg.enabled) return { allowed: true, ip };
  const family = net.isIP(ip);
  const allowed = family !== 0 && cfg.list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  return { allowed, ip };
}

// Sends the standard refusal. Only ever reached by someone who has just
// proved a valid password (login) or presented a valid token (any other
// request), so telling them their own address back leaks nothing — and it
// makes a misconfigured list or proxy setting obvious on the spot.
function rejectStaffNetwork(res, ip, who) {
  console.warn(`[network] Refused staff access from ${ip || 'unknown address'}${who ? ` (account ${who})` : ''}`);
  return res.status(403).json({
    code: 'NETWORK_RESTRICTED',
    message: `Staff accounts can only be used from the office network. Your current connection (${ip || 'unknown address'}) is not on it.`
  });
}

// One-line status for the server's startup log.
function logNetworkRestrictionStatus() {
  const cfg = getConfig();
  if (!cfg.enabled) {
    console.log('Staff network restriction: OFF (ALLOWED_STAFF_IPS is not set — staff can log in from anywhere)');
    return;
  }
  console.log(`Staff network restriction: ON (${cfg.count - cfg.invalid.length} valid rule(s))`);
  if (cfg.invalid.length) {
    console.warn(`Staff network restriction: IGNORED invalid ALLOWED_STAFF_IPS entr(y/ies): ${cfg.invalid.join(', ')}`);
  }
}

module.exports = { checkStaffNetwork, rejectStaffNetwork, logNetworkRestrictionStatus };
