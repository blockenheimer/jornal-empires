const dns = require('dns').promises;
const net = require('net');
const dgram = require('dgram');

// Nunca usamos uma porta fixa para descobrir o DynIP da Aternos. O SRV é a
// fonte principal de host + porta e a porta pode mudar a cada inicialização.
const DEFAULT_JAVA_PORT = 25565;
const DEFAULT_TIMEOUT_MS = Number(process.env.SERVER_QUERY_TIMEOUT_MS || 8000);
const QUERY_ATTEMPTS = Math.max(1, Number(process.env.SERVER_QUERY_ATTEMPTS || 2));
const QUERY_RETRY_DELAY_MS = Math.max(100, Number(process.env.SERVER_QUERY_RETRY_DELAY_MS || 750));

const SERVER_STATE = {
  ONLINE: 'online',
  STARTING: 'starting',
  OFFLINE: 'offline'
};

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
    if (offset + numRead >= buffer.length) return null;

    const byte = buffer[offset + numRead];
    const value = byte & 0x7f;
    result |= value << (7 * numRead);
    numRead += 1;

    if (numRead > 5) throw new Error('VarInt inválido.');
    if ((byte & 0x80) === 0) return { value: result, size: numRead };
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

function cleanDomain(domain) {
  return String(domain || '').trim().replace(/\.$/, '');
}

function isTemporaryHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').endsWith('.aternos.host');
}

function isValidTemporaryEndpoint(endpoint) {
  const host = String(endpoint?.publicHost || endpoint?.host || '').trim().replace(/\.$/, '');
  const port = Number(endpoint?.port);
  return isTemporaryHost(host) && Number.isInteger(port) && port > 0 && port <= 65535;
}

function sanitizeEndpoint(endpoint, sourceOverride = null) {
  if (!isValidTemporaryEndpoint(endpoint)) return null;

  const host = String(endpoint.publicHost || endpoint.host).trim().replace(/\.$/, '');
  return {
    host,
    publicHost: host,
    port: Number(endpoint.port),
    source: sourceOverride || endpoint.source || 'srv'
  };
}

async function resolveMinecraftEndpoint(domain) {
  const clean = cleanDomain(domain);
  if (!clean) throw new Error('ATERNOS_DOMAIN não configurado.');

  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${clean}`);
    if (!records.length) throw new Error('Registro SRV não encontrado.');

    records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
    const chosen = records[0];
    const target = String(chosen.name || '').replace(/\.$/, '');
    const port = Number(chosen.port);

    if (!target || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Registro SRV inválido.');
    }

    return {
      host: target,
      port,
      source: isTemporaryHost(target) ? 'srv-dynip' : 'srv-alias',
      publicHost: isTemporaryHost(target) ? target : null,
      publicHostDetected: isTemporaryHost(target)
    };
  } catch (error) {
    const wrapped = new Error(`Não foi possível resolver o DynIP via SRV: ${error.message}`);
    wrapped.code = 'SRV_UNAVAILABLE';
    wrapped.cause = error;
    throw wrapped;
  }
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

function queryBedrockServer(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    const startedAt = Date.now();
    let settled = false;

    const magic = Buffer.from([
      0x00, 0xff, 0xff, 0x00,
      0xfe, 0xfe, 0xfe, 0xfe,
      0xfd, 0xfd, 0xfd, 0xfd,
      0x12, 0x34, 0x56, 0x78
    ]);
    const timestamp = Buffer.alloc(8);
    timestamp.writeBigInt64BE(BigInt(Date.now()), 0);
    const clientGuid = Buffer.alloc(8);
    clientGuid.writeBigInt64BE(BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)), 0);
    const packet = Buffer.concat([Buffer.from([0x01]), timestamp, magic, clientGuid]);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* noop */ }
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('Timeout no ping Bedrock.')), timeoutMs);

    socket.once('error', (error) => finish(error));
    socket.once('message', (message) => {
      if (message.length < 35 || message[0] !== 0x1c) {
        return finish(new Error('Resposta Bedrock inválida.'));
      }

      try {
        let offset = 1 + 8 + 8 + 16;
        if (offset + 2 > message.length) throw new Error('Resposta Bedrock truncada.');
        const stringLength = message.readUInt16BE(offset);
        offset += 2;
        const serverInfo = message.subarray(offset, offset + stringLength).toString('utf8');
        const fields = serverInfo.split(';');

        const online = Number.parseInt(fields[4], 10);
        const max = Number.parseInt(fields[5], 10);
        const description = fields[1] || '';
        const version = fields[3] || null;
        const classified = classifyAternosStatus({
          description,
          version: { name: version },
          players: { online, max }
        });

        finish(null, {
          online: classified.state === SERVER_STATE.ONLINE,
          state: classified.state,
          stateReason: classified.reason,
          ping: Date.now() - startedAt,
          version,
          description,
          players: {
            online: Number.isFinite(online) ? online : 0,
            max: Number.isFinite(max) ? max : 0,
            sample: []
          },
          raw: {
            edition: fields[0] || 'MCPE',
            serverInfo
          }
        });
      } catch (error) {
        finish(error);
      }
    });

    socket.send(packet, 0, packet.length, Number(port), host, (error) => {
      if (error) finish(error);
    });
  });
}

async function queryMinecraftServer(host, port, timeoutMs = DEFAULT_TIMEOUT_MS, handshakeHost = host) {
  const startedAt = Date.now();
  const socket = await connectSocket(host, port, timeoutMs);

  try {
    const handshake = makePacket(
      0x00,
      writeVarInt(-1),
      encodeString(handshakeHost),
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
    if (response.id !== 0x00) throw new Error(`Pacote inesperado do servidor: ${response.id}`);

    const jsonLength = readVarInt(response.payload, 0);
    if (!jsonLength) throw new Error('Resposta de status inválida.');

    const jsonText = response.payload
      .subarray(jsonLength.size, jsonLength.size + jsonLength.value)
      .toString('utf8');

    const status = JSON.parse(jsonText);
    const classified = classifyAternosStatus(status);

    // O pong é opcional: o status já é suficiente para classificar o estado.
    let ping = Date.now() - startedAt;
    try {
      const payload = Buffer.alloc(8);
      payload.writeBigInt64BE(BigInt(Date.now()), 0);
      socket.write(makePacket(0x01, payload));

      const pong = await waitForPacket(socket, Math.min(timeoutMs, 1500));
      if (pong.id === 0x01) ping = Date.now() - startedAt;
    } catch (_) {
      // Alguns proxies fecham após o status. Isso não invalida a leitura.
    }

    let detectedPublicHost = null;
    try {
      const remoteAddress = socket.remoteAddress;
      if (remoteAddress) {
        const ptrs = await dns.reverse(remoteAddress);
        detectedPublicHost = ptrs.find((name) => isTemporaryHost(name)) || null;
      }
    } catch (_) {
      // PTR é apenas complementar; o SRV continua sendo a fonte principal.
    }

    return {
      online: classified.state === SERVER_STATE.ONLINE,
      state: classified.state,
      stateReason: classified.reason,
      ping,
      version: status.version || null,
      description: normalizeMotd(status.description),
      players: {
        online: Number.isFinite(status.players?.online) ? status.players.online : 0,
        max: Number.isFinite(status.players?.max) ? status.players.max : 0,
        sample: normalizePlayers(status.players?.sample)
      },
      detectedPublicHost: isTemporaryHost(detectedPublicHost) ? detectedPublicHost : null,
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
  if (description && typeof description.text === 'string') {
    const extras = Array.isArray(description.extra)
      ? description.extra.map((part) => part?.text || '').join('')
      : '';
    return `${description.text}${extras}`;
  }
  if (description && Array.isArray(description.extra)) {
    return description.extra.map((part) => part?.text || '').join('');
  }
  return '';
}

function textForDetection(value) {
  return String(value || '')
    .replace(/§./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getVersionName(version) {
  if (typeof version === 'string') return version;
  if (version && typeof version.name === 'string') return version.name;
  return '';
}

// Aternos pode responder ao ping mesmo quando o Minecraft real ainda não está
// disponível. Esse fingerprint segue a estratégia do Aternos Watcher público:
// diferenciar as respostas "offline/preparing/starting" do servidor real e
// tratar maxPlayers=0 como proxy de espera, em vez de considerá-lo ONLINE.
function classifyAternosStatus(status) {
  const motd = textForDetection(normalizeMotd(status?.description));
  const versionName = textForDetection(getVersionName(status?.version));
  const maxPlayers = Number(status?.players?.max);

  const combined = `${motd} ${versionName}`.trim();

  const offlinePatterns = [
    'this server is offline',
    'server is offline',
    'server offline'
  ];
  const startingPatterns = [
    'this server is currently preparing',
    'this server is preparing',
    'server is preparing',
    'this server is currently starting',
    'this server is starting',
    'server is starting',
    'starting up',
    'booting up',
    'server is loading',
    'preparing'
  ];
  const stoppingPatterns = [
    'this server is currently stopping',
    'this server is stopping',
    'server is stopping',
    'stopping'
  ];

  if (versionName.includes('offline') || offlinePatterns.some((pattern) => combined.includes(pattern))) {
    return { state: SERVER_STATE.OFFLINE, reason: 'aternos-proxy-offline' };
  }

  if (versionName.includes('starting') || versionName.includes('preparing') || versionName.includes('loading') || startingPatterns.some((pattern) => combined.includes(pattern))) {
    return { state: SERVER_STATE.STARTING, reason: 'aternos-proxy-starting' };
  }

  if (versionName.includes('stopping') || stoppingPatterns.some((pattern) => combined.includes(pattern))) {
    return { state: SERVER_STATE.OFFLINE, reason: 'aternos-proxy-stopping' };
  }

  // A proxy de espera da Aternos pode aceitar o ping, mas anuncia zero slots.
  // Sem uma assinatura explícita de "starting", isso é tratado como OFFLINE
  // para nunca transformar a sala de espera em falso ONLINE.
  if (Number.isFinite(maxPlayers) && maxPlayers <= 0) {
    return { state: SERVER_STATE.OFFLINE, reason: 'aternos-proxy-waiting' };
  }

  return { state: SERVER_STATE.ONLINE, reason: 'minecraft-server-response' };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryEndpoint(endpoint, domain, timeoutMs) {
  let lastError = null;

  try {
    const status = await queryMinecraftServer(
      endpoint.host,
      endpoint.port,
      timeoutMs,
      cleanDomain(domain)
    );

    if (status.detectedPublicHost) {
      endpoint.publicHost = status.detectedPublicHost;
      endpoint.host = status.detectedPublicHost;
      endpoint.publicHostDetected = true;
      endpoint.source = `${endpoint.source}+ptr`;
    }

    return { endpoint, ...status, edition: 'java' };
  } catch (javaError) {
    lastError = javaError;
  }

  try {
    const status = await queryBedrockServer(endpoint.host, endpoint.port, timeoutMs);
    return { endpoint, ...status, edition: 'bedrock' };
  } catch (bedrockError) {
    bedrockError.javaError = lastError;
    throw bedrockError;
  }
}

async function getServerStatus({ domain, timeoutMs = DEFAULT_TIMEOUT_MS, lastEndpoint = null }) {
  const clean = cleanDomain(domain);
  let endpoint = null;
  let resolutionError = null;

  try {
    endpoint = await resolveMinecraftEndpoint(clean);
  } catch (error) {
    resolutionError = error;
  }

  // NÃO existe mais fallback para <domínio>.aternos.me:25565. Isso era uma
  // fonte direta de falso positivo porque o front-end/proxy pode responder
  // mesmo quando o Minecraft real está parado.
  if (!endpoint && isValidTemporaryEndpoint(lastEndpoint)) {
    endpoint = sanitizeEndpoint(lastEndpoint, 'last-known');
  }

  if (!endpoint) {
    return {
      endpoint: isValidTemporaryEndpoint(lastEndpoint) ? sanitizeEndpoint(lastEndpoint, 'last-known') : null,
      online: false,
      state: SERVER_STATE.OFFLINE,
      stateReason: 'srv-unavailable',
      ping: null,
      error: resolutionError || new Error('DynIP temporário indisponível.')
    };
  }

  let lastError = null;
  const attempts = endpoint.source === 'last-known' ? 1 : QUERY_ATTEMPTS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await queryEndpoint(endpoint, clean, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(QUERY_RETRY_DELAY_MS);
    }
  }

  return {
    endpoint,
    online: false,
    state: SERVER_STATE.OFFLINE,
    stateReason: 'query-failed',
    ping: null,
    error: lastError || resolutionError || new Error('Não foi possível consultar o servidor.')
  };
}

function stateOf(status) {
  if (status?.state === SERVER_STATE.STARTING) return SERVER_STATE.STARTING;
  if (status?.state === SERVER_STATE.ONLINE && status?.online) return SERVER_STATE.ONLINE;
  return SERVER_STATE.OFFLINE;
}

module.exports = {
  SERVER_STATE,
  resolveMinecraftEndpoint,
  queryMinecraftServer,
  queryBedrockServer,
  classifyAternosStatus,
  stateOf,
  getServerStatus,
  isValidTemporaryEndpoint,
  sanitizeEndpoint,
  DEFAULT_JAVA_PORT
};
