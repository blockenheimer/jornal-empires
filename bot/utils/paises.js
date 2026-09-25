const fs = require('fs');
const path = require('path');

const FLAGS_DIR = path.join(__dirname, '..', 'assets', 'flags');
const EXT_REGEX = /\.(png|jpe?g|webp)$/i;

function carregarNomesCustomizados() {
  const nomesPath = path.join(FLAGS_DIR, 'nomes.json');
  if (!fs.existsSync(nomesPath)) return {};
  try {
    const dados = JSON.parse(fs.readFileSync(nomesPath, 'utf-8'));
    delete dados._comentario;
    return dados;
  } catch (e) {
    console.warn('⚠️  Não foi possível ler assets/flags/nomes.json:', e.message);
    return {};
  }
}

function paraTituloLegivel(codigo) {
  return codigo
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Lê a pasta assets/flags/ e retorna a lista de países/nações disponíveis,
 * na forma [{ codigo, nome }]. `codigo` é o nome do arquivo sem extensão
 * (ex: "vulperia"), usado como valor interno da opção do slash command.
 * `nome` é o texto exibido no autocomplete e no jornal, tirado de
 * assets/flags/nomes.json quando existir, ou gerado a partir do nome do
 * arquivo.
 */
function listarPaises() {
  if (!fs.existsSync(FLAGS_DIR)) return [];

  const nomesCustom = carregarNomesCustomizados();

  const arquivos = fs.readdirSync(FLAGS_DIR).filter((f) => EXT_REGEX.test(f));
  const lista = arquivos.map((arquivo) => {
    const codigo = path.parse(arquivo).name;
    const nome = nomesCustom[codigo] || paraTituloLegivel(codigo);
    return { codigo, nome };
  });

  lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt'));
  return lista;
}

module.exports = { listarPaises, FLAGS_DIR };
