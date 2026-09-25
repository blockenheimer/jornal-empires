require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { startServerMonitor } = require('./utils/serverMonitor');
const { syncCommands } = require('./utils/syncCommands');

const PORT = process.env.PORT || 3000;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command?.data) client.commands.set(command.data.name, command);
}

client.once('ready', () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  startServerMonitor(client);
});

client.on('interactionCreate', async (interaction) => {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (interaction.isChatInputCommand()) {
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      const payload = {
        content: '❌ Ocorreu um erro ao executar esse comando.',
        ephemeral: true
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    }
  } else if (interaction.isAutocomplete()) {
    if (command.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(error);
      }
    }
  }
});

async function main() {
  // Sincroniza os slash commands sempre que o processo inicia, mesmo quando
  // o host estiver usando "node index.js" em vez de "npm run deploy".
  await syncCommands();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('EmpiresBot online!');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server online na porta ${PORT}`);
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  console.error('❌ Falha ao iniciar o bot:', error);
  process.exit(1);
});
