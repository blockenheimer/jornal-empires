const assert = require('assert/strict');
const net = require('net');
const {
  SERVER_STATE,
  classifyAternosStatus,
  stateOf,
  sanitizeEndpoint,
  queryMinecraftServer,
  parseConfiguredAternosAddress
} = require('../utils/minecraftServer');

function writeVarInt(value) {
  const bytes = [];
  let n = value >>> 0;
  do {
    let temp = n & 0x7f;
    n >>>= 7;
    if (n !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (n !== 0);
  return Buffer.from(bytes);
}

function makeStatusPacket(status) {
  const json = Buffer.from(JSON.stringify(status), 'utf8');
  const payload = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(json.length),
    json
  ]);
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function startMockMinecraft(status) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(makeStatusPacket(status));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  assert.equal(classifyAternosStatus({ description: 'This server is offline', version: { name: 'Offline' }, players: { max: 0 } }).state, SERVER_STATE.OFFLINE);
  assert.equal(classifyAternosStatus({ description: 'This server is currently starting', version: { name: 'Starting' }, players: { max: 0 } }).state, SERVER_STATE.STARTING);
  assert.equal(classifyAternosStatus({ description: 'Waiting for server', version: { name: 'Aternos' }, players: { max: 0 } }).state, SERVER_STATE.OFFLINE);
  assert.equal(classifyAternosStatus({ description: 'Empires SMP', version: { name: '1.21.8', protocol: 772 }, players: { online: 0, max: 20 } }).state, SERVER_STATE.ONLINE);

  assert.equal(sanitizeEndpoint({ host: 'MineEmpiresOf.aternos.me', port: 25565 }), null);
  assert.equal(sanitizeEndpoint({ host: 'example.aternos.host', port: 12345 }).publicHost, 'example.aternos.host');
  assert.equal(stateOf({ state: SERVER_STATE.UNKNOWN, online: false }), SERVER_STATE.UNKNOWN);

  assert.deepEqual(parseConfiguredAternosAddress('MineEmpiresOf.aternos.me:13174'), {
    host: 'MineEmpiresOf.aternos.me',
    port: 13174,
    source: 'configured-address',
    publicHostDetected: false,
    internal: true
  });
  assert.equal(parseConfiguredAternosAddress('MineEmpiresOf.aternos.me'), null);

  const server = await startMockMinecraft({
    version: { name: '1.21.8', protocol: 772 },
    players: { online: 0, max: 20, sample: [] },
    description: { text: 'Empires SMP' }
  });
  const address = server.address();
  const status = await queryMinecraftServer(
    '127.0.0.1',
    address.port,
    2500,
    'MineEmpiresOf.aternos.me'
  );
  assert.equal(status.state, SERVER_STATE.ONLINE);
  assert.equal(status.handshakeHost, 'MineEmpiresOf.aternos.me');
  await new Promise((resolve) => server.close(resolve));

  console.log('✅ Aternos status tests passed.');
})().catch((error) => {
  console.error('❌ Aternos status tests failed:', error);
  process.exit(1);
});

