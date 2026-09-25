const fs = require('fs');
const path = require('path');
const { loadImage } = require('canvas');
const { FLAGS_DIR } = require('./paises');

const EXT_REGEX = /\.(png|jpe?g|webp)$/i;

/**
 * Carrega a imagem da bandeira de uma nação a partir de assets/flags/,
 * pelo "codigo" (nome do arquivo sem extensão, ex: "vulperia").
 */
async function getFlagImage(codigo) {
  if (!fs.existsSync(FLAGS_DIR)) {
    throw new Error('Pasta assets/flags/ não encontrada.');
  }

  const arquivo = fs
    .readdirSync(FLAGS_DIR)
    .find((f) => EXT_REGEX.test(f) && path.parse(f).name === codigo);

  if (!arquivo) {
    throw new Error(`Bandeira "${codigo}" não encontrada em assets/flags/.`);
  }

  return loadImage(path.join(FLAGS_DIR, arquivo));
}

module.exports = { getFlagImage };
