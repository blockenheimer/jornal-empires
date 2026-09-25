const assert = require('assert');

const {
  SERVER_STATE,
  classifyAternosStatus,
  stateOf,
  sanitizeEndpoint,
  isValidTemporaryEndpoint
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
assert.deepStrictEqual(
  sanitizeEndpoint({ host: 'example.aternos.host.', port: 41235 }, 'srv').publicHost,
  'example.aternos.host'
);
assert.strictEqual(stateOf({ state: SERVER_STATE.UNKNOWN }), SERVER_STATE.UNKNOWN);

console.log('✅ Aternos Watcher-compatible classifier tests passed.');
