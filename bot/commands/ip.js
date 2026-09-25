const { SlashCommandBuilder } = require('discord.js');
const {
  getCurrentServerStatus,
  buildOnlineEmbed,
  buildOfflineEmbed,
  buildStartingEmbed,
  buildUnknownEmbed,
  buildWaitingEmbed,
  buildStoppingEmbed
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
      const embeds = {
        [SERVER_STATE.ONLINE]: buildOnlineEmbed,
        [SERVER_STATE.STARTING]: buildStartingEmbed,
        [SERVER_STATE.WAITING]: buildWaitingEmbed,
        [SERVER_STATE.STOPPING]: buildStoppingEmbed,
        [SERVER_STATE.UNKNOWN]: buildUnknownEmbed,
        [SERVER_STATE.OFFLINE]: buildOfflineEmbed
      };
      await interaction.editReply({ embeds: [embeds[state] ? embeds[state](status) : buildUnknownEmbed(status)] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('❌ Não foi possível consultar o status do servidor agora.');
    }
  }
};
