const { SlashCommandBuilder } = require('discord.js');
const { getCurrentServerStatus } = require('../utils/serverMonitor');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('players')
    .setDescription('Mostra os jogadores que aparecem na lista pública do servidor'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const status = await getCurrentServerStatus();

      if (!status.online) {
        await interaction.editReply('🔴 O servidor está OFFLINE.');
        return;
      }

      const online = status.players?.online ?? 0;
      const max = status.players?.max ?? 0;
      const players = status.players?.sample ?? [];

      let content = `👥 Jogadores (${online}/${max}) :`;
      if (players.length > 0) {
        content += `\n\n${players.map((name) => `- ${name}`).join('\n')}`;
      } else if (online > 0) {
        content += '\n\n- A lista de nomes não foi fornecida pelo servidor no status público.';
      } else {
        content += '\n\n- Nenhum jogador online.';
      }

      await interaction.editReply(content);
    } catch (error) {
      console.error(error);
      await interaction.editReply('❌ Não foi possível consultar os jogadores agora.');
    }
  }
};
