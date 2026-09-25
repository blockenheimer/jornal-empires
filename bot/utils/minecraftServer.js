const dns = require('dns').promises;
const net = require('net');
const dgram = require('dgram');

const ATERNOS_PORT = 13174;
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

  // Em algumas configurações do Aternos o registro SRV aponta para o próprio
  // domínio .aternos.me em vez de expor diretamente o DynIP .aternos.host.
  // Isso é válido para a conexão: usamos o domínio principal SOMENTE
  // internamente para chegar ao servidor e nunca o mostramos ao usuário.
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${cleanDomain}`);
    if (records.length > 0) {
      records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
      const target = records[0].name.replace(/\.$/, '');
      const isDynHost = target.toLowerCase().endsWith('.aternos.host');

      return {
        host: target,
        port: ATERNOS_PORT,
        source: isDynHost ? 'srv-dynip' : 'srv-alias',
        publicHost: isDynHost ? target : null,
        publicHostDetected: isDynHost
      };
    }
  } catch (_) {
    // Tente CNAME abaixo.
  }

  // Fallback para configurações que publicam o DynIP por CNAME.
  try {
    const aliases = await dns.resolveCname(cleanDomain);
    for (const alias of aliases) {
      const publicHost = String(alias).replace(/\.$/, '');
      if (publicHost.toLowerCase().endsWith('.aternos.host')) {
        return {
          host: publicHost,
          port: ATERNOS_PORT,
          source: 'cname-dynip',
          publicHost,
          publicHostDetected: true
        };
      }
    }
  } catch (_) {
    // Sem CNAME, seguimos usando o próprio domínio principal internamente.
  }

  // Último fallback: o domínio principal. Isso permite detectar ONLINE mesmo
  // quando o DNS não expõe SRV/CNAME de forma convencional.
  return {
    host: cleanDomain,
    port: ATERNOS_PORT,
    source: 'main-domain',
    publicHost: null,
    publicHostDetected: false
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
      socket.close();
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

        finish(null, {
          online: true,
          ping: Date.now() - startedAt,
          version: fields[3] || null,
          description: fields[1] || '',
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
    // Aternos routes the TCP connection through the temporary DynIP, but the
    // Minecraft status handshake should still carry the public server domain.
    // This matters when the front-end/proxy uses the hostname to select the
    // correct server.
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
    if (response.id !== 0x00) {
      throw new Error(`Pacote inesperado do servidor: ${response.id}`);
    }

    const jsonLength = readVarInt(response.payload, 0);
    if (!jsonLength) throw new Error('Resposta de status inválida.');

    const jsonText = response.payload
      .subarray(jsonLength.size, jsonLength.size + jsonLength.value)
      .toString('utf8');

    const status = JSON.parse(jsonText);

    // Receber o status já prova que o servidor está respondendo. O pong é
    // usado apenas para medir o ping; alguns proxies fecham a conexão logo
    // após o status e não respondem ao ping, então isso não pode transformar
    // um servidor ONLINE em OFFLINE.
    let ping = Date.now() - startedAt;
    try {
      const payload = Buffer.alloc(8);
      payload.writeBigInt64BE(BigInt(Date.now()), 0);
      socket.write(makePacket(0x01, payload));

      const pong = await waitForPacket(socket, Math.min(timeoutMs, 1500));
      if (pong.id === 0x01) {
        ping = Date.now() - startedAt;
      }
    } catch (_) {
      // O status foi recebido; portanto o servidor continua sendo considerado
      // ONLINE. Nesse caso mantemos o tempo até a resposta de status como uma
      // aproximação do ping.
    }

    let detectedPublicHost = null;
    try {
      const remoteAddress = socket.remoteAddress;
      if (remoteAddress) {
        const ptrs = await dns.reverse(remoteAddress);
        detectedPublicHost = ptrs.find((name) =>
          String(name).toLowerCase().endsWith('.aternos.host')
        ) || null;
      }
    } catch (_) {
      // PTR não é obrigatório; mantemos o último DynIP conhecido.
    }

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
      detectedPublicHost,
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

function cleanDomain(domain) {
  return String(domain || '').trim().replace(/\.$/, '');
}

async function getServerStatus({ domain, timeoutMs = DEFAULT_TIMEOUT_MS, lastEndpoint = null }) {
  const endpoint = await resolveMinecraftEndpoint(domain);

  // Nunca fazemos fallback para MineEmpiresOf.aternos.me. Se o SRV estiver
  // indisponível, o chamador usa o último host temporário conhecido.
  if (!endpoint) {
    return {
      endpoint: lastEndpoint || null,
      online: false,
      ping: null,
      error: new Error('Registro SRV temporário indisponível.')
    };
  }

  let javaError = null;

  try {
    const status = await queryMinecraftServer(
      endpoint.host,
      endpoint.port,
      timeoutMs,
      cleanDomain(domain)
    );

    if (status.detectedPublicHost && status.detectedPublicHost.toLowerCase().endsWith('.aternos.host')) {
      endpoint.publicHost = status.detectedPublicHost;
      endpoint.publicHostDetected = true;
      endpoint.source = `${endpoint.source}+ptr`;
    }

    return { endpoint, ...status, edition: 'java' };
  } catch (error) {
    javaError = error;
  }

  // Se o servidor for Bedrock (ou estiver atrás de um endpoint que não fala
  // o protocolo Java), tente o ping UDP/RakNet antes de declarar OFFLINE.
  try {
    const status = await queryBedrockServer(endpoint.host, endpoint.port, timeoutMs);
    return { endpoint, ...status, edition: 'bedrock' };
  } catch (bedrockError) {
    bedrockError.javaError = javaError;
    return {
      endpoint,
      online: false,
      ping: null,
      error: bedrockError
    };
  }
}

module.exports = {
  resolveMinecraftEndpoint,
  queryMinecraftServer,
  queryBedrockServer,
  getServerStatus,
  ATERNOS_PORT
};
