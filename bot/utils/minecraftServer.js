const dns = require('dns').promises;
const net = require('net');

const DEFAULT_PORT = 25565;
const DEFAULT_TIMEOUT_MS = 5000;

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

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;

  while (true) {
    if (offset + numRead >= buffer.length) {
      return null;
    }

    const byte = buffer[offset + numRead];
    const value = byte & 0x7f;
    result |= value << (7 * numRead);
    numRead += 1;

    if (numRead > 5) {
      throw new Error('VarInt inválido.');
    }

    if ((byte & 0x80) === 0) {
      return { value: result, size: numRead };
    }
  }
}

function encodeString(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function makePacket(packetId, ...parts) {
  const body = Buffer.concat([writeVarInt(packetId), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function waitForPacket(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error('Timeout ao esperar resposta do servidor.')), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const tryParse = () => {
      const lengthInfo = readVarInt(buffer, 0);
      if (!lengthInfo) return;

      const totalSize = lengthInfo.size + lengthInfo.value;
      if (buffer.length < totalSize) return;

      const packet = buffer.subarray(lengthInfo.size, totalSize);
      buffer = buffer.subarray(totalSize);

      const idInfo = readVarInt(packet, 0);
      if (!idInfo) return;
      finishResolve({ id: idInfo.value, payload: packet.subarray(idInfo.size) });
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        tryParse();
      } catch (error) {
        finishReject(error);
      }
    };

    const onError = (error) => finishReject(error);
    const onClose = () => finishReject(new Error('Conexão encerrada antes da resposta.'));

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function resolveMinecraftEndpoint(domain) {
  const cleanDomain = String(domain || '').trim().replace(/\.$/, '');
  if (!cleanDomain) throw new Error('ATERNOS_DOMAIN não configurado.');

  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${cleanDomain}`);
    if (records.length > 0) {
      // Lowest priority wins. Weight is used only among equal priorities;
      // for a single Aternos target this is normally just the first record.
      records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
      const publicHost = records[0].name.replace(/\.$/, '');
      return {
        host: publicHost,
        port: records[0].port,
        source: 'srv',
        publicHost
      };
    }
  } catch (_) {
    // No SRV record (or temporary DNS issue): fall back to the main hostname
    // on the default Java port. The UI never exposes the main hostname.
  }

  return {
    host: cleanDomain,
    port: DEFAULT_PORT,
    source: 'fallback',
    publicHost: null
  };
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', finishResolve);
    socket.once('timeout', () => finishReject(new Error('Timeout ao conectar no servidor.')));
    socket.once('error', finishReject);
  });
}

async function queryMinecraftServer(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  const socket = await connectSocket(host, port, timeoutMs);

  try {
    // Status handshake (protocol version -1 means "use any compatible version").
    const handshake = makePacket(
      0x00,
      writeVarInt(-1),
      encodeString(host),
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(Number(port), 0);
        return b;
      })(),
      writeVarInt(1)
    );

    socket.write(handshake);
    socket.write(makePacket(0x00));

    const response = await waitForPacket(socket, timeoutMs);
    if (response.id !== 0x00) {
      throw new Error(`Pacote inesperado do servidor: ${response.id}`);
    }

    const jsonLength = readVarInt(response.payload, 0);
    if (!jsonLength) throw new Error('Resposta de status inválida.');

    const jsonText = response.payload
      .subarray(jsonLength.size, jsonLength.size + jsonLength.value)
      .toString('utf8');

    const status = JSON.parse(jsonText);

    // Complete the normal status exchange with a ping/pong, giving us a
    // measured round-trip time.
    const payload = Buffer.alloc(8);
    payload.writeBigInt64BE(BigInt(Date.now()), 0);
    socket.write(makePacket(0x01, payload));

    const pong = await waitForPacket(socket, timeoutMs);
    if (pong.id !== 0x01) {
      throw new Error(`Pong inesperado do servidor: ${pong.id}`);
    }

    const ping = Date.now() - startedAt;

    return {
      online: true,
      ping,
      version: status.version || null,
      description: normalizeMotd(status.description),
      players: {
        online: Number.isFinite(status.players?.online) ? status.players.online : 0,
        max: Number.isFinite(status.players?.max) ? status.players.max : 0,
        sample: normalizePlayers(status.players?.sample)
      },
      raw: status
    };
  } finally {
    socket.end();
  }
}

function normalizePlayers(sample) {
  if (!Array.isArray(sample)) return [];
  return sample
    .map((p) => (typeof p?.name === 'string' ? p.name : null))
    .filter(Boolean);
}

function normalizeMotd(description) {
  if (typeof description === 'string') return description;
  if (description && typeof description.text === 'string') return description.text;
  if (description && Array.isArray(description.extra)) {
    return description.extra.map((part) => part?.text || '').join('');
  }
  return '';
}

async function getServerStatus({ domain, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const endpoint = await resolveMinecraftEndpoint(domain);
  try {
    const status = await queryMinecraftServer(endpoint.host, endpoint.port, timeoutMs);
    return { endpoint, ...status };
  } catch (error) {
    return {
      endpoint,
      online: false,
      ping: null,
      error
    };
  }
}

module.exports = {
  resolveMinecraftEndpoint,
  queryMinecraftServer,
  getServerStatus
};
