const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
  SERVER_STATE,
  getServerStatus,
  stateOf,
  isValidTemporaryEndpoint,
  sanitizeEndpoint
} = require('./minecraftServer');

const CHECK_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.SERVER_CHECK_INTERVAL_MS || 30_000)
);
const SERVER_CHANNEL_ID = process.env.SERVER_STATUS_CHANNEL_ID || '980951220502003753';
const SERVER_DOMAIN = process.env.ATERNOS_DOMAIN?.trim();

const STATE_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(STATE_DIR, 'aternos-last-endpoint.json');

const CONFIRM_READINGS = Math.max(
  1,
  Number(process.env.SERVER_STATE_CONFIRM_READINGS || 2)
);
const STARTING_CONFIRM_READINGS = Math.max(
  1,
  Number(process.env.SERVER_STARTING_CONFIRM_READINGS || 1)
);

let timer = null;
let lastState = null;
let lastEndpoint = loadLastEndpoint();
let checking = false;
let pendingState = null;
let pendingCount = 0;

function loadLastEndpoint() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return sanitizeEndpoint(saved, 'last-known');
  } catch (_) {
    return null;
  }
}

function persistLastEndpoint(endpoint) {
  const safe = sanitizeEndpoint(endpoint, 'srv');
  if (!safe) return;

  lastEndpoint = safe;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2));
  } catch (error) {
    console.warn('⚠️ Não foi possível salvar o último IP temporário em disco:', error.message);
  }
}

function resolveDisplayEndpoint(status) {
  // Só substituímos o IP salvo quando a resposta realmente veio de um
  // endpoint temporário atual. A resposta do proxy ou o fallback last-known
  // nunca sobrescrevem o último DynIP confirmado.
  if (isValidTemporaryEndpoint(status?.endpoint) && status.endpoint.source !== 'last-known') {
    persistLastEndpoint(status.endpoint);
  }
  return lastEndpoint;
}

function formatEndpoint(endpoint = lastEndpoint) {
  const safe = sanitizeEndpoint(endpoint, endpoint?.source || 'last-known') || lastEndpoint;
  if (!safe) return 'ainda não detectado';
  return `${safe.publicHost}:${safe.port}`;
}

function onlineText(status) {
  const online = status.players?.online ?? 0;
  const max = status.players?.max ?? 0;
  const ping = status.ping ?? 0;

  return `🌐 IP: ${formatEndpoint(status.endpoint)}\n🟢 Status: ONLINE   👥 Jogadores: ${online}/${max}   ⏱️ Ping: ${ping} ms`;
}

function startingText(status) {
  return `🌐 Último IP conhecido: ${formatEndpoint(status?.endpoint)}\n🟡 Status: SERVIDOR INICIANDO\n⏳ Aguarde enquanto a Aternos inicia o servidor...`;
}

function offlineText(endpoint = lastEndpoint) {
  return `🌐 Último IP conhecido: ${formatEndpoint(endpoint)}\n🔴 Status: OFFLINE`;
}

function buildOnlineEmbed(status) {
  return new EmbedBuilder()
    .setTitle('Status')
    .setDescription(onlineText(status))
    .setColor(0x57F287);
}

function buildStartingEmbed(status) {
  return new EmbedBuilder()
    .setTitle('Status')
    .setDescription(startingText(status))
    .setColor(0xFEE75C);
}

function buildOfflineEmbed(endpoint = lastEndpoint) {
  return new EmbedBuilder()
    .setTitle('Status')
    .setDescription(offlineText(endpoint))
    .setColor(0xED4245);
}

async function fetchStatus() {
  if (!SERVER_DOMAIN) throw new Error('ATERNOS_DOMAIN não foi definido no .env.');

  const status = await getServerStatus({
    domain: SERVER_DOMAIN,
    lastEndpoint
  });

  // Nunca exibimos o domínio principal .aternos.me. O que aparece ao usuário
  // é sempre o último DynIP temporário confirmado ou "ainda não detectado".
  status.endpoint = resolveDisplayEndpoint(status);
  return status;
}

async function sendStatusMessage(client, embed) {
  try {
    const channel = await client.channels.fetch(SERVER_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`O canal ${SERVER_CHANNEL_ID} não é um canal de texto acessível pelo bot.`);
    }
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`❌ Não foi possível enviar o status no canal ${SERVER_CHANNEL_ID}:`, error.message);
  }
}

async function announceState(client, state, status) {
  let embed;

  if (state === SERVER_STATE.ONLINE) {
    embed = buildOnlineEmbed(status);
  } else if (state === SERVER_STATE.STARTING) {
    embed = buildStartingEmbed(status);
  } else {
    embed = buildOfflineEmbed(status?.endpoint);
  }

  const label = state === SERVER_STATE.STARTING ? 'SERVIDOR INICIANDO' : state.toUpperCase();
  console.log(`📣 Anunciando mudança de estado do servidor: ${label} (IP: ${formatEndpoint(status?.endpoint)})`);
  await sendStatusMessage(client, embed);
}

function confirmationLimitFor(state) {
  return state === SERVER_STATE.STARTING
    ? STARTING_CONFIRM_READINGS
    : CONFIRM_READINGS;
}

async function checkServer(client, { announce = true } = {}) {
  if (checking) return null;
  checking = true;

  try {
    const status = await fetchStatus();
    const currentState = stateOf(status);

    if (lastState === null) {
      lastState = currentState;
      pendingState = null;
      pendingCount = 0;

      console.log(`🔎 Estado inicial detectado: ${currentState.toUpperCase()}${status.stateReason ? ` (${status.stateReason})` : ''}`);

      // Se o bot iniciar enquanto o servidor está começando, avisa também.
      if (announce && (currentState === SERVER_STATE.ONLINE || currentState === SERVER_STATE.STARTING)) {
        await announceState(client, currentState, status);
      }

      return status;
    }

    if (currentState === lastState) {
      pendingState = null;
      pendingCount = 0;
      return status;
    }

    if (pendingState === currentState) {
      pendingCount += 1;
    } else {
      pendingState = currentState;
      pendingCount = 1;
    }

    const limit = confirmationLimitFor(currentState);
    console.log(`⏳ Leitura diferente do estado confirmado (${lastState} → ${currentState}), confirmação ${pendingCount}/${limit}${status.stateReason ? ` [${status.stateReason}]` : ''}`);

    if (pendingCount >= limit) {
      lastState = currentState;
      pendingState = null;
      pendingCount = 0;

      if (announce) await announceState(client, currentState, status);
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
  return fetchStatus();
}

module.exports = {
  startServerMonitor,
  getCurrentServerStatus,
  formatEndpoint,
  onlineText,
  startingText,
  offlineText,
  buildOnlineEmbed,
  buildStartingEmbed,
  buildOfflineEmbed
};
