const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getServerStatus } = require('./minecraftServer');

const CHECK_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.SERVER_CHECK_INTERVAL_MS || 30_000)
);
const SERVER_CHANNEL_ID = process.env.SERVER_STATUS_CHANNEL_ID || '980951220502003753';
const SERVER_DOMAIN = process.env.ATERNOS_DOMAIN?.trim();

const STATE_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(STATE_DIR, 'aternos-last-endpoint.json');

let timer = null;
let lastState = null;
let lastEndpoint = loadLastEndpoint();
let checking = false;

function isTemporaryEndpoint(endpoint) {
  const host = String(endpoint?.publicHost || endpoint?.host || '').trim().toLowerCase();
  return host.endsWith('.aternos.host') && Number(endpoint?.port) === 13174;
}

function sanitizeEndpoint(endpoint) {
  if (!isTemporaryEndpoint(endpoint)) return null;
  const host = String(endpoint.publicHost || endpoint.host).trim().replace(/\.$/, '');
  return {
    host,
    publicHost: host,
    port: 13174,
    source: 'srv'
  };
}

function loadLastEndpoint() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return sanitizeEndpoint(saved);
  } catch (_) {
    return null;
  }
}

function persistLastEndpoint(endpoint) {
  const safe = sanitizeEndpoint(endpoint);
  if (!safe) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2));
  } catch (error) {
    console.warn('⚠️ Não foi possível salvar o último IP temporário:', error.message);
  }
  lastEndpoint = safe;
}

function formatEndpoint(endpoint) {
  const safe = sanitizeEndpoint(endpoint) || sanitizeEndpoint(lastEndpoint);
  if (!safe) return 'indisponível';
  return `${safe.publicHost}:13174`;
}

function onlineText(status) {
  const endpoint = status.endpoint || lastEndpoint;
  const online = status.players?.online ?? 0;
  const max = status.players?.max ?? 0;
  const ping = status.ping ?? 0;

  return `🌐 IP: ${formatEndpoint(endpoint)}\n🟢 Status: ONLINE   👥 Jogadores: ${online}/${max}   ⏱️ Ping: ${ping} ms`;
}

function offlineText(endpoint = lastEndpoint) {
  return `🌐 IP: ${formatEndpoint(endpoint)}\n🔴 Status: OFFLINE`;
}

function buildOnlineEmbed(status) {
  return new EmbedBuilder()
    .setTitle('Status')
    .setDescription(onlineText(status))
    .setColor(0x57F287);
}

function buildOfflineEmbed(endpoint = lastEndpoint) {
  return new EmbedBuilder()
    .setTitle('Status')
    .setDescription(offlineText(endpoint))
    .setColor(0xED4245);
}


async function fetchStatus() {
  if (!SERVER_DOMAIN) {
    throw new Error('ATERNOS_DOMAIN não foi definido no .env.');
  }

  const status = await getServerStatus({
    domain: SERVER_DOMAIN,
    lastEndpoint
  });

  if (isTemporaryEndpoint(status.endpoint)) {
    persistLastEndpoint(status.endpoint);
    status.endpoint = lastEndpoint;
  } else {
    // Nunca exibimos o domínio principal .aternos.me. Se não foi possível
    // descobrir o DynIP agora, usamos o último DynIP temporário conhecido.
    status.endpoint = lastEndpoint;
  }

  return status;
}

async function sendStatusMessage(client, message) {
  try {
    const channel = await client.channels.fetch(SERVER_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`O canal ${SERVER_CHANNEL_ID} não é um canal de texto acessível pelo bot.`);
    }
    await channel.send({ embeds: [message] });
  } catch (error) {
    console.error(`❌ Não foi possível enviar o status no canal ${SERVER_CHANNEL_ID}:`, error.message);
  }
}

async function checkServer(client, { announce = true } = {}) {
  if (checking) return null;
  checking = true;

  try {
    const status = await fetchStatus();
    const currentState = status.online;

    if (lastState === null) {
      lastState = currentState;
      // Se o bot iniciou já com o servidor online, isso também conta como
      // detecção inicial e envia o aviso de servidor online.
      if (announce && currentState) {
        await sendStatusMessage(client, buildOnlineEmbed(status));
      }
    } else if (currentState !== lastState) {
      lastState = currentState;
      if (announce) {
        await sendStatusMessage(
          client,
          currentState ? buildOnlineEmbed(status) : buildOfflineEmbed(lastEndpoint)
        );
      }
    }

    return status;
  } catch (error) {
    console.error('❌ Falha no monitor do servidor:', error.message);
    return null;
  } finally {
    checking = false;
  }
}

function startServerMonitor(client) {
  if (timer) return;

  if (!SERVER_DOMAIN) {
    console.warn('⚠️ Monitor Aternos desativado: configure ATERNOS_DOMAIN no .env.');
    return;
  }

  checkServer(client).catch((error) => console.error(error));
  timer = setInterval(() => {
    checkServer(client).catch((error) => console.error(error));
  }, CHECK_INTERVAL_MS);

  console.log(`🔎 Monitor Aternos iniciado: ${SERVER_DOMAIN} a cada ${CHECK_INTERVAL_MS / 1000}s`);
}

async function getCurrentServerStatus() {
  const status = await fetchStatus();
  if (isTemporaryEndpoint(status.endpoint)) {
    persistLastEndpoint(status.endpoint);
  } else {
    status.endpoint = lastEndpoint;
  }
  return status;
}

module.exports = {
  startServerMonitor,
  getCurrentServerStatus,
  formatEndpoint,
  onlineText,
  offlineText,
  buildOnlineEmbed,
  buildOfflineEmbed
};
