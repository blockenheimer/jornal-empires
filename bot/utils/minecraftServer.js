const dns = require('dns').promises;
const dnsNative = require('dns');
const net = require('net');
const dgram = require('dgram');
const https = require('https');

const DEFAULT_JAVA_PORT = 25565;
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.SERVER_QUERY_TIMEOUT_MS || 8000));
const QUERY_ATTEMPTS = Math.max(1, Number(process.env.SERVER_QUERY_ATTEMPTS || 2));
const QUERY_RETRY_DELAY_MS = Math.max(100, Number(process.env.SERVER_QUERY_RETRY_DELAY_MS || 750));
const DNS_HTTP_TIMEOUT_MS = Math.max(1000, Number(process.env.SERVER_DNS_HTTP_TIMEOUT_MS || 5000));
const MAX_ENDPOINTS = Math.max(1, Number(process.env.SERVER_MAX_ENDPOINTS || 6));
const MAX_ADDRESSES_PER_ENDPOINT = Math.max(1, Number(process.env.SERVER_MAX_ADDRESSES_PER_ENDPOINT || 3));
const STATUS_CHECK_BUDGET_MS = Math.max(5000, Number(process.env.SERVER_STATUS_CHECK_BUDGET_MS || 12000));
const DEBUG_STATUS = String(process.env.SERVER_STATUS_DEBUG || 'true').toLowerCase() !== 'false';
const DNS_SERVERS = String(process.env.SERVER_DNS_SERVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const MCSTATUS_FALLBACK = String(process.env.SERVER_MCSTATUS_FALLBACK || 'true').toLowerCase() !== 'false';

const DOH_PROVIDERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', ips: ['1.1.1.1', '1.0.0.1'] },
  { name: 'google', url: 'https://dns.google/resolve', ips: ['8.8.8.8', '8.8.4.4'] }
];

const SERVER_STATE = {
  ONLINE: 'online',
  STARTING: 'starting',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown'
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
  const value = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value) return false;

  if (value.endsWith('.aternos.host')) return true;
  if (value.endsWith('.aternos.me')) return false;
  if (value === 'localhost' || value === '0.0.0.0' || value === '::') return false;

  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
  const ipv6 = value.includes(':');
  const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
  return ipv4 || ipv6 || hostname;
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

function endpointKey(endpoint) {
  return `${String(endpoint?.host || '').toLowerCase().replace(/\.$/, '')}:${Number(endpoint?.port || 0)}`;
}

function chooseSrvRecords(records) {
  return [...records].sort((a, b) => {
    const priorityDiff = Number(a.priority) - Number(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    return Number(b.weight) - Number(a.weight);
  });
}

function parseSrvAnswer(data) {
  if (typeof data !== 'string') return null;
  const parts = data.trim().replace(/\.$/, '').split(/\s+/);
  if (parts.length < 4) return null;

  const priority = Number(parts[0]);
  const weight = Number(parts[1]);
  const port = Number(parts[2]);
  const name = parts.slice(3).join('');

  if (!Number.isInteger(priority) || !Number.isInteger(weight) || !Number.isInteger(port) || !name) return null;
  if (port <= 0 || port > 65535) return null;

  return { priority, weight, port, name: name.replace(/\.$/, '') };
}

function httpsJson(url, timeoutMs = DNS_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        accept: 'application/dns-json'
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`DoH HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Resposta DoH inválida: ${error.message}`));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Timeout DoH.'));
    });
    request.on('error', reject);
  });
}

function httpsJsonViaIp(urlString, ip, timeoutMs = DNS_HTTP_TIMEOUT_MS) {
  const target = new URL(urlString);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: ip,
      port: 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      servername: target.hostname,
      headers: {
        host: target.hostname,
        accept: 'application/dns-json'
      },
      timeout: timeoutMs,
      family: 4,
      rejectUnauthorized: true
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`DoH ${target.hostname}@${ip} HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Resposta DoH inválida (${target.hostname}@${ip}): ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`Timeout DoH ${target.hostname}@${ip}.`)));
    request.on('error', reject);
    request.end();
  });
}

async function resolveSrvViaDedicatedResolver(domain) {
  const resolver = new dnsNative.promises.Resolver();
  resolver.setServers(DNS_SERVERS);
  const records = await resolver.resolveSrv(`_minecraft._tcp.${domain}`);
  return records.map((record) => ({ ...record, source: `dedicated-srv-${DNS_SERVERS.join(',')}` }));
}

async function resolveDnsJsonViaDoh(name, type, provider) {
  const query = `${provider.url}?name=${encodeURIComponent(name)}&type=${type}&cd=1&_=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const errors = [];

  for (const ip of provider.ips) {
    try {
      const data = await httpsJsonViaIp(query, ip);
      return Array.isArray(data.Answer) ? data.Answer : [];
    } catch (error) {
      errors.push(`${ip}: ${error.message}`);
    }
  }

  try {
    const data = await httpsJson(query);
    return Array.isArray(data.Answer) ? data.Answer : [];
  } catch (error) {
    errors.push(`hostname: ${error.message}`);
    const err = new Error(`${provider.name} DoH ${type} indisponível: ${errors.join(' | ')}`);
    err.details = errors;
    throw err;
  }
}

async function resolveSrvViaDoh(domain, provider) {
  const name = `_minecraft._tcp.${domain}`;
  const query = `${provider.url}?name=${encodeURIComponent(name)}&type=SRV&cd=1&_=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const errors = [];

  for (const ip of provider.ips) {
    try {
      const data = await httpsJsonViaIp(query, ip);
      const answers = Array.isArray(data.Answer) ? data.Answer : [];
      return answers
        .map((answer) => parseSrvAnswer(answer.data))
        .filter(Boolean)
        .map((record) => ({ ...record, source: `doh-${provider.name}` }));
    } catch (error) {
      errors.push(`${ip}: ${error.message}`);
    }
  }

  // Fallback final: hostname-based HTTPS, useful when the environment has DNS
  // but direct connections to public resolver IPs are blocked.
  try {
    const data = await httpsJson(query);
    const answers = Array.isArray(data.Answer) ? data.Answer : [];
    return answers
      .map((answer) => parseSrvAnswer(answer.data))
      .filter(Boolean)
      .map((record) => ({ ...record, source: `doh-${provider.name}-hostname` }));
  } catch (error) {
    errors.push(`hostname: ${error.message}`);
    const err = new Error(`${provider.name} DoH indisponível: ${errors.join(' | ')}`);
    err.details = errors;
    throw err;
  }
}

async function resolveSrvViaMcstatus(domain) {
  const encoded = encodeURIComponent(domain);
  const url = `https://api.mcstatus.io/v2/status/java/${encoded}?query=false&timeout=4`;
  const data = await httpsJson(url, Math.min(DNS_HTTP_TIMEOUT_MS, 5000));
  const srv = data?.srv_record;
  if (!srv || !srv.host || !Number.isInteger(Number(srv.port)) || Number(srv.port) <= 0) {
    throw new Error('mcstatus.io não retornou um SRV utilizável.');
  }
  return [{
    name: String(srv.host).replace(/\.$/, ''),
    port: Number(srv.port),
    priority: 0,
    weight: 0,
    source: 'mcstatus-srv'
  }];
}

async function resolveMinecraftEndpointRecords(domain) {
  const clean = cleanDomain(domain);
  if (!clean) throw new Error('ATERNOS_DOMAIN não configurado.');

  const results = [];
  const errors = [];

  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${clean}`);
    results.push(...records.map((record) => ({ ...record, source: 'system-srv' })));
  } catch (error) {
    errors.push(`system-srv: ${error.message}`);
  }

  try {
    const records = await resolveSrvViaDedicatedResolver(clean);
    results.push(...records);
  } catch (error) {
    errors.push(`dedicated-srv: ${error.message}`);
  }

  const dohResults = await Promise.allSettled(
    DOH_PROVIDERS.map(async (provider) => ({
      provider: provider.name,
      records: await resolveSrvViaDoh(clean, provider)
    }))
  );

  for (const result of dohResults) {
    if (result.status === 'fulfilled') {
      for (const record of result.value.records) {
        results.push(record);
      }
    } else {
      errors.push(`doh: ${result.reason?.message || result.reason}`);
    }
  }

  // Último recurso: usar um serviço externo apenas para descobrir o SRV atual.
  // O status final continua sendo validado pelo nosso próprio ping direto ao
  // endpoint descoberto, então não herdamos o cache/status do serviço externo.
  if (!results.length && MCSTATUS_FALLBACK) {
    try {
      const records = await resolveSrvViaMcstatus(clean);
      results.push(...records);
    } catch (error) {
      errors.push(`mcstatus-fallback: ${error.message}`);
    }
  }

  const valid = results
    .map((record) => {
      const target = cleanDomain(record.name);
      const port = Number(record.port);
      if (!target || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
      return {
        host: target,
        port,
        source: record.source,
        publicHost: isTemporaryHost(target) ? target : null,
        publicHostDetected: isTemporaryHost(target),
        priority: Number(record.priority) || 0,
        weight: Number(record.weight) || 0
      };
    })
    .filter(Boolean);

  const deduped = new Map();
  for (const endpoint of valid) {
    const key = endpointKey(endpoint);
    const previous = deduped.get(key);
    if (!previous || endpoint.priority < previous.priority || (endpoint.priority === previous.priority && endpoint.weight > previous.weight)) {
      deduped.set(key, endpoint);
    }
  }

  const endpoints = chooseSrvRecords([...deduped.values()]).slice(0, MAX_ENDPOINTS);
  return { endpoints, errors };
}

async function resolveMinecraftEndpoints(domain) {
  const { endpoints, errors } = await resolveMinecraftEndpointRecords(domain);
  if (!endpoints.length) {
    const error = new Error(`Não foi possível resolver o DynIP via SRV${errors.length ? `: ${errors.join(' | ')}` : '.'}`);
    error.code = 'SRV_UNAVAILABLE';
    error.details = errors;
    throw error;
  }
  return endpoints;
}

async function resolveMinecraftEndpoint(domain) {
  const endpoints = await resolveMinecraftEndpoints(domain);
  const chosen = endpoints[0];
  return {
    host: chosen.host,
    port: chosen.port,
    source: chosen.source,
    publicHost: chosen.publicHost,
    publicHostDetected: chosen.publicHostDetected
  };
}

async function resolveHostAddresses(host) {
  const value = cleanDomain(host);
  const addresses = [];
  const seen = new Set();
  const add = (address, source) => {
    const normalized = String(address || '').replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!normalized || seen.has(normalized) || !net.isIP(normalized)) return;
    seen.add(normalized);
    addresses.push({ address: normalized, source });
  };

  if (net.isIP(value)) {
    add(value, 'literal');
    return addresses.slice(0, MAX_ADDRESSES_PER_ENDPOINT);
  }

  // 1) DNS padrão do host.
  const systemResults = await Promise.allSettled([dns.resolve4(value), dns.resolve6(value)]);
  if (systemResults[0].status === 'fulfilled') systemResults[0].value.forEach((ip) => add(ip, 'system-a'));
  if (systemResults[1].status === 'fulfilled') systemResults[1].value.forEach((ip) => add(ip, 'system-aaaa'));

  // 2) Resolvedor DNS independente, configurado por IP.
  try {
    const resolver = new dnsNative.promises.Resolver();
    resolver.setServers(DNS_SERVERS);
    const dedicated = await Promise.allSettled([resolver.resolve4(value), resolver.resolve6(value)]);
    if (dedicated[0].status === 'fulfilled') dedicated[0].value.forEach((ip) => add(ip, 'dedicated-a'));
    if (dedicated[1].status === 'fulfilled') dedicated[1].value.forEach((ip) => add(ip, 'dedicated-aaaa'));
  } catch (_) {
    // Continua para DoH.
  }

  // 3) DNS-over-HTTPS conectado diretamente aos IPs públicos dos resolvedores,
  // evitando depender do DNS local do ambiente.
  for (const provider of DOH_PROVIDERS) {
    const providerResults = await Promise.allSettled([
      resolveDnsJsonViaDoh(value, 'A', provider),
      resolveDnsJsonViaDoh(value, 'AAAA', provider)
    ]);

    providerResults.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      for (const answer of result.value) {
        if (typeof answer?.data === 'string') {
          add(answer.data, `doh-${provider.name}-${index === 0 ? 'A' : 'AAAA'}`);
        }
      }
    });
  }

  return addresses.slice(0, MAX_ADDRESSES_PER_ENDPOINT);
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
          version: { name: version },
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

async function queryMinecraftServer(connectHost, port, timeoutMs = DEFAULT_TIMEOUT_MS, handshakeHost = connectHost) {
  const startedAt = Date.now();
  const socket = await connectSocket(connectHost, port, timeoutMs);

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

    return {
      online: classified.state === SERVER_STATE.ONLINE,
      state: classified.state,
      stateReason: classified.reason,
      ping,
      connectHost,
      handshakeHost,
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

function classifyAternosStatus(status) {
  const motd = textForDetection(normalizeMotd(status?.description));
  const versionName = textForDetection(getVersionName(status?.version));
  const maxPlayers = Number(status?.players?.max);
  const protocol = Number(status?.version?.protocol);

  const combined = `${motd} ${versionName}`.trim();

  const offlinePatterns = [
    'this server is offline',
    'server is offline',
    'server offline',
    'currently offline'
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

  // O proxy de espera da Aternos normalmente anuncia zero slots. Mantemos essa
  // proteção porque é justamente o caso em que o proxy aceita o Server List
  // Ping mesmo sem o backend Minecraft estar aberto.
  if (Number.isFinite(maxPlayers) && maxPlayers <= 0) {
    return {
      state: SERVER_STATE.OFFLINE,
      reason: 'aternos-proxy-waiting',
      details: { maxPlayers, protocol: Number.isFinite(protocol) ? protocol : null }
    };
  }

  return { state: SERVER_STATE.ONLINE, reason: 'minecraft-server-response' };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDiagnostic(endpoint, connectCandidate, status, error = null) {
  return {
    endpoint: `${endpoint.host}:${endpoint.port}`,
    source: endpoint.source,
    connectHost: connectCandidate?.address || endpoint.host,
    addressSource: connectCandidate?.source || 'hostname',
    state: status?.state || SERVER_STATE.UNKNOWN,
    reason: status?.stateReason || null,
    ping: status?.ping ?? null,
    version: getVersionName(status?.version),
    players: status?.players ? `${status.players.online}/${status.players.max}` : null,
    error: error?.message || null
  };
}

async function queryEndpoint(endpoint, domain, timeoutMs, deadline = Date.now() + timeoutMs) {
  // O handshake do Minecraft deve continuar usando o domínio que o usuário
  // configurou. O SRV/DynIP serve para descobrir PARA ONDE conectar; não
  // substituímos o hostname lógico usado pelo proxy Aternos.
  const handshakeHost = cleanDomain(domain);
  const diagnostics = [];
  let bestStatus = null;

  let addressCandidates = [];
  try {
    addressCandidates = await resolveHostAddresses(endpoint.host);
  } catch (_) {
    addressCandidates = [];
  }

  const targets = [];
  for (const candidate of addressCandidates) targets.push(candidate);
  targets.push({ address: endpoint.host, source: 'hostname-fallback' });

  const seenTargets = new Set();
  const limitedTargets = targets.filter((candidate) => {
    const key = candidate.address.toLowerCase();
    if (seenTargets.has(key)) return false;
    seenTargets.add(key);
    return true;
  }).slice(0, MAX_ADDRESSES_PER_ENDPOINT + 1);

  for (const candidate of limitedTargets) {
    for (let attempt = 1; attempt <= QUERY_ATTEMPTS; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 1000) break;
      try {
        const status = await queryMinecraftServer(
          candidate.address,
          endpoint.port,
          Math.min(timeoutMs, remainingMs),
          handshakeHost
        );

        diagnostics.push(makeDiagnostic(endpoint, candidate, status));

        if (!bestStatus || statePriority(status.state) > statePriority(bestStatus.state)) {
          bestStatus = status;
        }

        if (status.state === SERVER_STATE.ONLINE) {
          return { endpoint, ...status, edition: 'java', diagnostics };
        }

        if (status.state === SERVER_STATE.STARTING) {
          // Ainda tentamos outros IPs do mesmo endpoint; se outro nó já estiver
          // servindo o backend real, ONLINE ganha prioridade.
        }
        break;
      } catch (javaError) {
        const remainingAfterJava = deadline - Date.now();
        if (remainingAfterJava < 1000) break;
        try {
          const status = await queryBedrockServer(candidate.address, endpoint.port, Math.min(timeoutMs, remainingAfterJava));
          diagnostics.push(makeDiagnostic(endpoint, candidate, status));
          if (!bestStatus || statePriority(status.state) > statePriority(bestStatus.state)) {
            bestStatus = status;
          }
          if (status.state === SERVER_STATE.ONLINE) {
            return { endpoint, ...status, edition: 'bedrock', diagnostics };
          }
          break;
        } catch (bedrockError) {
          diagnostics.push(makeDiagnostic(endpoint, candidate, null, bedrockError));
          if (attempt < QUERY_ATTEMPTS && (deadline - Date.now()) >= 1000) {
            await delay(Math.min(QUERY_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
          }
          else if (DEBUG_STATUS) {
            console.log(`   ↳ ${endpoint.host}:${endpoint.port} via ${candidate.address} falhou (${bedrockError.message})`);
          }
        }
      }
    }
  }

  if (bestStatus) return { endpoint, ...bestStatus, diagnostics };

  const error = new Error(`Nenhum endpoint respondeu ao ping: ${endpoint.host}:${endpoint.port}`);
  error.diagnostics = diagnostics;
  throw error;
}

function statePriority(state) {
  switch (state) {
    case SERVER_STATE.ONLINE: return 4;
    case SERVER_STATE.STARTING: return 3;
    case SERVER_STATE.OFFLINE: return 2;
    default: return 1;
  }
}

function mergeEndpointCandidate(list, endpoint) {
  const safe = sanitizeEndpoint(endpoint, endpoint?.source || 'srv');
  if (!safe) return;
  const key = endpointKey(safe);
  const existing = list.find((item) => endpointKey(item) === key);
  if (!existing) {
    list.push(safe);
    return;
  }

  const preferredSources = ['system-srv', 'doh-cloudflare', 'doh-google', 'last-known'];
  const existingRank = preferredSources.indexOf(existing.source);
  const newRank = preferredSources.indexOf(safe.source);
  if (newRank !== -1 && (existingRank === -1 || newRank < existingRank)) {
    Object.assign(existing, safe);
  }
}

function combineStatuses(statuses) {
  if (!statuses.length) return null;
  const sorted = [...statuses].sort((a, b) => statePriority(b.state) - statePriority(a.state));
  return sorted[0];
}

async function getServerStatus({ domain, timeoutMs = DEFAULT_TIMEOUT_MS, lastEndpoint = null }) {
  const clean = cleanDomain(domain);
  let currentEndpoints = [];
  let resolutionError = null;
  let resolutionDetails = [];

  try {
    const resolved = await resolveMinecraftEndpointRecords(clean);
    currentEndpoints = resolved.endpoints.map((endpoint) => ({ ...endpoint }));
    resolutionDetails = resolved.errors;
  } catch (error) {
    resolutionError = error;
  }

  const endpoints = [];
  for (const endpoint of currentEndpoints) mergeEndpointCandidate(endpoints, endpoint);

  const safeLastEndpoint = sanitizeEndpoint(lastEndpoint, 'last-known');
  // O último DynIP também é testado, mas somente como candidato adicional. Se
  // ele responder ONLINE, isso é uma confirmação real de que continua válido.
  if (safeLastEndpoint) mergeEndpointCandidate(endpoints, safeLastEndpoint);

  if (!endpoints.length) {
    if (DEBUG_STATUS) {
      console.warn(`❌ Aternos SRV indisponível. Tentativas DNS: ${resolutionDetails.length ? resolutionDetails.join(' | ') : 'nenhuma resposta'}`);
    }
    return {
      endpoint: safeLastEndpoint,
      online: false,
      state: SERVER_STATE.UNKNOWN,
      stateReason: 'srv-unavailable',
      ping: null,
      diagnostics: [],
      resolutionDetails,
      error: resolutionError || new Error('DynIP temporário indisponível.')
    };
  }

  const statuses = [];
  const diagnostics = [];
  const queryDeadline = Date.now() + STATUS_CHECK_BUDGET_MS;
  const selectedEndpoints = endpoints.slice(0, MAX_ENDPOINTS);

  if (DEBUG_STATUS) {
    console.log(`🧭 Aternos SRV atual: ${selectedEndpoints.map((item) => `${item.host}:${item.port}/${item.source}`).join(', ') || 'nenhum'}`);
    if (resolutionDetails.length) console.log(`   ↳ DNS: ${resolutionDetails.join(' | ')}`);
  }

  const results = await Promise.allSettled(
    selectedEndpoints.map((endpoint) => queryEndpoint(endpoint, clean, timeoutMs, queryDeadline))
  );

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const endpoint = selectedEndpoints[index];
    if (result.status === 'fulfilled') {
      const status = result.value;
      statuses.push(status);
      if (Array.isArray(status.diagnostics)) diagnostics.push(...status.diagnostics);
      if (DEBUG_STATUS) {
        const diag = status.diagnostics?.find((item) => item.state === status.state);
        console.log(`📡 ${endpoint.host}:${endpoint.port} → ${status.state.toUpperCase()} (${status.stateReason || 'sem motivo'})${diag?.connectHost ? ` via ${diag.connectHost}` : ''}`);
      }
    } else {
      const error = result.reason;
      if (DEBUG_STATUS) console.log(`   ↳ ${endpoint.host}:${endpoint.port} sem resposta: ${error?.message || error}`);
      if (Array.isArray(error?.diagnostics)) diagnostics.push(...error.diagnostics);
    }
  }

  const best = combineStatuses(statuses);
  if (best) {
    if (DEBUG_STATUS) {
      console.log(`ℹ️ Aternos status final: ${best.state.toUpperCase()} (${best.stateReason || 'sem motivo'}) em ${best.endpoint?.host}:${best.endpoint?.port}`);
    }
    return {
      ...best,
      diagnostics,
      resolutionDetails
    };
  }

  return {
    endpoint: safeLastEndpoint,
    online: false,
    state: SERVER_STATE.UNKNOWN,
    stateReason: 'query-failed',
    ping: null,
    diagnostics,
    resolutionDetails,
    error: resolutionError || new Error('Não foi possível consultar nenhum endpoint do servidor.')
  };
}

function stateOf(status) {
  if (status?.state === SERVER_STATE.STARTING) return SERVER_STATE.STARTING;
  if (status?.state === SERVER_STATE.ONLINE && status?.online) return SERVER_STATE.ONLINE;
  if (status?.state === SERVER_STATE.UNKNOWN) return SERVER_STATE.UNKNOWN;
  return SERVER_STATE.OFFLINE;
}

module.exports = {
  SERVER_STATE,
  resolveMinecraftEndpoint,
  resolveMinecraftEndpoints,
  resolveMinecraftEndpointRecords,
  resolveHostAddresses,
  queryMinecraftServer,
  queryBedrockServer,
  classifyAternosStatus,
  stateOf,
  getServerStatus,
  isValidTemporaryEndpoint,
  sanitizeEndpoint,
  DEFAULT_JAVA_PORT
};
