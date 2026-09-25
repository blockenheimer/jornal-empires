const { SlashCommandBuilder } = require('discord.js');
const {
  getCurrentServerStatus,
  buildOnlineEmbed,
  buildStartingEmbed,
  buildOfflineEmbed
} = require('../utils/serverMonitor');
const { SERVER_STATE, stateOf } = require('../utils/minecraftServer');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ip')
    .setDescription('Mostra o endereço público e o status do servidor Minecraft'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const status = await getCurrentServerStatus();
      const state = stateOf(status);

      if (state === SERVER_STATE.ONLINE) {
        await interaction.editReply({ embeds: [buildOnlineEmbed(status)] });
        return;
      }

      if (state === SERVER_STATE.STARTING) {
        await interaction.editReply({ embeds: [buildStartingEmbed(status)] });
        return;
      }

      await interaction.editReply({ embeds: [buildOfflineEmbed(status.endpoint)] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('❌ Não foi possível consultar o status do servidor agora.');
    }
  }
};
