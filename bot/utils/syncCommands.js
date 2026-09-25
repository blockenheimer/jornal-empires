const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

function loadCommandData() {
  const commands = [];
  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command?.data) continue;
    commands.push(command.data.toJSON());
  }

  // Discord exige nomes únicos dentro do mesmo conjunto de comandos.
  // Isso também evita registrar a mesma definição duas vezes por acidente.
  const seen = new Set();
  return commands.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

function commandNames(commands) {
  return commands.length ? commands.map((c) => `/${c.name}`).join(', ') : '(nenhum)';
}

async function syncCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID?.trim();

  if (!token || !clientId) {
    throw new Error('DISCORD_TOKEN e CLIENT_ID precisam estar definidos no .env.');
  }

  if (!guildId) {
    throw new Error('GUILD_ID precisa estar definido para registrar os comandos apenas no servidor.');
  }

  const commands = loadCommandData();
  const rest = new REST({ version: '10' }).setToken(token);

  console.log(`🔄 Sincronizando ${commands.length} comando(s)...`);
  console.log(`📋 Comandos que serão registrados: ${commandNames(commands)}`);
  console.log(`🏠 Guild ID: ${guildId}`);

  // 1) Remove TODOS os comandos globais antigos deste aplicativo.
  const globalBefore = await rest.get(Routes.applicationCommands(clientId));
  console.log(`🌐 Globais encontrados antes: ${globalBefore.length}`);
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log('🧹 Todos os comandos globais foram removidos.');

  // 2) Remove TODOS os comandos deste aplicativo no servidor.
  const guildBefore = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
  console.log(`🏠 Comandos do servidor encontrados antes: ${guildBefore.length}`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
  console.log('🧹 Todos os comandos antigos do servidor foram removidos.');

  // 3) Registra somente a lista atual no servidor.
  const registered = await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );

  console.log(`✅ Registrados no servidor: ${commandNames(registered)}`);

  // 4) Confirma lendo novamente a lista da API.
  const guildAfter = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
  const globalAfter = await rest.get(Routes.applicationCommands(clientId));

  console.log(`🔎 Verificação final — servidor: ${guildAfter.length} | global: ${globalAfter.length}`);
  console.log(`📌 Servidor agora: ${commandNames(guildAfter)}`);

  if (globalAfter.length !== 0) {
    throw new Error('Ainda existem comandos globais depois da limpeza. Verifique CLIENT_ID e DISCORD_TOKEN.');
  }

  if (guildAfter.length !== commands.length) {
    throw new Error(`Quantidade inesperada de comandos no servidor: esperados ${commands.length}, encontrados ${guildAfter.length}.`);
  }
}

module.exports = { syncCommands };
