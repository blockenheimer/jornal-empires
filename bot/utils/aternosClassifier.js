const SERVER_STATE={ONLINE:'online',STARTING:'starting',OFFLINE:'offline',UNKNOWN:'unknown'};
function norm(v){return String(v||'').replace(/§./g,'').replace(/\s+/g,' ').trim().toLowerCase();}
function classifyProxy(status){
 const text=`${norm(status?.description)} ${norm(status?.version?.name)}`;
 const start=['currently preparing','server is preparing','currently starting','server is starting','starting up','booting up','server is loading','preparing'];
 const stop=['currently stopping','server is stopping','stopping'];
 const off=['this server is offline','server is offline','server offline','currently offline'];
 if(start.some(x=>text.includes(x)))return {state:SERVER_STATE.STARTING,reason:'aternos-proxy-starting'};
 if(stop.some(x=>text.includes(x)))return {state:SERVER_STATE.OFFLINE,reason:'aternos-proxy-stopping'};
 if(off.some(x=>text.includes(x)))return {state:SERVER_STATE.OFFLINE,reason:'aternos-proxy-offline'};
 if(Number(status?.players?.max)===0)return {state:SERVER_STATE.OFFLINE,reason:'aternos-proxy-waiting'};
 return {state:SERVER_STATE.UNKNOWN,reason:'proxy-response-not-proven-backend'};
}
function classifyDirect(status){
 const proxy=classifyProxy(status);
 if(proxy.state!==SERVER_STATE.UNKNOWN)return proxy;
 const protocol=Number(status?.version?.protocol), max=Number(status?.players?.max);
 const version=norm(status?.version?.name), description=norm(status?.description);
 if(!Number.isInteger(protocol)||protocol<=0)return {state:SERVER_STATE.UNKNOWN,reason:'missing-minecraft-protocol'};
 if(!Number.isFinite(max)||max<=0)return {state:SERVER_STATE.UNKNOWN,reason:'invalid-player-capacity'};
 if(description.includes('aternos') && !description.includes('empires'))return {state:SERVER_STATE.UNKNOWN,reason:'generic-aternos-proxy-response'};
 if(version==='aternos' || version.includes('offline') || version.includes('starting') || version.includes('preparing'))return {state:SERVER_STATE.UNKNOWN,reason:'proxy-like-version'};
 return {state:SERVER_STATE.ONLINE,reason:'direct-dynip-minecraft-response'};
}
function stateOf(status){
 if(status?.state===SERVER_STATE.ONLINE)return SERVER_STATE.ONLINE;
 if(status?.state===SERVER_STATE.STARTING)return SERVER_STATE.STARTING;
 if(status?.state===SERVER_STATE.OFFLINE)return SERVER_STATE.OFFLINE;
 return SERVER_STATE.UNKNOWN;
}
module.exports={SERVER_STATE,classifyProxy,classifyDirect,stateOf};
