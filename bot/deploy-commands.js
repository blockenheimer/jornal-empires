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
      // Se antes os comandos foram registrados globalmente e agora estamos
      // usando GUILD_ID, o Discord pode mostrar duas versões do mesmo slash
      // command (uma global + uma do servidor). Removemos apenas os comandos
      // com os mesmos nomes do nosso bot no escopo global antes de registrar
      // a versão do servidor.
      const globalCommands = await rest.get(
        Routes.applicationCommands(process.env.CLIENT_ID)
      );

      const commandNames = new Set(commands.map((command) => command.name));
      for (const globalCommand of globalCommands) {
        if (commandNames.has(globalCommand.name)) {
          await rest.delete(
            Routes.applicationCommand(process.env.CLIENT_ID, globalCommand.id)
          );
          console.log(`🧹 Removido comando global duplicado: /${globalCommand.name}`);
        }
      }

      // Registro em UM servidor só: aparece na hora (ótimo para testes).
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('✅ Comandos registrados no servidor (GUILD_ID) sem duplicatas!');
    } else {
      // Registro global: demora até ~1h para propagar.
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('✅ Comandos registrados globalmente com sucesso! (pode levar até 1h para aparecer)');
    }
  } catch (error) {
    console.error(error);
  }
})();
