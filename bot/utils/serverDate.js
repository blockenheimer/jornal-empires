const config = require('../config.json');

const MESES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

// Quantos dias reais cada mês do servidor "ocupa" dentro do mês real atual.
// Regra do Empires: meses reais de 31 dias valem 3 dias de servidor, meses reais
// de 30 (ou 28, no caso de fevereiro) valem 2 dias de servidor. Aplicando
// isso aos 12 meses do servidor (6 "de 3 dias" + 6 "de 2 dias") dá
// 6*3 + 6*2 = 30, batendo com um mês real "padrão" de 30 dias.
// Dezembro fica com o bloco de 2 dias "base": quando o mês real em curso
// tem 31 dias, o 31º dia sobra pra ele, então ganha +1 (vira 3) só nesses
// meses — é o que fecha a conta certinha em 31.
const BLOCOS_SERVIDOR_PADRAO = [3, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 2];

/** Quantos dias tem o mês real `mesIndex0based` (0-11) do ano `ano`. */
function diasNoMesReal(ano, mesIndex0based) {
  return new Date(Date.UTC(ano, mesIndex0based + 1, 0)).getUTCDate();
}

/**
 * Calcula a data do servidor de Empires com base na data real de hoje.
 *
 * Regra:
 *  - O ANO do servidor sobe em 1 a cada mês real que passa.
 *  - O MÊS do servidor é calculado a partir do dia do mês real atual,
 *    percorrendo os blocos de `BLOCOS_SERVIDOR_PADRAO` (3 dias para os
 *    meses "de 31", 2 dias para os "de 30/28"), na ordem Janeiro→Dezembro,
 *    reiniciando a cada mês real novo. Se o mês real atual tiver 31 dias,
 *    o dia 31 é somado ao bloco de Dezembro (que passa a valer 3 em vez
 *    de 2 só nesse mês). Se sobrarem dias reais depois do bloco de
 *    Dezembro (não deveria acontecer, mas por segurança), o mês do
 *    servidor fica travado em Dezembro.
 *
 * @param {Date} [now] Data real a considerar (default: agora)
 * @returns {{ano: number, mesIndex: number, mesNome: string, dia: number, texto: string}}
 */
function calcularDataServidor(now = new Date()) {
  const inicio = new Date(config.dataInicioReal + 'T00:00:00Z');

  const anoAtualReal = now.getUTCFullYear();
  const mesAtualReal = now.getUTCMonth(); // 0-11
  const diaAtualReal = now.getUTCDate();  // 1-31

  const anoInicioReal = inicio.getUTCFullYear();
  const mesInicioReal = inicio.getUTCMonth();

  // Quantos meses reais se passaram desde o início (pode ser 0, 1, 2...)
  const mesesDecorridos =
    (anoAtualReal - anoInicioReal) * 12 + (mesAtualReal - mesInicioReal);

  const anoServidor = config.anoInicio + Math.max(0, mesesDecorridos);

  const blocos = BLOCOS_SERVIDOR_PADRAO.slice();
  if (diasNoMesReal(anoAtualReal, mesAtualReal) >= 31) {
    blocos[11] += 1; // dezembro absorve o 31º dia do mês real
  }

  let mesIndex = 11; // trava em Dezembro caso o dia real ultrapasse todos os blocos
  let acumulado = 0;
  for (let i = 0; i < blocos.length; i++) {
    acumulado += blocos[i];
    if (diaAtualReal <= acumulado) {
      mesIndex = i;
      break;
    }
  }

  const mesNome = MESES_PT[mesIndex];

  return {
    ano: anoServidor,
    mesIndex,
    mesNome,
    dia: diaAtualReal,
    texto: `${mesNome} de ${anoServidor}`
  };
}

module.exports = { calcularDataServidor, MESES_PT };
