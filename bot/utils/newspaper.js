const path = require('path');
const { createCanvas, registerFont, loadImage } = require('canvas');
const { getFlagImage } = require('./flags');

// ---- Fontes ----
// Times New Roman "de verdade" para o corpo do jornal, a manchete e o
// subtítulo (itálico), e Times New Roman MT Condensed Bold só para o
// nome do jornal (o "logotipo" no topo).
const FONT_REGULAR = 'TimesNewRomanNewsSerif';
const FONT_CONDENSED = 'TimesNewRomanCondensedNewsSerif';
const FONT_ITALIC = 'TimesNewRomanItalicNewsSerif';

registerFont(path.join(__dirname, '..', 'assets', 'fonts', 'TimesNewRoman-Regular.ttf'), { family: FONT_REGULAR, weight: 'normal', style: 'normal' });
registerFont(path.join(__dirname, '..', 'assets', 'fonts', 'TimesNewRoman-Bold.ttf'), { family: FONT_REGULAR, weight: 'bold', style: 'normal' });
registerFont(path.join(__dirname, '..', 'assets', 'fonts', 'TimesNewRomanCondensed-Bold.otf'), { family: FONT_CONDENSED, weight: 'bold', style: 'normal' });
registerFont(path.join(__dirname, '..', 'assets', 'fonts', 'TimesNewRoman-Italic.ttf'), { family: FONT_ITALIC, weight: 'normal', style: 'italic' });

// ---- Layout ----
const WIDTH = 1200;
const MARGIN = 60;
const CONTENT_WIDTH = WIDTH - MARGIN * 2;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Quebra um texto em linhas respeitando uma largura disponível que PODE
 * variar por linha (usado para abrir espaço para a capitular no início
 * do texto). `widthForLine(lineIndex)` retorna a largura disponível
 * (em px) para aquela linha.
 */
function wrapTextVariable(ctx, text, widthForLine) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  let lineIndex = 0;

  for (const word of words) {
    const maxWidth = widthForLine(lineIndex);
    const testLine = current ? `${current} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && current) {
      lines.push(current);
      lineIndex++;
      current = word;
    } else {
      current = testLine;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapText(ctx, text, maxWidth) {
  return wrapTextVariable(ctx, text, () => maxWidth);
}

/** Reduz o tamanho da fonte até que o texto caiba em maxWidth numa única linha. */
function fitFontSize(ctx, text, maxWidth, startSize, minSize, fontBuilder) {
  let size = startSize;
  ctx.font = fontBuilder(size);
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = fontBuilder(size);
  }
  return size;
}

/** Desenha uma linha de texto justificada (espaça as palavras para ocupar toda a largura). */
function drawJustifiedLine(ctx, line, x, y, width) {
  const words = line.split(' ');
  if (words.length === 1) {
    ctx.fillText(line, x, y);
    return;
  }
  const totalTextWidth = words.reduce((sum, w) => sum + ctx.measureText(w).width, 0);
  const totalSpace = width - totalTextWidth;
  const gap = totalSpace / (words.length - 1);

  let cursorX = x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const word of words) {
    ctx.fillText(word, cursorX, y);
    cursorX += ctx.measureText(word).width + gap;
  }
  ctx.textAlign = prevAlign;
}

/**
 * Gera a imagem do jornal/folhetim.
 * @param {object} opts
 * @param {string} opts.paisCodigo   código ISO alpha-2 do país (ex: "br")
 * @param {string} opts.nomeJornal
 * @param {object} opts.dataServidor  objeto retornado por calcularDataServidor()
 *   ({ ano, mesIndex, mesNome, dia, texto })
 * @param {string} opts.manchete
 * @param {string} [opts.subtitulo]
 * @param {string} opts.texto
 * @param {Buffer} [opts.imagemBuffer]  imagem opcional anexada pelo usuário
 * @returns {Promise<Buffer>} PNG
 */
async function generateNewspaperImage(opts) {
  const {
    paisCodigo,
    nomeJornal,
    dataServidor,
    manchete,
    subtitulo,
    texto,
    imagemBuffer
  } = opts;

  // Canvas de medição (tamanho não importa, só precisamos do contexto 2D)
  const measure = createCanvas(10, 10).getContext('2d');

  // ---------- Carrega imagens ----------
  const flagImg = await getFlagImage(paisCodigo).catch(() => null);
  const anexoImg = imagemBuffer ? await loadImage(imagemBuffer).catch(() => null) : null;

  // ---------- Textos da data do servidor ----------
  // Linha principal: "25 de Setembro de 1953" (dia real ao lado do mês do RP)
  const dataPrincipalTexto = `${dataServidor.dia} de ${dataServidor.mesNome} de ${dataServidor.ano}`;
  // Linha numérica: dd/mm/aa
  const dataNumericaTexto = `${pad2(dataServidor.dia)}/${pad2(dataServidor.mesIndex + 1)}/${pad2(dataServidor.ano % 100)}`;

  // ---------- Medidas do cabeçalho ----------
  const flagBoxW = 190;
  const flagBoxH = 110;
  const headerGap = 24; // respiro entre a bandeira/data e o nome do jornal

  // A caixa da data é dimensionada a partir do texto real (o dia muda,
  // o mês muda de tamanho, etc.), com uma folga mínima, em vez de um
  // valor fixo que podia acabar cortando ou colidindo com o título.
  measure.font = `26px "${FONT_REGULAR}"`;
  const dataPrincipalWidth = measure.measureText(dataPrincipalTexto).width;
  measure.font = `20px "${FONT_REGULAR}"`;
  const dataNumericaWidth = measure.measureText(dataNumericaTexto).width;
  const dateBoxW = Math.max(150, Math.ceil(Math.max(dataPrincipalWidth, dataNumericaWidth)) + 10);

  const headerTop = MARGIN;
  const headerH = 130;

  const flagBoxX = MARGIN;
  const flagBoxY = headerTop;
  const dateBoxX = WIDTH - MARGIN - dateBoxW;

  // Centraliza o nome do jornal na página inteira, mas nunca deixa o texto
  // invadir a caixa da bandeira nem a caixa da data (o menor dos dois
  // espaços livres, dos dois lados do centro, define a largura máxima).
  const pageCenterX = WIDTH / 2;
  const leftLimit = flagBoxX + flagBoxW + headerGap;
  const rightLimit = dateBoxX - headerGap;
  const nomeMaxWidth = Math.max(80, 2 * Math.min(pageCenterX - leftLimit, rightLimit - pageCenterX));

  const nomeFontSize = fitFontSize(
    measure, nomeJornal.toUpperCase(), nomeMaxWidth, 84, 30,
    (s) => `bold ${s}px "${FONT_CONDENSED}"`
  );

  // ---------- Medidas da manchete ----------
  let mancheteFontSize = 70;
  measure.font = `bold ${mancheteFontSize}px "${FONT_REGULAR}"`;
  function palavraMaisLargaFits(ctx, texto, maxW) {
    return texto.split(/\s+/).every((w) => ctx.measureText(w).width <= maxW);
  }
  while (palavraMaisLargaFits(measure, manchete, CONTENT_WIDTH) === false && mancheteFontSize > 32) {
    mancheteFontSize -= 2;
    measure.font = `bold ${mancheteFontSize}px "${FONT_REGULAR}"`;
  }
  const mancheteLineHeight = Math.round(mancheteFontSize * 1.12);
  const mancheteLines = wrapText(measure, manchete.toUpperCase(), CONTENT_WIDTH);
  const mancheteH = mancheteLines.length * mancheteLineHeight;

  // ---------- Medidas do subtítulo ----------
  let subtituloLines = [];
  let subtituloFontSize = 30;
  let subtituloLineHeight = 0;
  if (subtitulo && subtitulo.trim()) {
    measure.font = `italic ${subtituloFontSize}px "${FONT_ITALIC}"`;
    subtituloLines = wrapText(measure, subtitulo, CONTENT_WIDTH);
    subtituloLineHeight = Math.round(subtituloFontSize * 1.35);
  }
  const subtituloH = subtituloLines.length * subtituloLineHeight;

  // ---------- Medidas da imagem anexa ----------
  let anexoDrawW = 0, anexoDrawH = 0;
  if (anexoImg) {
    const maxW = CONTENT_WIDTH;
    const maxH = 560;
    const ratio = Math.min(maxW / anexoImg.width, maxH / anexoImg.height, 1);
    anexoDrawW = Math.round(anexoImg.width * ratio);
    anexoDrawH = Math.round(anexoImg.height * ratio);
  }

  // ---------- Medidas do texto (com parágrafos + capitular) ----------
  const textoFontSize = 25;
  const textoLineHeight = Math.round(textoFontSize * 1.5);
  const paragraphIndent = Math.round(textoFontSize * 1.6);
  const paragraphGap = Math.round(textoFontSize * 0.24);
  measure.font = `${textoFontSize}px "${FONT_REGULAR}"`;

  // Discord envia Shift+Enter como \n dentro do campo longo.
  // Aqui isso vira um novo parágrafo tipográfico de verdade: a primeira
  // linha de cada parágrafo (exceto o 1º, que usa a capitular) recebe recuo.
  const textoNormalizado = String(texto ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const paragrafos = textoNormalizado
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragrafos.length === 0) paragrafos.push('');

  const capSize = textoLineHeight * 2.15;
  // A capitular existe somente no começo do primeiro parágrafo.
  // Só a 1ª linha desse parágrafo abre espaço para ela.
  const capLinesCount = 1;
  measure.font = `bold ${capSize}px "${FONT_REGULAR}"`;
  const primeiraLetra = paragrafos[0].charAt(0);
  const restoPrimeiroParagrafo = paragrafos[0].slice(1);
  const capMetrics = measure.measureText(primeiraLetra);
  const capWidth = primeiraLetra ? Math.ceil(capMetrics.width) + 14 : 0;
  // Altura real (visual) da tinta da capitular, não a métrica "de fonte"
  // (que reserva espaço extra para acentos/ascendentes que talvez nem
  // apareçam) — isso é o que faz ela alinhar de verdade com o texto.
  const capAscent = capMetrics.actualBoundingBoxAscent || 0;
  const capDescent = capMetrics.actualBoundingBoxDescent || 0;

  measure.font = `${textoFontSize}px "${FONT_REGULAR}"`;
  const textoParagrafos = paragrafos.map((paragrafo, paragraphIndex) => {
    if (paragraphIndex === 0) {
      return wrapTextVariable(measure, restoPrimeiroParagrafo, (lineIdx) =>
        lineIdx < capLinesCount ? CONTENT_WIDTH - capWidth : CONTENT_WIDTH
      );
    }

    return wrapTextVariable(measure, paragrafo, (lineIdx) =>
      lineIdx === 0 ? CONTENT_WIDTH - paragraphIndent : CONTENT_WIDTH
    );
  });

  const textoH = textoParagrafos.reduce(
    (total, lines) => total + lines.length * textoLineHeight,
    0
  ) + Math.max(0, textoParagrafos.length - 1) * paragraphGap;

  // A capitular é alinhada EXCLUSIVAMENTE pela base (baseline) da 1ª linha
  // do parágrafo — não pela última linha recuada, nem por uma média entre
  // topo/base. A base da capitular cai exatamente onde cai a base da 1ª
  // linha de texto normal.
  const primeiraLinhaBaselineOffset = textoLineHeight * 0.8;
  const capBaselineOffset = primeiraLinhaBaselineOffset;

  // Espaço entre a imagem anexa e o parágrafo: calculado a partir da
  // própria capitular, para garantir que ela sempre comece logo abaixo da
  // imagem (sem sobrepor) e não fique "descendo" mais do que o necessário.
  const espacoAposImagem = Math.max(24, Math.round(capAscent - primeiraLinhaBaselineOffset) + 10);

  // ---------- Altura total do canvas ----------
  let y = headerTop + headerH; // depois da régua horizontal
  y += 4; // espessura da régua
  y += 26; // respiro
  y += mancheteH;
  y += 16;
  if (subtituloLines.length) y += subtituloH + 22;
  if (anexoDrawH) y += anexoDrawH + espacoAposImagem;
  y += Math.max(textoH, capBaselineOffset + capDescent + 6);
  y += MARGIN; // margem inferior

  const HEIGHT = y;

  // ================= DESENHO =================
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // fundo (papel levemente creme, estilo jornal antigo)
  ctx.fillStyle = '#fbf9f3';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';

  // ---- Caixa da bandeira ----
  ctx.lineWidth = 2.5;
  ctx.strokeRect(flagBoxX, flagBoxY, flagBoxW, flagBoxH);
  if (flagImg) {
    // "cover" dentro da caixa, com pequena margem interna
    const pad = 6;
    const bw = flagBoxW - pad * 2;
    const bh = flagBoxH - pad * 2;
    const ratio = Math.max(bw / flagImg.width, bh / flagImg.height);
    const iw = flagImg.width * ratio;
    const ih = flagImg.height * ratio;
    ctx.save();
    ctx.beginPath();
    ctx.rect(flagBoxX + pad, flagBoxY + pad, bw, bh);
    ctx.clip();
    ctx.drawImage(
      flagImg,
      flagBoxX + pad + (bw - iw) / 2,
      flagBoxY + pad + (bh - ih) / 2,
      iw, ih
    );
    ctx.restore();
  } else {
    ctx.font = `18px "${FONT_REGULAR}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BANDEIRA', flagBoxX + flagBoxW / 2, flagBoxY + flagBoxH / 2);
  }

  // ---- Nome do jornal (centralizado na página) ----
  ctx.font = `bold ${nomeFontSize}px "${FONT_CONDENSED}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(nomeJornal.toUpperCase(), pageCenterX, flagBoxY + flagBoxH / 2, nomeMaxWidth);

  // ---- Data do servidor (direita) ----
  ctx.textAlign = 'right';
  ctx.font = `26px "${FONT_REGULAR}"`;
  ctx.fillText(dataPrincipalTexto, WIDTH - MARGIN, flagBoxY + flagBoxH / 2 - 12);
  ctx.font = `20px "${FONT_REGULAR}"`;
  ctx.fillText(dataNumericaTexto, WIDTH - MARGIN, flagBoxY + flagBoxH / 2 + 20);

  // ---- Régua horizontal ----
  let cursorY = headerTop + headerH;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(MARGIN, cursorY);
  ctx.lineTo(WIDTH - MARGIN, cursorY);
  ctx.stroke();
  cursorY += 4 + 26;

  // ---- Manchete ----
  ctx.font = `bold ${mancheteFontSize}px "${FONT_REGULAR}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const line of mancheteLines) {
    cursorY += mancheteLineHeight * 0.78;
    ctx.fillText(line, WIDTH / 2, cursorY);
    cursorY += mancheteLineHeight * 0.22;
  }
  cursorY += 16;

  // ---- Subtítulo ----
  if (subtituloLines.length) {
    ctx.font = `italic ${subtituloFontSize}px "${FONT_ITALIC}"`;
    ctx.textAlign = 'center';
    for (const line of subtituloLines) {
      cursorY += subtituloLineHeight * 0.75;
      ctx.fillText(line, WIDTH / 2, cursorY);
      cursorY += subtituloLineHeight * 0.25;
    }
    cursorY += 22;
  }

  // ---- Imagem anexa ----
  if (anexoImg) {
    const imgX = MARGIN + (CONTENT_WIDTH - anexoDrawW) / 2;
    ctx.drawImage(anexoImg, imgX, cursorY, anexoDrawW, anexoDrawH);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(imgX, cursorY, anexoDrawW, anexoDrawH);
    cursorY += anexoDrawH + espacoAposImagem;
  }

  // ---- Corpo do texto com capitular + parágrafos ----
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Capitular: somente o 1º parágrafo usa a letra grande.
  if (primeiraLetra) {
    ctx.font = `bold ${capSize}px "${FONT_REGULAR}"`;
    ctx.fillText(primeiraLetra, MARGIN, cursorY + capBaselineOffset);
  }

  ctx.font = `${textoFontSize}px "${FONT_REGULAR}"`;
  let textY = cursorY + textoLineHeight * 0.8;

  textoParagrafos.forEach((lines, paragraphIndex) => {
    lines.forEach((line, idx) => {
      let x = MARGIN;
      let w = CONTENT_WIDTH;

      // 1º parágrafo: só a 1ª linha abre espaço para a capitular.
      if (paragraphIndex === 0 && idx < capLinesCount) {
        x += capWidth;
        w -= capWidth;
      // Demais parágrafos: recuo normal de primeira linha.
      } else if (paragraphIndex > 0 && idx === 0) {
        x += paragraphIndent;
        w -= paragraphIndent;
      }

      const isLast = idx === lines.length - 1;
      if (!isLast) {
        drawJustifiedLine(ctx, line, x, textY, w);
      } else {
        ctx.fillText(line, x, textY);
      }
      textY += textoLineHeight;
    });

    if (paragraphIndex < textoParagrafos.length - 1) {
      textY += paragraphGap;
    }
  });

  return canvas.toBuffer('image/png');
}

module.exports = { generateNewspaperImage, WIDTH };
