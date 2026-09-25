const {resolveSrv,resolveAddresses,isValidEndpoint,normalizeEndpoint}=require('./aternosResolver');
const {queryJava}=require('./minecraftPing');
const {SERVER_STATE,classifyProxy,classifyDirect,stateOf}=require('./aternosClassifier');

const TIMEOUT=Math.max(1000,Number(process.env.SERVER_QUERY_TIMEOUT_MS||8000));
const ATTEMPTS=Math.max(1,Number(process.env.SERVER_QUERY_ATTEMPTS||2));
const RETRY=Math.max(100,Number(process.env.SERVER_QUERY_RETRY_DELAY_MS||750));
const MAX_ENDPOINTS=Math.max(1,Number(process.env.SERVER_MAX_ENDPOINTS||3));
const MAX_ADDR=Math.max(1,Number(process.env.SERVER_MAX_ADDRESSES_PER_ENDPOINT||3));
const BUDGET=Math.max(3000,Number(process.env.SERVER_STATUS_CHECK_BUDGET_MS||12000));
const DEBUG=String(process.env.SERVER_STATUS_DEBUG||'true').toLowerCase()!=='false';
const PROXY_PORT=Math.max(1,Math.min(65535,Number(process.env.SERVER_PROXY_PORT||25565)));

function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function diagnostic(endpoint,target,result,error){
 return {endpoint:`${endpoint.host}:${endpoint.port}`,source:endpoint.source,connectHost:target,
   state:result?.state||SERVER_STATE.UNKNOWN,reason:result?.reason||null,ping:result?.ping??null,
   version:result?.version?.name||null,players:result?.players?`${result.players.online}/${result.players.max}`:null,error:error?.message||null};
}
async function directProbe(endpoint,domain,deadline){
 let addresses=[];
 try{addresses=await resolveAddresses(endpoint.host);}catch(_){}
 const targets=[...addresses.map(x=>x.address),endpoint.host].filter((x,i,a)=>a.indexOf(x)===i).slice(0,MAX_ADDR+1);
 const diagnostics=[];
 let last=null;
 for(const target of targets){
  for(let attempt=1;attempt<=ATTEMPTS;attempt++){
   const left=deadline-Date.now();if(left<500)break;
   try{
    const q=await queryJava({connectHost:target,port:endpoint.port,handshakeHost:domain,timeout:Math.min(TIMEOUT,left)});
    const c=classifyDirect(q.raw);
    const result={...q,state:c.state,stateReason:c.reason,online:c.state===SERVER_STATE.ONLINE,
      connectHost:target,handshakeHost:domain,edition:'java'};
    diagnostics.push(diagnostic(endpoint,target,result));
    if(result.state===SERVER_STATE.ONLINE)return{...result,endpoint,diagnostics,proof:'direct-dynip'};
    last=result;break;
   }catch(e){
    diagnostics.push(diagnostic(endpoint,target,null,e));
    if(attempt<ATTEMPTS && deadline-Date.now()>RETRY)await delay(Math.min(RETRY,deadline-Date.now()));
   }
  }
 }
 if(last)return{...last,endpoint,diagnostics};
 const e=Error(`DynIP não respondeu: ${endpoint.host}:${endpoint.port}`);e.diagnostics=diagnostics;throw e;
}
async function proxyProbe(domain,deadline){
 if(deadline-Date.now()<500)return{state:SERVER_STATE.UNKNOWN,stateReason:'budget-exhausted',online:false,endpoint:{host:domain,port:PROXY_PORT,source:'aternos-main-proxy',internal:true}};
 const endpoint={host:domain,port:PROXY_PORT,source:'aternos-main-proxy',internal:true};
 try{
  const q=await queryJava({connectHost:domain,port:PROXY_PORT,handshakeHost:domain,timeout:Math.min(TIMEOUT,deadline-Date.now())});
  const c=classifyProxy(q.raw);
  return {...q,state:c.state,stateReason:c.reason,online:false,endpoint,proof:'proxy-only'};
 }catch(e){return{state:SERVER_STATE.UNKNOWN,stateReason:'proxy-unreachable',online:false,endpoint,error:e};}
}
async function getServerStatus({domain,lastEndpoint=null}){
 const clean=String(domain||'').trim().replace(/\.$/,'');
 const started=Date.now(),diagnostics=[],resolutionErrors=[];
 let srv=[];
 try{const r=await resolveSrv(clean);srv=r.endpoints.slice(0,MAX_ENDPOINTS);resolutionErrors.push(...r.errors);}
 catch(e){resolutionErrors.push(e.message);}
 const last=normalizeEndpoint(lastEndpoint,'last-known');
 const candidates=[...srv];
 if(last && !candidates.some(x=>x.host===last.host&&x.port===last.port))candidates.push(last);
 if(DEBUG)console.log(`🧭 Aternos DynIP candidates: ${candidates.map(x=>`${x.host}:${x.port}`).join(', ')||'none'}`);
 const onlineResults=[];
 const directResults=[];
 const deadline=started+BUDGET;
 for(const e of candidates){
  if(Date.now()>=deadline)break;
  try{
   const r=await directProbe(e,clean,deadline);
   directResults.push(r);if(r.diagnostics)diagnostics.push(...r.diagnostics);
   if(r.state===SERVER_STATE.ONLINE){
    return {...r,endpoint:e,diagnostics,resolutionDetails:resolutionErrors};
   }
  }catch(e2){if(e2.diagnostics)diagnostics.push(...e2.diagnostics);}
 }
 // The main Aternos proxy is intentionally incapable of declaring ONLINE.
 // It can only explain STARTING/OFFLINE; everything else is UNKNOWN.
 const proxy=await proxyProbe(clean,deadline);
 if(proxy.state===SERVER_STATE.STARTING || proxy.state===SERVER_STATE.OFFLINE){
  return {...proxy,endpoint:last,displayEndpoint:last,diagnostics,resolutionDetails:resolutionErrors};
 }
 if(DEBUG && proxy.error)console.log(`⚠️ Proxy: ${proxy.error.message}`);
 return {state:SERVER_STATE.UNKNOWN,online:false,stateReason:
   directResults.length?'dynip-responded-but-not-confirmed':'no-confirmed-dynip',
   endpoint:last,displayEndpoint:last,ping:null,diagnostics,resolutionDetails:resolutionErrors,error:proxy.error||new Error('Estado não confirmado')};
}
module.exports={SERVER_STATE,stateOf,isValidTemporaryEndpoint:isValidEndpoint,sanitizeEndpoint:(e,s)=>normalizeEndpoint(e,s),
 getServerStatus,resolveMinecraftEndpoint:async d=>(await resolveSrv(d)).endpoints[0]||null,
 resolveMinecraftEndpoints:async d=>(await resolveSrv(d)).endpoints,
 resolveMinecraftEndpointRecords:resolveSrv,queryMinecraftServer:async(h,p,t,hh=h)=>queryJava({connectHost:h,port:p,timeout:t,handshakeHost:hh})};
