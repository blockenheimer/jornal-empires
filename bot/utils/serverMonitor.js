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

// Quantas leituras seguidas e diferentes do estado atual são necessárias
// antes de considerar a mudança "real" e anunciar no Discord. Isso evita
// que uma falha momentânea de rede/timeout faça o bot alternar entre
// ONLINE/OFFLINE (flapping) sem o servidor ter mudado de verdade.
const CONFIRM_READINGS = Math.max(
  1,
  Number(process.env.SERVER_STATE_CONFIRM_READINGS || 2)
);

// Usamos strings em vez de booleano para o estado. É de propósito: com
// booleano é fácil trocar sem querer um `if (online)` por `if (!online)`
// (ou um ternário ao contrário) numa edição futura e inverter as mensagens
// sem nenhum erro aparecer. Com string, qualquer erro desses vira um bug
// óbvio e visível ('offline' !== 'online' nunca "quase funciona").
const STATE = {
  ONLINE: 'online',
  OFFLINE: 'offline'
};

function stateOf(status) {
  return status?.online ? STATE.ONLINE : STATE.OFFLINE;
}

let timer = null;
let lastState = null; // null = ainda não sabemos (bot acabou de iniciar)
let lastEndpoint = loadLastEndpoint();
let checking = false;
let pendingState = null;
let pendingCount = 0;

function isTemporaryEndpoint(endpoint) {
  const host = String(endpoint?.publicHost || endpoint?.host || '').trim().toLowerCase();
  const port = Number(endpoint?.port);
  // A porta do DynIP muda a cada vez que o servidor liga (não é fixa!). Só
  // validamos o host (*.aternos.host) e que a porta seja um número válido.
  return host.endsWith('.aternos.host') && Number.isInteger(port) && port > 0 && port <= 65535;
}

function sanitizeEndpoint(endpoint) {
  if (!isTemporaryEndpoint(endpoint)) return null;
  const host = String(endpoint.publicHost || endpoint.host).trim().replace(/\.$/, '');
  return {
    host,
    publicHost: host,
    port: Number(endpoint.port),
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
  lastEndpoint = safe;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(safe, null, 2));
  } catch (error) {
    console.warn('⚠️ Não foi possível salvar o último IP temporário em disco:', error.message);
  }
}

// Sempre que a checagem trouxer um endpoint temporário válido, atualizamos
// lastEndpoint e devolvemos ELE (nunca o objeto cru vindo da checagem), para
// que qualquer lugar do código que exiba o IP mostre sempre a mesma fonte
// de verdade única.
function resolveDisplayEndpoint(status) {
  if (isTemporaryEndpoint(status?.endpoint)) {
    persistLastEndpoint(status.endpoint);
  }
  return lastEndpoint;
}

function formatEndpoint(endpoint = lastEndpoint) {
  const safe = sanitizeEndpoint(endpoint) || lastEndpoint;
  if (!safe) return 'ainda não detectado';
  return `${safe.publicHost}:${safe.port}`;
}

function onlineText(status) {
  const online = status.players?.online ?? 0;
  const max = status.players?.max ?? 0;
  const ping = status.ping ?? 0;

  return `🌐 IP: ${formatEndpoint(status.endpoint)}\n🟢 Status: ONLINE   👥 Jogadores: ${online}/${max}   ⏱️ Ping: ${ping} ms`;
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

  // Nunca exibimos o domínio principal .aternos.me nem uma porta "chutada".
  // O endpoint mostrado é sempre o último DynIP temporário confirmado.
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

// Envia a mensagem correspondente ao estado informado. Isolar isso numa
// única função (em vez de espalhar ternários pelo checkServer) elimina
// qualquer chance de "mandar a mensagem errada para o estado certo".
async function announceState(client, state, status) {
  const embed = state === STATE.ONLINE
    ? buildOnlineEmbed(status)
    : buildOfflineEmbed(status.endpoint);

  console.log(`📣 Anunciando mudança de estado do servidor: ${state.toUpperCase()} (IP: ${formatEndpoint(status.endpoint)})`);
  await sendStatusMessage(client, embed);
}

async function checkServer(client, { announce = true } = {}) {
  if (checking) return null;
  checking = true;

  try {
    const status = await fetchStatus();
    const currentState = stateOf(status);

    if (lastState === null) {
      // Primeira leitura desde que o bot iniciou: só define a base, não
      // conta como "mudança". Se o servidor já estiver online quando o bot
      // subir, ainda assim avisamos no canal (é a detecção inicial do
      // servidor aberto).
      lastState = currentState;
      pendingState = null;
      pendingCount = 0;
      console.log(`🔎 Estado inicial detectado: ${currentState.toUpperCase()}`);
      if (announce && currentState === STATE.ONLINE) {
        await announceState(client, STATE.ONLINE, status);
      }
    } else if (currentState === lastState) {
      // Confirma o estado atual; qualquer leitura diferente pendente é
      // descartada porque não se repetiu.
      pendingState = null;
      pendingCount = 0;
    } else {
      // O estado leu diferente do último confirmado. Só anunciamos a
      // mudança depois de ver a mesma leitura se repetir algumas vezes
      // seguidas, para não disparar mensagens por causa de um timeout
      // isolado ou instabilidade momentânea de rede/DNS.
      if (pendingState === currentState) {
        pendingCount += 1;
      } else {
        pendingState = currentState;
        pendingCount = 1;
      }

      console.log(`⏳ Leitura diferente do estado confirmado (${lastState} → ${currentState}), confirmação ${pendingCount}/${CONFIRM_READINGS}`);

      if (pendingCount >= CONFIRM_READINGS) {
        lastState = currentState;
        pendingState = null;
        pendingCount = 0;
        if (announce) {
          await announceState(client, currentState, status);
        }
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

// Usado pelos comandos /ip e /players: sempre faz uma leitura nova e ao
// vivo (não depende do estado "confirmado" do monitor de fundo), para que
// o usuário sempre veja a realidade agora, não um estado pendente.
async function getCurrentServerStatus() {
  return fetchStatus();
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
