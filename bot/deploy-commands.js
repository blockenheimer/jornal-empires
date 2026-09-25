require('dotenv').config();
const { syncCommands } = require('./utils/syncCommands');

syncCommands().catch((error) => {
  console.error('❌ Falha ao sincronizar comandos:', error);
  process.exit(1);
});
