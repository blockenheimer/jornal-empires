# Estrutura do projeto no GitHub

A raiz do repositório deve ser a pasta do bot. Não coloque uma pasta extra como `jornalempires_render_paragrafos/` acima dela.

```text
jornalempires/
├── index.js
├── deploy-commands.js
├── package.json
├── package-lock.json
├── .gitignore
├── .env.example
├── config.json
├── commands/
│   ├── jornal.js
│   ├── ip.js
│   └── players.js
├── utils/
│   ├── flags.js
│   ├── minecraftServer.js
│   ├── newspaper.js
│   ├── serverDate.js
│   ├── serverMonitor.js
│   └── syncCommands.js
└── assets/
    ├── fonts/
    │   └── ...
    └── flags/
        └── ...
```

## Render

Use:

- **Root Directory:** deixe vazio, se o repositório já tiver `index.js` na raiz.
- **Build Command:** `npm install`
- **Start Command:** `node index.js`

As variáveis `DISCORD_TOKEN`, `CLIENT_ID` e `GUILD_ID` devem ficar nas Environment Variables do Render, não no GitHub.

O arquivo `.env` local também não deve ser enviado para o GitHub. O `.gitignore` já deve ignorá-lo.
