# Bot de Jornal/Folhetim para Empires Geopolítico

Bot de Discord que gera imagens de jornal (manchete, subtítulo, texto, bandeira do
país, nome do jornal e "data do servidor") via slash command `/jornal`.

### Diagnóstico de `srv-unavailable`

Se o log mostrar `Estado não confirmado (srv-unavailable)`, o problema não é mais o classificador do Aternos Watcher: significa que o processo não conseguiu obter o registro SRV do domínio. A versão atual tenta, nesta ordem, DNS do sistema, resolvedores DNS independentes (`1.1.1.1`/`8.8.8.8`), DNS-over-HTTPS por IP e, por último, `mcstatus.io` somente para descobrir o SRV. Depois disso, o host+porta encontrados são consultados diretamente pelo ping Minecraft do próprio bot.

A Aternos documenta que usa registros SRV porque o host e a porta mudam dinamicamente a cada inicialização.


## 1. Pré-requisitos

- Node.js 18 ou superior instalado ([nodejs.org](https://nodejs.org))
- Uma aplicação de bot criada no [Discord Developer Portal](https://discord.com/developers/applications)

## 2. Criando o bot no Discord

1. Acesse https://discord.com/developers/applications e clique em **New Application**.
2. Vá em **Bot** → **Reset Token** para gerar o token (guarde-o, ele só aparece uma vez).
3. Em **Bot**, deixe ligado o suficiente (não precisa de nenhum "Privileged Gateway
   Intent" para este bot, ele só usa slash commands).
4. Em **OAuth2 → URL Generator**, marque os escopos `bot` e `applications.commands`.
   Em "Bot Permissions" marque **Send Messages**, **Attach Files** e **Use Slash
   Commands**. Copie a URL gerada e abra no navegador para convidar o bot ao seu
   servidor.
5. Anote também o **Application ID** (fica no topo da página "General Information").

## 3. Instalando

Dentro da pasta do projeto:

```bash
npm install
```

Copie `.env.example` para `.env` e preencha:

```
DISCORD_TOKEN=token_do_bot
CLIENT_ID=application_id
GUILD_ID=id_do_seu_servidor   # opcional, mas recomendado para testes (comandos aparecem na hora)
```

Para pegar o `GUILD_ID`: no Discord, ative o Modo Desenvolvedor (Configurações →
Avançado), clique com o botão direito no ícone do servidor → **Copiar ID do Servidor**.

## 4. Registrando os comandos e ligando o bot

```bash
npm run deploy   # sincroniza os slash commands manualmente
npm start        # liga o bot
```

O bot também sincroniza os slash commands automaticamente toda vez que inicia.
Quando `GUILD_ID` estiver definido, ele limpa os comandos globais antigos e
substitui a lista de comandos do servidor, evitando casos como dois `/jornal`.

Se você estiver usando Render com um Start Command personalizado, use `npm start`
ou `node index.js`; os dois caminhos agora fazem a sincronização automaticamente.

## 5. Usando o comando

```
/jornal pais:<comece a digitar o nome> nome:<nome do jornal> manchete:<manchete>
        texto:<corpo da matéria> subtitulo:<opcional> imagem:<anexo opcional>
```

- **pais**: tem autocomplete — comece a digitar e o Discord sugere a lista das
  nações do Empires (lidas de `assets/flags/`, veja a seção 6.1 abaixo).
- **nome**: nome do jornal, aparece em destaque no topo.
- **manchete**: o título grande, tudo em maiúsculas automaticamente.
- **subtitulo**: opcional, aparece em itálico abaixo da manchete.
- **texto**: corpo da matéria, com capitular (letra grande) na primeira letra e
  texto justificado, como um jornal de verdade.
- **imagem**: opcional, entra entre o subtítulo e o texto.
- A "data do servidor" é calculada automaticamente — você não digita, ela sai da
  configuração em `config.json`.

A imagem final cresce ou diminui de altura sozinha dependendo do tamanho da
manchete, do subtítulo e do texto.

## 6. Calibrando o calendário do Empires (`config.json`)

```json
{
  "dataInicioReal": "2026-09-01",
  "anoInicio": 1953
}
```

- `dataInicioReal` + `anoInicio`: diz ao bot "no dia 1 deste mês real, o ano do
  servidor era X". A partir daí, o ano do servidor sobe automaticamente em 1 a
  cada mês real que passa (setembro real = 1953, outubro real = 1954, ...).
- O MÊS do servidor percorre Janeiro→Dezembro dentro de cada mês real,
  usando blocos fixos: meses do servidor "de 31" (Jan, Mar, Mai, Jul, Ago,
  Out) duram 3 dias reais cada, e os "de 30/28" (Fev, Abr, Jun, Set, Nov,
  Dez) duram 2 dias reais cada — 6×3 + 6×2 = 30 dias, o tamanho de um mês
  real "padrão". Quando o mês real atual tem 31 dias, esse dia extra é
  somado ao bloco de Dezembro (que passa a durar 3 dias só nesse mês), pra
  fechar certinho em 31. Isso não é configurável — é fixo no código
  (`utils/serverDate.js`).

Ajuste os dois valores acima como quiser — o bot recalcula tudo sozinho, sem
precisar reiniciar mais do que uma vez após editar o arquivo.

### 6.1 Gerenciando as nações/bandeiras do Empires

As bandeiras ficam em `assets/flags/`. O bot lê essa pasta sozinho — não tem
lista fixa de países no código.

- **Adicionar uma nação nova**: solte o arquivo `.png` (ou `.jpg`/`.webp`) da
  bandeira dentro de `assets/flags/`, com o nome do arquivo sendo o "código"
  da nação (ex: `vulperia.png`). Ela já aparece no autocomplete na próxima vez
  que o bot responder — não precisa reiniciar nem rodar `npm run deploy` de
  novo (isso só é necessário se você mudar a estrutura do comando em si).
- **Nome de exibição**: por padrão o bot transforma o nome do arquivo em
  título (`republic_of_bananas.png` → "Republic Of Bananas"). Para um nome
  mais bonito ou com acento, edite `assets/flags/nomes.json` e adicione
  `"codigo_do_arquivo": "Nome Bonito"`, por exemplo:
  ```json
  "republic_of_bananas": "República das Bananas"
  ```
- **Remover uma nação**: apague o `.png` correspondente (e, se quiser, a
  entrada dela em `nomes.json`).
- **Trocar a bandeira de uma nação**: substitua o arquivo `.png` mantendo o
  mesmo nome.

## 7. Hospedagem

Para o bot ficar online 24/7, hospede-o em algum serviço que rode Node.js
continuamente (VPS, Railway, Render, etc.) e rode `npm start` lá — os slash
commands continuam funcionando normalmente, só o processo do bot (`index.js`)
precisa estar sempre rodando.

## Estrutura do projeto

```
commands/jornal.js     -> definição do slash command + lógica de execução
utils/newspaper.js      -> gera a imagem do jornal (node-canvas)
utils/flags.js          -> carrega a imagem da bandeira a partir de assets/flags/
utils/paises.js          -> lê assets/flags/ e monta a lista de nações do Empires
utils/serverDate.js     -> calcula a "data do servidor" do Empires
assets/flags/            -> bandeiras das nações do Empires (.png) + nomes.json
assets/fonts/           -> fonte Tinos (compatível com Times New Roman)
config.json              -> configuração do calendário do Empires
```


## 8. Monitor do servidor Minecraft/Aternos

O bot pode monitorar um servidor Java pelo registro DNS SRV do domínio principal, sem exibir publicamente o domínio principal. Configure no `.env`:

```env
ATERNOS_DOMAIN=seu-servidor.aternos.me
SERVER_STATUS_CHANNEL_ID=980951220502003753
SERVER_CHECK_INTERVAL_MS=30000
SERVER_STATE_CONFIRM_READINGS=2
SERVER_STARTING_CONFIRM_READINGS=1
SERVER_QUERY_TIMEOUT_MS=8000
SERVER_QUERY_ATTEMPTS=2
SERVER_QUERY_RETRY_DELAY_MS=750
SERVER_DNS_HTTP_TIMEOUT_MS=5000
SERVER_MAX_ENDPOINTS=3
SERVER_MAX_ADDRESSES_PER_ENDPOINT=3
SERVER_STATUS_CHECK_BUDGET_MS=12000
SERVER_STATUS_DEBUG=true
```

O bot resolve `_minecraft._tcp.<domínio>` para descobrir o host/porta atuais (por exemplo, `dhufish.aternos.host:41235` — a porta muda a cada início do servidor) e faz um status ping do Minecraft. O domínio principal usado para a resolução não aparece nas mensagens do Discord. O bot também filtra as respostas do proxy Aternos para não confundir a sala de espera com o Minecraft real.

Comandos:

- `/ip` — mostra o host `.aternos.host`, a porta, o status, jogadores online/máximo e ping.
- `/players` — mostra os nomes presentes na lista pública de jogadores devolvida pelo status ping. A disponibilidade dessa lista depende do que o servidor/proxy fornece no status público.

Quando o estado muda, o bot envia automaticamente um **embed** com o título `Status` no canal configurado em `SERVER_STATUS_CHANNEL_ID`. O embed mostra somente o host dinâmico `.aternos.host:porta`; o domínio principal usado na configuração nunca é exibido. O `/ip` usa o mesmo embed e pode mostrar `SERVIDOR INICIANDO` durante o boot.

Depois de adicionar os novos comandos, rode novamente `npm run deploy`.


## Variáveis de ambiente no Render

Além de `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID`, configure estas variáveis no Render:

```env
ATERNOS_DOMAIN=MineEmpiresOf.aternos.me
SERVER_STATUS_CHANNEL_ID=980951220502003753
SERVER_CHECK_INTERVAL_MS=30000
SERVER_STATE_CONFIRM_READINGS=2
SERVER_STARTING_CONFIRM_READINGS=1
SERVER_QUERY_TIMEOUT_MS=8000
SERVER_QUERY_ATTEMPTS=2
SERVER_QUERY_RETRY_DELAY_MS=750
SERVER_DNS_HTTP_TIMEOUT_MS=5000
SERVER_MAX_ENDPOINTS=3
SERVER_MAX_ADDRESSES_PER_ENDPOINT=3
SERVER_STATUS_CHECK_BUDGET_MS=12000
SERVER_STATUS_DEBUG=true
```

`ATERNOS_DOMAIN` é o domínio principal usado apenas internamente pelo bot. O bot não o mostra aos jogadores; ele resolve o registro SRV e exibe somente o host dinâmico `*.aternos.host:porta`.

`SERVER_CHECK_INTERVAL_MS=30000` faz a verificação a cada 30 segundos.


### Monitor Aternos

O monitor usa o SRV do domínio principal para descobrir o host **e a porta** temporários (`*.aternos.host:porta`). A Aternos documenta que o DynIP muda a cada inicialização e que problemas de cache DNS podem deixar o domínio principal apontando para um endereço antigo.

Para reduzir esse problema, o bot agora consulta o SRV por três caminhos: resolver DNS do próprio sistema, Cloudflare DNS-over-HTTPS e Google DNS-over-HTTPS. Os resultados são combinados e deduplicados antes da consulta do Minecraft, sem usar `MineEmpiresOf.aternos.me:25565` como fallback.

Depois de descobrir o SRV, o bot resolve o host temporário (`*.aternos.host`) para IPv4/IPv6 por múltiplas fontes e tenta o **IP diretamente**, mas envia o domínio original no handshake do Minecraft. Assim, ele não depende apenas do cache DNS local e ainda permite que a infraestrutura da Aternos receba o hostname lógico correto.

O monitor também testa o último DynIP confirmado como candidato adicional. Ele só substitui esse valor depois de uma resposta `ONLINE` ou `SERVIDOR INICIANDO`; uma resposta `OFFLINE`/`UNKNOWN` do proxy não apaga o último IP conhecido.

A consulta gera logs de diagnóstico no Render quando `SERVER_STATUS_DEBUG=true`, incluindo SRVs encontrados, endpoint, IP usado, motivo da classificação, versão e jogadores. O objetivo é permitir distinguir claramente entre `proxy offline`, `proxy starting`, `proxy waiting`, falha DNS e resposta real do Minecraft.

`SERVER_STATE_CONFIRM_READINGS` (padrão `2`) define quantas checagens seguidas são necessárias para confirmar mudanças entre ONLINE/OFFLINE. `SERVER_STARTING_CONFIRM_READINGS` (padrão `1`) controla a confirmação do início. `SERVER_DNS_HTTP_TIMEOUT_MS` controla o timeout das consultas DNS-over-HTTPS; `SERVER_MAX_ENDPOINTS` limita quantos SRVs são testados por ciclo; `SERVER_MAX_ADDRESSES_PER_ENDPOINT` limita quantos IPv4/IPv6 são testados por endpoint; `SERVER_STATUS_CHECK_BUDGET_MS` limita o tempo total gasto nas tentativas do Minecraft em cada ciclo.

O classificador continua filtrando as respostas `offline`, `preparing`, `starting` e `stopping` e tratando `players.max = 0` como o fingerprint de espera usado pelo Aternos Watcher público.
