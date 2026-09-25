const { SlashCommandBuilder } = require('discord.js');
const { getCurrentServerStatus } = require('../utils/serverMonitor');
const { SERVER_STATE, stateOf } = require('../utils/minecraftServer');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('players')
    .setDescription('Mostra os jogadores que aparecem na lista pública do servidor'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const status = await getCurrentServerStatus();
      const state = stateOf(status);

      if (state === SERVER_STATE.STARTING) {
        await interaction.editReply('🟡 O servidor está iniciando. Aguarde alguns instantes.');
        return;
      }

      if (state === SERVER_STATE.WAITING) {
        await interaction.editReply('⏳ A Aternos está aguardando uma conexão ao servidor.');
        return;
      }

      if (state !== SERVER_STATE.ONLINE) {
        await interaction.editReply(state === SERVER_STATE.UNKNOWN
          ? '⚪ Não foi possível confirmar o estado do servidor agora.'
          : '🔴 O servidor está OFFLINE.');
        return;
      }

      const online = status.players?.online ?? 0;
      const max = status.players?.max ?? 0;
      const players = status.players?.sample ?? [];

      let content = `👥 Jogadores (${online}/${max}) :`;
      if (players.length > 0) content += `\n\n${players.map((name) => `- ${name}`).join('\n')}`;
      else if (online > 0) content += '\n\n- A lista de nomes não foi fornecida pelo status público.';
      else content += '\n\n- Nenhum jogador online.';

      await interaction.editReply(content);
    } catch (error) {
      console.error(error);
      await interaction.editReply('❌ Não foi possível consultar os jogadores agora.');
    }
  }
};
