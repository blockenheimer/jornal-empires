const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { listarPaises } = require('../utils/paises');
const { calcularDataServidor } = require('../utils/serverDate');
const { generateNewspaperImage } = require('../utils/newspaper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('jornal')
    .setDescription('Gera uma manchete/folhetim de jornal para o Empires')
    .addStringOption((opt) =>
      opt
        .setName('pais')
        .setDescription('Nação do jornal (comece a digitar para buscar na lista do Empires)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt.setName('nome').setDescription('Nome do jornal').setRequired(true).setMaxLength(60)
    )
    .addStringOption((opt) =>
      opt.setName('manchete').setDescription('Manchete principal').setRequired(true).setMaxLength(200)
    )
    .addStringOption((opt) =>
      opt.setName('texto').setDescription('Texto/corpo da matéria').setRequired(true).setMaxLength(3500)
    )
    .addStringOption((opt) =>
      opt.setName('subtitulo').setDescription('Subtítulo (opcional)').setRequired(false).setMaxLength(200)
    )
    .addAttachmentOption((opt) =>
      opt
        .setName('imagem')
        .setDescription('Imagem opcional para colocar abaixo do título')
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const foco = interaction.options.getFocused().toLowerCase();
    const filtrados = listarPaises()
      .filter((p) => p.nome.toLowerCase().includes(foco))
      .slice(0, 25)
      .map((p) => ({ name: p.nome, value: p.codigo }));
    await interaction.respond(filtrados);
  },

  async execute(interaction) {
    await interaction.deferReply();

    const codigoPais = interaction.options.getString('pais');
    const nomeJornal = interaction.options.getString('nome');
    const manchete = interaction.options.getString('manchete');
    const subtitulo = interaction.options.getString('subtitulo');
    const texto = interaction.options.getString('texto');
    const anexo = interaction.options.getAttachment('imagem');

    const paisInfo = listarPaises().find((p) => p.codigo === codigoPais);
    if (!paisInfo) {
      await interaction.editReply(
        '❌ País inválido. Use as opções sugeridas pelo autocomplete ao digitar o nome do país.'
      );
      return;
    }

    if (anexo && !anexo.contentType?.startsWith('image/')) {
      await interaction.editReply('❌ O arquivo anexado precisa ser uma imagem.');
      return;
    }

    let imagemBuffer = null;
    if (anexo) {
      const resp = await fetch(anexo.url);
      imagemBuffer = Buffer.from(await resp.arrayBuffer());
    }

    const dataServidor = calcularDataServidor();

    try {
      const pngBuffer = await generateNewspaperImage({
        paisCodigo: paisInfo.codigo,
        nomeJornal,
        dataServidor,
        manchete,
        subtitulo,
        texto,
        imagemBuffer
      });

      const arquivo = new AttachmentBuilder(pngBuffer, { name: 'jornal.png' });
      await interaction.editReply({ files: [arquivo] });
    } catch (err) {
      console.error(err);
      await interaction.editReply(
        `❌ Ocorreu um erro ao gerar o jornal: ${err.message}`
      );
    }
  }
};
