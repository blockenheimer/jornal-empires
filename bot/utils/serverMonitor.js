const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
  SERVER_STATE,
  getServerStatus,
  stateOf,
  isOpen,
  isValidTemporaryEndpoint,
  sanitizeEndpoint
} = require('./minecraftServer');

const CHECK_INTERVAL_MS = Math.max(5_000, numberEnv('ATERNOS_WATCHER_UPDATE_TIME', numberEnv('SERVER_CHECK_INTERVAL_MS', 30_000) * 0.001) * 1000);
const SERVER_CHANNEL_ID = process.env.SERVER_STATUS_CHANNEL_ID || '980951220502003753';
const SERVER_DOMAIN = (process.env.ATERNOS_WATCHER_HOST || process.env.ATERNOS_DOMAIN || '').trim();
const SERVER_PORT = Number(process.env.ATERNOS_WATCHER_PORT || 25565);

const CONFIRM_READINGS = Math.max(1, numberEnv('ATERNOS_WATCHER_CONFIRM_READINGS', numberEnv('SERVER_STATE_CONFIRM_READINGS', 2)));
const STARTING_CONFIRM_READINGS = Math.max(1, numberEnv('ATERNOS_WATCHER_STARTING_CONFIRM_READINGS', numberEnv('SERVER_STARTING_CONFIRM_READINGS', 1)));
const OPEN_CONFIRM_DELAY_MS = Math.max(0, numberEnv('ATERNOS_WATCHER_OPEN_CONFIRM_DELAY_MS', 5_000));
const SHOW_PLAYERS = boolEnv('ATERNOS_WATCHER_SHOW_PLAYERS', true);
const SHOW_MOTD = boolEnv('ATERNOS_WATCHER_SHOW_MOTD', true);
const MENTION = process.env.ATERNOS_WATCHER_MENTION || '';
const AUTHOR_NAME = process.env.ATERNOS_WATCHER_AUTHOR_NAME || '';
const AUTHOR_ICON = process.env.ATERNOS_WATCHER_AUTHOR_ICON || '';
const AUTHOR_URL = process.env.ATERNOS_WATCHER_AUTHOR_URL || '';
const FOOTER_TEXT = process.env.ATERNOS_WATCHER_FOOTER_TEXT || 'Aternos Watcher';
const FOOTER_ICON = process.env.ATERNOS_WATCHER_FOOTER_ICON || '';
const THUMBNAIL_URL = process.env.ATERNOS_WATCHER_THUMBNAIL_URL || '';
const ONLINE_TITLE = process.env.ATERNOS_WATCHER_ONLINE_TITLE || '🟢 Server ONLINE!';
const OFFLINE_TITLE = process.env.ATERNOS_WATCHER_OFFLINE_TITLE || '🔴 Server OFFLINE';
const WAITING_TITLE = process.env.ATERNOS_WATCHER_WAITING_TITLE || '⏳ Server WAITING...';
const STARTING_TITLE = process.env.ATERNOS_WATCHER_STARTING_TITLE || '🟡 Server STARTING...';
const STOPPING_TITLE = process.env.ATERNOS_WATCHER_STOPPING_TITLE || '🛑 Server STOPPING...';
const WAITING_MESSAGE = process.env.ATERNOS_WATCHER_WAITING_MESSAGE || 'A Aternos respondeu pelo proxy de espera. Conecte-se ao servidor para mantê-lo aberto.';
const ONLINE_COLOR = hexColor(process.env.ATERNOS_WATCHER_ONLINE_COLOR || '30c030');
const OFFLINE_COLOR = hexColor(process.env.ATERNOS_WATCHER_OFFLINE_COLOR || 'ff4040');
const WAITING_COLOR = hexColor(process.env.ATERNOS_WATCHER_WAITING_COLOR || 'ffff00');
const STARTING_COLOR = hexColor(process.env.ATERNOS_WATCHER_STARTING_COLOR || 'ffff00');
const STOPPING_COLOR = hexColor(process.env.ATERNOS_WATCHER_STOPPING_COLOR || 'ff8c00');
const UNKNOWN_COLOR = hexColor(process.env.ATERNOS_WATCHER_UNKNOWN_COLOR || '808080');

const STATE_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(STATE_DIR, 'aternos-last-endpoint.json');

let timer = null;
let lastState = null;
let lastEndpoint = loadLastEndpoint();
let checking = false;
let pendingState = null;
let pendingCount = 0;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null) return fallback;
  return String(value).trim().toLowerCase() !== 'false';
}

function hexColor(value) {
  const clean = String(value).replace(/^#/, '').trim();
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0x808080;
}

function loadLastEndpoint() {
  try {
    return sanitizeEndpoint(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), 'last-known');
  } catch (_) {
    return null;
  }
}

function persistLastEndpoint(endpoint) {
  const safe = sanitizeEndpoint(endpoint, endpoint?.source || 'srv');
  if (!safe) return;
  lastEndpoint = safe;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2));
  } catch (error) {
    console.warn(`⚠️ Não foi possível salvar o último DynIP: ${error.message}`);
  }
}

function maybeRememberEndpoint(status) {
  if (isValidTemporaryEndpoint(status?.endpoint)) {
    const state = stateOf(status);
    if ([SERVER_STATE.ONLINE, SERVER_STATE.STARTING, SERVER_STATE.WAITING].includes(state)) {
      persistLastEndpoint(status.endpoint);
    }
  }

  if (lastEndpoint && status && !status.endpoint) status.endpoint = lastEndpoint;
  return status;
}

function formatEndpoint(endpoint = lastEndpoint) {
  const safe = sanitizeEndpoint(endpoint, endpoint?.source || 'last-known') || lastEndpoint;
  return safe ? `${safe.publicHost}:${safe.port}` : 'ainda não detectado';
}

function mcToAnsi(text) {
  const codes = {
    '0': '\u001b[30m', '1': '\u001b[34m', '2': '\u001b[32m', '3': '\u001b[36m',
    '4': '\u001b[31m', '5': '\u001b[35m', '6': '\u001b[33m', '7': '\u001b[37m',
    '8': '\u001b[30;1m', '9': '\u001b[34;1m', 'a': '\u001b[32;1m', 'b': '\u001b[36;1m',
    'c': '\u001b[31;1m', 'd': '\u001b[35;1m', 'e': '\u001b[33;1m', 'f': '\u001b[37;1m',
    'l': '\u001b[1m', 'n': '\u001b[4m', 'r': '\u001b[0m',
    'k': '', 'm': '', 'o': ''
  };

  let result = '';
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '§' && i + 1 < value.length) {
      const code = value[i + 1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(codes, code)) {
        result += codes[code];
        i += 1;
        continue;
      }
    }
    result += value[i];
  }
  return `${result}\u001b[0m`;
}

function endpointLine(status) {
  return `🌐 ${status?.state === SERVER_STATE.ONLINE ? 'Host atual' : 'Último IP conhecido'}: \`${formatEndpoint(status?.endpoint)}\``;
}

function buildDescription(status, state) {
  const players = status?.players || { online: 0, max: 0, sample: [] };
  const lines = [endpointLine(status)];

  if (state === SERVER_STATE.ONLINE) {
    lines.push(`👥 Jogadores: \`${players.online}/${players.max}\``);
    if (status?.ping != null) lines.push(`⏱️ Ping: \`${status.ping} ms\``);
  } else if (state === SERVER_STATE.WAITING) {
    lines.push(`⚠️ **${WAITING_MESSAGE}**`);
  } else if (state === SERVER_STATE.STARTING) {
    lines.push('⏳ Aguarde enquanto a Aternos inicia o servidor...');
  } else if (state === SERVER_STATE.STOPPING) {
    lines.push('⏳ O servidor está encerrando.');
  } else if (state === SERVER_STATE.UNKNOWN) {
    lines.push('🔄 O bot continuará verificando. O estado não foi confirmado.');
  }

  if (SHOW_MOTD && status?.description) {
    lines.push(`**MOTD:**\n\`\`\`ansi\n${mcToAnsi(status.description)}\n\`\`\``);
  }

  return lines.join('\n');
}

function buildEmbed(status, forcedState = null) {
  const state = forcedState || stateOf(status);
  let title = OFFLINE_TITLE;
  let color = OFFLINE_COLOR;

  if (state === SERVER_STATE.ONLINE) {
    title = ONLINE_TITLE;
    color = ONLINE_COLOR;
  } else if (state === SERVER_STATE.WAITING) {
    title = WAITING_TITLE;
    color = WAITING_COLOR;
  } else if (state === SERVER_STATE.STARTING) {
    title = STARTING_TITLE;
    color = STARTING_COLOR;
  } else if (state === SERVER_STATE.STOPPING) {
    title = STOPPING_TITLE;
    color = STOPPING_COLOR;
  } else if (state === SERVER_STATE.UNKNOWN) {
    color = UNKNOWN_COLOR;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(buildDescription(status, state))
    .setColor(color)
    .setTimestamp();

  if (AUTHOR_NAME) embed.setAuthor({ name: AUTHOR_NAME, url: AUTHOR_URL || undefined, iconURL: AUTHOR_ICON || undefined });
  if (THUMBNAIL_URL) embed.setThumbnail(THUMBNAIL_URL);
  if (FOOTER_TEXT) embed.setFooter({ text: FOOTER_TEXT, iconURL: FOOTER_ICON || undefined });

  return embed;
}

function buildOnlineEmbed(status) { return buildEmbed(status, SERVER_STATE.ONLINE); }
function buildOfflineEmbed(status) { return buildEmbed(status, SERVER_STATE.OFFLINE); }
function buildStartingEmbed(status) { return buildEmbed(status, SERVER_STATE.STARTING); }
function buildUnknownEmbed(status) { return buildEmbed(status, SERVER_STATE.UNKNOWN); }
function buildWaitingEmbed(status) { return buildEmbed(status, SERVER_STATE.WAITING); }
function buildStoppingEmbed(status) { return buildEmbed(status, SERVER_STATE.STOPPING); }

async function fetchStatus() {
  const status = await getServerStatus({ domain: SERVER_DOMAIN, lastEndpoint });
  maybeRememberEndpoint(status);
  return status;
}

async function sendStatusMessage(client, embed) {
  if (!SERVER_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(SERVER_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) throw new Error(`Canal ${SERVER_CHANNEL_ID} não é de texto ou não está acessível.`);
    await channel.send({ content: MENTION || undefined, embeds: [embed] });
  } catch (error) {
    console.error(`❌ Não foi possível enviar o status no canal ${SERVER_CHANNEL_ID}: ${error.message}`);
  }
}

function shouldAnnounce(state) {
  return state !== SERVER_STATE.UNKNOWN;
}

function confirmationLimitFor(state) {
  if (state === SERVER_STATE.STARTING) return STARTING_CONFIRM_READINGS;
  return CONFIRM_READINGS;
}

async function confirmOpenAfterDelay(client, candidateState, candidateStatus) {
  if (!isOpen(candidateState) || OPEN_CONFIRM_DELAY_MS <= 0) {
    return { state: candidateState, status: candidateStatus };
  }

  await new Promise((resolve) => setTimeout(resolve, OPEN_CONFIRM_DELAY_MS));
  const confirmed = await fetchStatus();
  return { state: stateOf(confirmed), status: confirmed };
}

async function announceState(client, state, status) {
  if (!shouldAnnounce(state)) return;
  const embed = buildEmbed(status, state);
  console.log(`📣 Estado Aternos: ${state.toUpperCase()}${status?.stateReason ? ` (${status.stateReason})` : ''}; DynIP: ${formatEndpoint(status?.endpoint)}`);
  await sendStatusMessage(client, embed);
}

async function checkServer(client, { announce = true } = {}) {
  if (checking) return null;
  checking = true;

  try {
    const status = await fetchStatus();
    const currentState = stateOf(status);

    if (currentState === SERVER_STATE.UNKNOWN) {
      console.warn(`⚠️ Aternos UNKNOWN (${status.stateReason || 'sem motivo'}); estado confirmado anterior mantido.`);
      return status;
    }

    // Transitions de STARTING/STOPPING são informadas, mas não substituem a
    // lógica de abertura/fechamento do Aternos Watcher.
    if (lastState === null) {
      lastState = currentState;
      pendingState = null;
      pendingCount = 0;
      console.log(`🔎 Estado inicial: ${currentState.toUpperCase()} (${status.stateReason || 'sem motivo'})`);
      if (announce && [SERVER_STATE.ONLINE, SERVER_STATE.STARTING, SERVER_STATE.WAITING].includes(currentState)) {
        await announceState(client, currentState, status);
      }
      return status;
    }

    if (currentState === lastState) {
      pendingState = null;
      pendingCount = 0;
      return status;
    }

    if (pendingState === currentState) pendingCount += 1;
    else {
      pendingState = currentState;
      pendingCount = 1;
    }

    const limit = confirmationLimitFor(currentState);
    console.log(`⏳ Mudança ${lastState.toUpperCase()} → ${currentState.toUpperCase()}, confirmação ${pendingCount}/${limit}`);

    if (pendingCount < limit) return status;

    if (isOpen(currentState) && !isOpen(lastState)) {
      try {
        const confirmed = await confirmOpenAfterDelay(client, currentState, status);
        if (!isOpen(confirmed.state)) {
          console.log(`ℹ️ Flicker Aternos ignorado: ${currentState.toUpperCase()} → ${confirmed.state.toUpperCase()}`);
          pendingState = null;
          pendingCount = 0;
          return confirmed.status;
        }
        lastState = confirmed.state;
        status = confirmed.status;
      } catch (error) {
        console.warn(`⚠️ Falha na confirmação final de abertura: ${error.message}`);
        return status;
      }
    } else {
      lastState = currentState;
    }

    pendingState = null;
    pendingCount = 0;

    if (announce) await announceState(client, lastState, status);
    return status;
  } catch (error) {
    console.error(`❌ Falha no monitor Aternos: ${error.message}`);
    return null;
  } finally {
    checking = false;
  }
}

function startServerMonitor(client) {
  if (timer) return;
  if (!SERVER_DOMAIN) {
    console.warn('⚠️ Monitor Aternos desativado: defina ATERNOS_DOMAIN (ou ATERNOS_WATCHER_HOST).');
    return;
  }

  console.log(`🔎 Aternos Watcher iniciado para ${SERVER_DOMAIN}:${SERVER_PORT} a cada ${CHECK_INTERVAL_MS / 1000}s.`);
  checkServer(client).catch((error) => console.error(error));
  timer = setInterval(() => {
    checkServer(client).catch((error) => console.error(error));
  }, CHECK_INTERVAL_MS);
}

async function getCurrentServerStatus() {
  return fetchStatus();
}

function getLastKnownEndpoint() {
  return lastEndpoint;
}

module.exports = {
  startServerMonitor,
  getCurrentServerStatus,
  getLastKnownEndpoint,
  formatEndpoint,
  mcToAnsi,
  buildOnlineEmbed,
  buildOfflineEmbed,
  buildStartingEmbed,
  buildUnknownEmbed,
  buildWaitingEmbed,
  buildStoppingEmbed,
  stateOf,
  SERVER_STATE
};
