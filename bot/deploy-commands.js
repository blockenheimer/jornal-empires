require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registrando ${commands.length} comando(s)...`);

    if (process.env.GUILD_ID) {
      // Registro em UM servidor só: aparece na hora (ótimo p/ testes)
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('Comandos registrados no servidor (GUILD_ID) com sucesso!');
    } else {
      // Registro global: demora até ~1h para propagar
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Comandos registrados globalmente com sucesso! (pode levar até 1h para aparecer)');
    }
  } catch (error) {
    console.error(error);
  }
})();
