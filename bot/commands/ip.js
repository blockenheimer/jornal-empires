const { SlashCommandBuilder } = require('discord.js');
const {
  getCurrentServerStatus,
  formatEndpoint,
  buildOnlineEmbed,
  buildOfflineEmbed
} = require('../utils/serverMonitor');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ip')
    .setDescription('Mostra o endereço público e o status do servidor Minecraft'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const status = await getCurrentServerStatus();

      if (status.online) {
        await interaction.editReply({ embeds: [buildOnlineEmbed(status)] });
        return;
      }

      await interaction.editReply({ embeds: [buildOfflineEmbed(status.endpoint)] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('❌ Não foi possível consultar o status do servidor agora.');
    }
  }
};
