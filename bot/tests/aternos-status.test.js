const assert = require('assert');

const {
  SERVER_STATE,
  classifyAternosStatus,
  stateOf,
  sanitizeEndpoint,
  isValidTemporaryEndpoint,
  chooseBestStatus,
  chooseDynamicProbe
} = require('../utils/minecraftServer');

function check(description, actual, expected) {
  assert.deepStrictEqual(actual, expected, description);
}

check(
  'offline ghost proxy',
  classifyAternosStatus({ description: 'This server is offline', version: { name: 'Aternos' }, players: { max: 0 } }).state,
  SERVER_STATE.OFFLINE
);

check(
  'starting ghost proxy',
  classifyAternosStatus({ description: 'This server is currently preparing...', version: { name: 'Aternos' }, players: { max: 0 } }).state,
  SERVER_STATE.STARTING
);

check(
  'waiting ghost proxy',
  classifyAternosStatus({ description: 'Please wait', version: { name: 'Aternos' }, players: { online: 0, max: 0 } }).state,
  SERVER_STATE.WAITING
);

check(
  'real server status',
  classifyAternosStatus({ description: 'MineEmpires', version: { name: '1.21.8' }, players: { online: 1, max: 20 } }).state,
  SERVER_STATE.ONLINE
);

check(
  'stopping proxy',
  classifyAternosStatus({ description: 'This server is currently stopping', version: { name: 'Aternos' }, players: { max: 0 } }).state,
  SERVER_STATE.STOPPING
);

assert.strictEqual(isValidTemporaryEndpoint({ host: 'example.aternos.host', port: 41235 }), true);
assert.strictEqual(isValidTemporaryEndpoint({ host: 'mineempiresof.aternos.me', port: 25565 }), false);
assert.strictEqual(isValidTemporaryEndpoint({ host: '203.0.113.42', port: 13174 }), true);
assert.strictEqual(isValidTemporaryEndpoint({ host: '2001:db8::42', port: 13174 }), true);
assert.deepStrictEqual(
  sanitizeEndpoint({ host: 'example.aternos.host.', port: 41235 }, 'srv').publicHost,
  'example.aternos.host'
);
assert.strictEqual(stateOf({ state: SERVER_STATE.UNKNOWN }), SERVER_STATE.UNKNOWN);

assert.strictEqual(sanitizeEndpoint({ host: 'mineempiresof.aternos.me', port: 13174 }), null);
assert.strictEqual(
  sanitizeEndpoint({ host: '203.0.113.42', port: 13174 }, 'socket-remote-ip').publicHost,
  '203.0.113.42'
);
console.log('✅ Aternos Watcher-compatible classifier + DynIP persistence tests passed.');


const proxyOnline = {
  state: SERVER_STATE.ONLINE,
  candidate: { host: 'MineEmpiresOf.aternos.me', port: 25565, internal: true, source: 'aternos-main-proxy' }
};
const srvOnline = {
  state: SERVER_STATE.ONLINE,
  candidate: { host: 'mineempiresof.aternos.me', port: 13174, internal: false, source: 'system-srv' },
  remoteAddress: '203.0.113.42'
};
assert.strictEqual(chooseBestStatus([proxyOnline, srvOnline]), srvOnline, 'SRV response must win equal-state tie over proxy');
assert.strictEqual(chooseDynamicProbe([proxyOnline, srvOnline]), srvOnline, 'dynamic endpoint probe must prefer non-proxy SRV response');
console.log('✅ Proxy/SRV tie-break + observed endpoint selection tests passed.');
