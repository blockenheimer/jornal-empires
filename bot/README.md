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

O monitor foi reescrito em camadas para evitar o falso `ONLINE` causado pelo
proxy/ghost proxy da Aternos.

### Fluxo de decisão

1. O bot resolve `_minecraft._tcp.<ATERNOS_DOMAIN>` para descobrir o DynIP e a
   porta atuais. Usa DNS do sistema, resolvedor dedicado e DNS-over-HTTPS como
   fallback. `mcstatus.io` é opcional e serve **somente para descobrir SRV**,
   nunca para decidir o estado. A documentação da Aternos confirma que o
   endereço usa DNS/SRV e que o DynIP muda quando o servidor é iniciado.
2. Cada DynIP descoberto é consultado diretamente com o protocolo Java
   Server List Ping. O hostname original só é usado no handshake; a conexão
   TCP é feita no DynIP.
3. Uma resposta do proxy principal (`ATERNOS_DOMAIN:25565`) **nunca pode
   produzir ONLINE**. Ela só pode identificar `STARTING`, `OFFLINE` ou
   `UNKNOWN`.
4. `ONLINE` exige uma resposta Java válida no DynIP e passa pelo classificador
   estrito que rejeita fingerprints de proxy/espera.
5. Falhas de DNS, timeout ou rede produzem `UNKNOWN`, não `OFFLINE`.
6. O último DynIP confirmado é persistido em `data/aternos-last-endpoint.json`
   e continua sendo exibido quando o servidor está offline ou quando a
   consulta está inconclusiva.

Essa separação é intencional: a Aternos documenta que o DynIP é o endereço
direto do servidor e que ele muda a cada inicialização; portanto o DynIP é o
caminho usado para provar `ONLINE`. citeturn1search1turn1search0
O projeto público Aternos Watcher também documenta o problema de "Ghost
Proxies" e filtra estados de espera/offline antes de considerar o servidor
online. citeturn0search1

### Estados

- `ONLINE`: somente resposta confirmada do DynIP real.
- `STARTING`: proxy Aternos informa explicitamente preparação/inicialização.
- `OFFLINE`: proxy informa explicitamente offline/stop/waiting.
- `UNKNOWN`: não há evidência suficiente para afirmar o estado.

O `UNKNOWN` nunca derruba um estado já confirmado pelo monitor e nunca apaga o
último DynIP salvo.

### Comandos

- `/ip` usa exatamente o mesmo motor de detecção do monitor.
- `/players` usa somente dados de uma resposta `ONLINE` confirmada.
- O Discord nunca exibe `ATERNOS_DOMAIN`; exibe somente o último DynIP
  `*.aternos.host:porta` conhecido.

### Variáveis

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
SERVER_DNS_SERVERS=1.1.1.1,8.8.8.8
SERVER_MCSTATUS_FALLBACK=true
SERVER_PROXY_PORT=25565
```

### Testes

Execute:

```bash
npm test
```

Os testes verificam explicitamente que uma resposta genérica que "parece
online" no proxy **não** vira `ONLINE`, enquanto uma resposta válida do DynIP
vira `ONLINE`.
