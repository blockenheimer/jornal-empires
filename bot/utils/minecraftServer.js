const dns = require('dns').promises;
const dnsNative = require('dns');
const net = require('net');

const SERVER_STATE = Object.freeze({
  OFFLINE: 'offline',
  STARTING: 'starting',
  WAITING: 'waiting',
  ONLINE: 'online',
  STOPPING: 'stopping',
  UNKNOWN: 'unknown'
});

const HOST = String(process.env.ATERNOS_WATCHER_HOST || process.env.ATERNOS_DOMAIN || '').trim().replace(/\.$/, '');
const PORT = clampPort(process.env.ATERNOS_WATCHER_PORT || 25565);
const DEFAULT_TIMEOUT_MS = Math.max(1000, numberEnv('ATERNOS_WATCHER_QUERY_TIMEOUT_MS', numberEnv('SERVER_QUERY_TIMEOUT_MS', 8000)));
const RETRIES = Math.max(1, numberEnv('ATERNOS_WATCHER_QUERY_ATTEMPTS', numberEnv('SERVER_QUERY_ATTEMPTS', 1)));
const RETRY_DELAY_MS = Math.max(50, numberEnv('ATERNOS_WATCHER_QUERY_RETRY_DELAY_MS', numberEnv('SERVER_QUERY_RETRY_DELAY_MS', 750)));
const DEBUG = boolEnv('ATERNOS_WATCHER_VERBOSE', boolEnv('SERVER_STATUS_DEBUG', true));
// mcstatus (used by the reference Aternos Watcher) uses protocol version 47
// for Server List Ping unless explicitly overridden. Using -1 here made the
// Aternos proxy accept the TCP connection but never return a status packet.
const PROTOCOL_VERSION = Math.max(0, numberEnv('ATERNOS_WATCHER_PROTOCOL_VERSION', 47));
const MAX_SRV_ENDPOINTS = Math.max(1, numberEnv('ATERNOS_WATCHER_MAX_SRV_ENDPOINTS', numberEnv('SERVER_MAX_ENDPOINTS', 6)));
const DNS_SERVERS = String(process.env.SERVER_DNS_SERVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return String(raw).trim().toLowerCase() !== 'false';
}

function clampPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 25565;
  return port;
}

function writeVarInt(value) {
  let n = value >>> 0;
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let result = 0;
  let numRead = 0;
  while (true) {
    if (offset + numRead >= buffer.length) return null;
    const byte = buffer[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
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

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Timeout aguardando resposta Minecraft.')), timeoutMs);

    const tryParse = () => {
      const lengthInfo = readVarInt(buffer);
      if (!lengthInfo) return;
      const total = lengthInfo.size + lengthInfo.value;
      if (buffer.length < total) return;
      const packet = buffer.subarray(lengthInfo.size, total);
      buffer = buffer.subarray(total);
      const idInfo = readVarInt(packet);
      if (!idInfo) throw new Error('Pacote Minecraft sem ID.');
      finish(null, { id: idInfo.value, payload: packet.subarray(idInfo.size) });
    };

    const onData = (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        tryParse();
      } catch (error) {
        finish(error);
      }
    };

    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('Conexão encerrada antes da resposta Minecraft.'));

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function cleanDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').replace(/\.$/, '');
}

function stripMinecraftFormatting(value) {
  return String(value || '')
    .replace(/§./g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizePlayers(sample) {
  if (!Array.isArray(sample)) return [];
  return sample.map((item) => (typeof item?.name === 'string' ? item.name : null)).filter(Boolean);
}

function getVersionName(version) {
  if (typeof version === 'string') return version;
  if (version && typeof version.name === 'string') return version.name;
  return '';
}

/**
 * Equivalent behavior to the public Aternos Watcher classifier:
 * - offline/preparing/starting/stopping fingerprints are treated as transition states
 * - maxPlayers === 0 is treated as Aternos WAITING/Ghost Proxy
 * - otherwise the status is considered ONLINE
 */
function classifyAternosStatus(status) {
  const motd = stripMinecraftFormatting(normalizeMotd(status?.description)).toLowerCase();
  const versionName = stripMinecraftFormatting(getVersionName(status?.version)).toLowerCase();
  const combined = `${motd} ${versionName}`.trim();
  const maxPlayers = Number(status?.players?.max);

  const containsAny = (patterns) => patterns.some((pattern) => combined.includes(pattern));

  if (containsAny([
    'this server is offline',
    'server is offline',
    'server offline',
    'currently offline'
  ]) || versionName.includes('offline')) {
    return { state: SERVER_STATE.OFFLINE, reason: 'aternos-proxy-offline' };
  }

  if (containsAny([
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
  ]) || ['starting', 'preparing', 'loading'].some((word) => versionName.includes(word))) {
    return { state: SERVER_STATE.STARTING, reason: 'aternos-proxy-starting' };
  }

  if (containsAny([
    'this server is currently stopping',
    'this server is stopping',
    'server is stopping',
    'stopping'
  ]) || versionName.includes('stopping')) {
    return { state: SERVER_STATE.STOPPING, reason: 'aternos-proxy-stopping' };
  }

  if (Number.isFinite(maxPlayers) && maxPlayers === 0) {
    return { state: SERVER_STATE.WAITING, reason: 'aternos-proxy-waiting' };
  }

  return { state: SERVER_STATE.ONLINE, reason: 'minecraft-server-response' };
}

function parseStatusPayload(payload) {
  const jsonLength = readVarInt(payload);
  if (!jsonLength) throw new Error('Resposta de status sem tamanho JSON.');
  const end = jsonLength.size + jsonLength.value;
  if (end > payload.length) throw new Error('Resposta de status JSON truncada.');
  return JSON.parse(payload.subarray(jsonLength.size, end).toString('utf8'));
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', succeed);
    socket.once('timeout', () => fail(new Error('Timeout conectando ao Minecraft.')));
    socket.once('error', fail);
  });
}

async function queryMinecraftServer(connectHost, port, timeoutMs = DEFAULT_TIMEOUT_MS, handshakeHost = connectHost) {
  const startedAt = Date.now();
  const socket = await connectSocket(connectHost, port, timeoutMs);

  try {
    socket.setNoDelay(true);

    const handshakePort = Buffer.alloc(2);
    handshakePort.writeUInt16BE(port, 0);

    // Start listening BEFORE writing. This mirrors mcstatus' synchronous
    // request/read flow and avoids losing a very fast proxy response.
    const responsePromise = waitForPacket(socket, timeoutMs);

    socket.write(makePacket(
      0x00,
      writeVarInt(PROTOCOL_VERSION),
      encodeString(handshakeHost),
      handshakePort,
      writeVarInt(1)
    ));
    socket.write(makePacket(0x00));

    const response = await responsePromise;
    if (response.id !== 0x00) {
      throw new Error(`Pacote inesperado do servidor: ${response.id}`);
    }

    const raw = parseStatusPayload(response.payload);
    const classified = classifyAternosStatus(raw);

    // The reference Watcher relies on mcstatus.status(), whose latency is
    // measured from the status request to the status response. A second PING
    // is not required to determine state and some Aternos proxies close the
    // connection after returning status, so do not make it part of success.
    const ping = Date.now() - startedAt;

    return {
      state: classified.state,
      stateReason: classified.reason,
      online: classified.state === SERVER_STATE.ONLINE,
      ping,
      connectHost,
      handshakeHost,
      version: raw.version || null,
      description: normalizeMotd(raw.description),
      players: {
        online: Number.isFinite(Number(raw.players?.online)) ? Number(raw.players.online) : 0,
        max: Number.isFinite(Number(raw.players?.max)) ? Number(raw.players.max) : 0,
        sample: normalizePlayers(raw.players?.sample)
      },
      raw
    };
  } finally {
    socket.end();
  }
}

async function queryWithRetry(host, port, handshakeHost) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      return await queryMinecraftServer(host, port, DEFAULT_TIMEOUT_MS, handshakeHost);
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error('Falha ao consultar o servidor.');
}

async function resolveSrvRecords(domain) {
  const target = `_minecraft._tcp.${cleanDomain(domain)}`;
  const results = [];
  const errors = [];

  try {
    const records = await dns.resolveSrv(target);
    results.push(...records.map((record) => ({
      host: cleanDomain(record.name),
      port: clampPort(record.port),
      priority: Number(record.priority) || 0,
      weight: Number(record.weight) || 0,
      source: 'system-srv'
    })));
  } catch (error) {
    errors.push(`system-srv: ${error.message}`);
  }

  if (DNS_SERVERS.length) {
    try {
      const resolver = new dnsNative.promises.Resolver();
      resolver.setServers(DNS_SERVERS);
      const records = await resolver.resolveSrv(target);
      results.push(...records.map((record) => ({
        host: cleanDomain(record.name),
        port: clampPort(record.port),
        priority: Number(record.priority) || 0,
        weight: Number(record.weight) || 0,
        source: `dedicated-srv-${DNS_SERVERS.join(',')}`
      })));
    } catch (error) {
      errors.push(`dedicated-srv: ${error.message}`);
    }
  }

  const deduped = new Map();
  for (const record of results) {
    if (!record.host || !record.port) continue;
    const key = `${record.host.toLowerCase()}:${record.port}`;
    const previous = deduped.get(key);
    if (!previous || record.priority < previous.priority || (record.priority === previous.priority && record.weight > previous.weight)) {
      deduped.set(key, record);
    }
  }

  const endpoints = [...deduped.values()]
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .slice(0, MAX_SRV_ENDPOINTS);

  return { endpoints, errors };
}

function isTemporaryAternosHost(host) {
  const value = cleanDomain(host).toLowerCase();
  return value.endsWith('.aternos.host');
}

function sanitizeEndpoint(endpoint, sourceOverride = null) {
  if (!endpoint?.host) return null;
  const host = cleanDomain(endpoint.host);
  const port = clampPort(endpoint.port);
  if (!host || !isTemporaryAternosHost(host)) return null;
  return {
    host,
    publicHost: host,
    port,
    source: sourceOverride || endpoint.source || 'srv'
  };
}

function isValidTemporaryEndpoint(endpoint) {
  return Boolean(sanitizeEndpoint(endpoint));
}

function statusPriority(state) {
  switch (state) {
    case SERVER_STATE.ONLINE: return 5;
    case SERVER_STATE.STARTING: return 4;
    case SERVER_STATE.WAITING: return 3;
    case SERVER_STATE.STOPPING: return 2;
    case SERVER_STATE.OFFLINE: return 1;
    default: return 0;
  }
}

function chooseBestStatus(statuses) {
  return [...statuses].sort((a, b) => statusPriority(b.state) - statusPriority(a.state))[0] || null;
}

function buildDiagnostic(candidate, result = null, error = null) {
  return {
    target: `${candidate.host}:${candidate.port}`,
    source: candidate.source,
    state: result?.state || SERVER_STATE.UNKNOWN,
    reason: result?.stateReason || null,
    connectHost: result?.connectHost || candidate.host,
    ping: result?.ping ?? null,
    version: getVersionName(result?.version),
    players: result?.players ? `${result.players.online}/${result.players.max}` : null,
    error: error?.message || null
  };
}

async function getServerStatus({ domain = HOST, lastEndpoint = null } = {}) {
  const clean = cleanDomain(domain);
  if (!clean) throw new Error('ATERNOS_DOMAIN/ATERNOS_WATCHER_HOST não configurado.');

  const { endpoints: srvEndpoints, errors: srvErrors } = await resolveSrvRecords(clean);
  const candidates = [
    { host: clean, port: PORT, source: 'aternos-main-proxy', internal: true },
    ...srvEndpoints.map((endpoint) => ({ ...endpoint, internal: false }))
  ];

  // Se o SRV não puder ser resolvido, o probe principal ainda é executado.
  // Isso é importante no Aternos Watcher: o proxy do domínio principal pode
  // responder com OFFLINE/STARTING/WAITING sem o DynIP estar disponível.
  if (DEBUG) {
    if (srvEndpoints.length) {
      console.log(`🧭 Aternos SRV: ${srvEndpoints.map((e) => `${e.host}:${e.port}`).join(', ')}`);
    } else {
      console.warn(`⚠️ Aternos SRV indisponível; usando probe direto de ${clean}:${PORT}.`);
      if (srvErrors.length) console.warn(`   ↳ ${srvErrors.join(' | ')}`);
    }
  }

  const diagnostics = [];
  const results = [];

  // Os probes rodam em paralelo para que um SRV lento não atrase todo o ciclo.
  // O estado final é escolhido depois pela prioridade ONLINE > STARTING >
  // WAITING > STOPPING > OFFLINE.
  const probeResults = await Promise.allSettled(
    candidates.map(async (candidate) => ({
      candidate,
      result: await queryWithRetry(candidate.host, candidate.port, clean)
    }))
  );

  for (let index = 0; index < probeResults.length; index += 1) {
    const probe = probeResults[index];
    const candidate = candidates[index];
    if (probe.status === 'fulfilled') {
      const { result } = probe.value;
      diagnostics.push(buildDiagnostic(candidate, result));
      results.push({ ...result, candidate });
      if (DEBUG) {
        console.log(`📡 ${candidate.host}:${candidate.port}/${candidate.source} → ${result.state.toUpperCase()} (${result.stateReason})`);
      }
    } else {
      const message = probe.reason?.message || String(probe.reason);
      diagnostics.push(buildDiagnostic(candidate, null, probe.reason));
      if (DEBUG) console.warn(`   ↳ ${candidate.host}:${candidate.port}/${candidate.source} falhou: ${message}`);
    }
  }

  const best = chooseBestStatus(results);
  if (!best) {
    // UNKNOWN is retained only for a genuine inability to obtain any Minecraft
    // response at all; this prevents a transient DNS/SRV failure from fabricating
    // an OFFLINE state while still keeping the watcher compatible with Aternos.
    return {
      state: SERVER_STATE.UNKNOWN,
      online: false,
      stateReason: 'no-minecraft-response',
      endpoint: sanitizeEndpoint(lastEndpoint, 'last-known'),
      ping: null,
      diagnostics,
      resolutionDetails: srvErrors,
      players: { online: 0, max: 0, sample: [] },
      description: '',
      version: null
    };
  }

  const realEndpoint = !best.candidate.internal
    ? sanitizeEndpoint(best.candidate, best.candidate.source)
    : sanitizeEndpoint(lastEndpoint, 'last-known');

  return {
    ...best,
    endpoint: realEndpoint,
    internalEndpoint: best.candidate.internal
      ? { host: best.candidate.host, port: best.candidate.port, source: best.candidate.source }
      : null,
    diagnostics,
    resolutionDetails: srvErrors
  };
}

function stateOf(status) {
  if (!status) return SERVER_STATE.UNKNOWN;
  if (Object.values(SERVER_STATE).includes(status.state)) return status.state;
  return SERVER_STATE.UNKNOWN;
}

function isOpen(state) {
  return state === SERVER_STATE.ONLINE || state === SERVER_STATE.WAITING;
}

module.exports = {
  SERVER_STATE,
  HOST,
  PORT,
  DEFAULT_TIMEOUT_MS,
  resolveSrvRecords,
  resolveMinecraftEndpoints: async (domain = HOST) => (await resolveSrvRecords(domain)).endpoints,
  resolveMinecraftEndpoint: async (domain = HOST) => {
    const endpoints = (await resolveSrvRecords(domain)).endpoints;
    return endpoints[0] || null;
  },
  queryMinecraftServer,
  classifyAternosStatus,
  getServerStatus,
  stateOf,
  isOpen,
  isValidTemporaryEndpoint,
  sanitizeEndpoint,
  normalizeMotd,
  normalizePlayers
};
