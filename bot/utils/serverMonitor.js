const {EmbedBuilder}=require('discord.js');
const fs=require('fs'),path=require('path');
const {SERVER_STATE,stateOf,getServerStatus,isValidTemporaryEndpoint,sanitizeEndpoint}=require('./minecraftServer');
const INTERVAL=Math.max(5000,Number(process.env.SERVER_CHECK_INTERVAL_MS||30000));
const CHANNEL=process.env.SERVER_STATUS_CHANNEL_ID;
const DOMAIN=process.env.ATERNOS_DOMAIN?.trim();
const CONFIRM=Math.max(1,Number(process.env.SERVER_STATE_CONFIRM_READINGS||2));
const START_CONFIRM=Math.max(1,Number(process.env.SERVER_STARTING_CONFIRM_READINGS||1));
const STATE_DIR=path.join(__dirname,'..','data'),STATE_FILE=path.join(STATE_DIR,'aternos-last-endpoint.json');
let timer=null,checking=false,lastConfirmedState=null,pending=null,count=0,lastEndpoint=load();
function load(){try{return sanitizeEndpoint(JSON.parse(fs.readFileSync(STATE_FILE,'utf8')),'last-known')}catch(_){return null}}
function save(e){const s=sanitizeEndpoint(e,'last-known');if(!s)return;lastEndpoint=s;try{fs.mkdirSync(STATE_DIR,{recursive:true});fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));}catch(e){console.warn('⚠️ Falha salvando DynIP:',e.message)}}
function displayEndpoint(status){if(isValidTemporaryEndpoint(status?.endpoint)&&status?.proof==='direct-dynip')save(status.endpoint);return lastEndpoint||null}
function formatEndpoint(e=lastEndpoint){const s=sanitizeEndpoint(e,e?.source||'last-known');return s?`${s.publicHost}:${s.port}`:'ainda não detectado'}
function buildOnlineEmbed(s){return new EmbedBuilder().setTitle('Status').setDescription(`🌐 IP: ${formatEndpoint(s.endpoint)}\n🟢 Status: ONLINE   👥 Jogadores: ${s.players?.online??0}/${s.players?.max??0}   ⏱️ Ping: ${s.ping??0} ms`).setColor(0x57F287)}
function buildStartingEmbed(s){return new EmbedBuilder().setTitle('Status').setDescription(`🌐 Último IP conhecido: ${formatEndpoint(s?.endpoint)}\n🟡 Status: SERVIDOR INICIANDO\n⏳ Aguarde enquanto a Aternos inicia o servidor...`).setColor(0xFEE75C)}
function buildOfflineEmbed(e){return new EmbedBuilder().setTitle('Status').setDescription(`🌐 Último IP conhecido: ${formatEndpoint(e)}\n🔴 Status: OFFLINE`).setColor(0xED4245)}
function buildUnknownEmbed(s){return new EmbedBuilder().setTitle('Status').setDescription(`🌐 Último IP conhecido: ${formatEndpoint(s?.endpoint)}\n⚪ Status: NÃO FOI POSSÍVEL CONFIRMAR\n🔄 O bot continuará verificando sem marcar o servidor como offline.`).setColor(0x95A5A6)}
async function fetchStatus(){if(!DOMAIN)throw Error('ATERNOS_DOMAIN não definido');const s=await getServerStatus({domain:DOMAIN,lastEndpoint});const e=displayEndpoint(s);s.endpoint=e;return s}
async function send(client,embed){if(!CHANNEL)return;try{const ch=await client.channels.fetch(CHANNEL);if(!ch?.isTextBased())throw Error('Canal inválido');await ch.send({embeds:[embed]})}catch(e){console.error('❌ Discord status:',e.message)}}
async function announce(client,state,s){const embed=state===SERVER_STATE.ONLINE?buildOnlineEmbed(s):state===SERVER_STATE.STARTING?buildStartingEmbed(s):state===SERVER_STATE.OFFLINE?buildOfflineEmbed(s.endpoint):buildUnknownEmbed(s);await send(client,embed)}
function limit(s){return s===SERVER_STATE.STARTING?START_CONFIRM:CONFIRM}
async function checkServer(client,{announce=true}={}){
 if(checking)return null;checking=true;
 try{
  const s=await fetchStatus(),state=stateOf(s);
  if(state===SERVER_STATE.UNKNOWN){console.warn(`⚠️ Estado UNKNOWN (${s.stateReason||'unknown'}); estado confirmado preservado.`);return s;}
  if(lastConfirmedState===null){lastConfirmedState=state;if(announce&&state!==SERVER_STATE.OFFLINE)await announce(client,state,s);return s;}
  if(state===lastConfirmedState){pending=null;count=0;return s;}
  if(pending===state)count++;else{pending=state;count=1;}
  console.log(`⏳ Confirmação ${lastConfirmedState} → ${state}: ${count}/${limit(state)}`);
  if(count>=limit(state)){lastConfirmedState=state;pending=null;count=0;if(announce)await announce(client,state,s)}
  return s;
 }catch(e){console.error('❌ Monitor:',e.message);return null}finally{checking=false}
}
function startServerMonitor(client){if(timer||!DOMAIN)return;checkServer(client);timer=setInterval(()=>checkServer(client),INTERVAL);console.log(`🔎 Monitor Aternos reescrito: ${INTERVAL/1000}s`)}
async function getCurrentServerStatus(){return fetchStatus()}
module.exports={startServerMonitor,getCurrentServerStatus,formatEndpoint,buildOnlineEmbed,buildStartingEmbed,buildOfflineEmbed,buildUnknownEmbed};
