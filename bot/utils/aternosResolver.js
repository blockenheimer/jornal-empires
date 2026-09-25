const dns = require('dns').promises;
const dnsNative = require('dns');
const net = require('net');
const https = require('https');

const DEFAULT_TIMEOUT = Math.max(1000, Number(process.env.SERVER_DNS_HTTP_TIMEOUT_MS || 5000));
const DNS_SERVERS = String(process.env.SERVER_DNS_SERVERS || '1.1.1.1,8.8.8.8')
  .split(',').map(s => s.trim()).filter(Boolean);
const USE_MCSTATUS = String(process.env.SERVER_MCSTATUS_FALLBACK || 'true').toLowerCase() !== 'false';
const DOH = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', ips: ['1.1.1.1','1.0.0.1'] },
  { name: 'google', url: 'https://dns.google/resolve', ips: ['8.8.8.8','8.8.4.4'] }
];

function cleanHost(value) {
  return String(value || '').trim().replace(/\.$/, '');
}
function isAternosDynHost(host) {
  const h = cleanHost(host).toLowerCase();
  return h.endsWith('.aternos.host');
}
function isValidEndpoint(e) {
  return !!e && isAternosDynHost(e.host || e.publicHost) &&
    Number.isInteger(Number(e.port)) && Number(e.port) > 0 && Number(e.port) <= 65535;
}
function normalizeEndpoint(e, source='srv') {
  if (!isValidEndpoint(e)) return null;
  const host = cleanHost(e.host || e.publicHost);
  return { host, publicHost: host, port: Number(e.port), source };
}
function key(e) { return `${e.host.toLowerCase()}:${e.port}`; }

function requestJson(url, timeout=DEFAULT_TIMEOUT) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{accept:'application/dns-json'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',c=>body+=c);
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch(e){ reject(new Error(`JSON inválido: ${e.message}`)); }
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('DNS HTTP timeout')));
    req.on('error',reject);
  });
}
function requestJsonByIp(urlString, ip, timeout=DEFAULT_TIMEOUT) {
  const u=new URL(urlString);
  return new Promise((resolve,reject)=>{
    const req=https.request({
      protocol:u.protocol, hostname:ip, port:443,
      path:u.pathname+u.search, method:'GET', servername:u.hostname,
      headers:{host:u.hostname,accept:'application/dns-json'},
      family:4, timeout, rejectUnauthorized:true
    },res=>{
      let body=''; res.setEncoding('utf8'); res.on('data',c=>body+=c);
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch(e){ reject(e); }
      });
    });
    req.on('timeout',()=>req.destroy(new Error('DNS HTTP timeout')));
    req.on('error',reject); req.end();
  });
}
function parseSrv(data) {
  if(typeof data!=='string') return null;
  const p=data.trim().replace(/\.$/,'').split(/\s+/);
  if(p.length<4) return null;
  const priority=Number(p[0]), weight=Number(p[1]), port=Number(p[2]), host=cleanHost(p.slice(3).join(''));
  if(!Number.isInteger(priority)||!Number.isInteger(weight)||!Number.isInteger(port)||port<1||port>65535||!host) return null;
  return {priority,weight,port,host};
}
async function dohSrv(domain, provider) {
  const name=encodeURIComponent(`_minecraft._tcp.${domain}`);
  const url=`${provider.url}?name=${name}&type=SRV&cd=1`;
  for(const ip of provider.ips){
    try {
      const d=await requestJsonByIp(url,ip);
      return (d.Answer||[]).map(x=>parseSrv(x.data)).filter(Boolean).map(x=>({...x,source:`doh-${provider.name}`}));
    } catch(_){}
  }
  try {
    const d=await requestJson(url);
    return (d.Answer||[]).map(x=>parseSrv(x.data)).filter(Boolean).map(x=>({...x,source:`doh-${provider.name}-hostname`}));
  } catch(e){ throw new Error(`${provider.name}: ${e.message}`); }
}
async function mcstatusSrv(domain) {
  const url=`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(domain)}?query=false&timeout=4`;
  const d=await requestJson(url,4000);
  const s=d?.srv_record;
  if(!s?.host || !Number.isInteger(Number(s.port))) throw new Error('mcstatus não retornou SRV');
  return [{host:cleanHost(s.host),port:Number(s.port),priority:0,weight:0,source:'mcstatus-discovery'}];
}
async function resolveSrv(domain) {
  const clean=cleanHost(domain);
  if(!clean) throw new Error('ATERNOS_DOMAIN não configurado');
  const records=[], errors=[];
  try { records.push(...(await dns.resolveSrv(`_minecraft._tcp.${clean}`)).map(x=>({...x,host:cleanHost(x.name),source:'system'}))); }
  catch(e){ errors.push(`system: ${e.message}`); }
  try {
    const r=new dnsNative.promises.Resolver(); r.setServers(DNS_SERVERS);
    records.push(...(await r.resolveSrv(`_minecraft._tcp.${clean}`)).map(x=>({...x,host:cleanHost(x.name),source:'dedicated'})));
  } catch(e){ errors.push(`dedicated: ${e.message}`); }
  for(const provider of DOH){
    try { records.push(...await dohSrv(clean,provider)); }
    catch(e){ errors.push(e.message); }
  }
  if(!records.length && USE_MCSTATUS){
    try { records.push(...await mcstatusSrv(clean)); }
    catch(e){ errors.push(`mcstatus: ${e.message}`); }
  }
  const map=new Map();
  for(const r of records){
    const e=normalizeEndpoint(r,r.source);
    if(!e) continue;
    const old=map.get(key(e));
    if(!old || Number(r.priority||0)<Number(old.priority||0)) map.set(key(e),{...e,priority:Number(r.priority||0),weight:Number(r.weight||0)});
  }
  return { endpoints:[...map.values()].sort((a,b)=>a.priority-b.priority || b.weight-a.weight), errors };
}
async function resolveAddresses(host) {
  const h=cleanHost(host), out=[], seen=new Set();
  const add=(address,source)=>{
    const a=String(address||'').replace(/^\[|\]$/g,'');
    if(net.isIP(a)&&!seen.has(a)){seen.add(a);out.push({address:a,source});}
  };
  if(net.isIP(h)){add(h,'literal');return out;}
  for(const [fn,label] of [[dns.resolve4,'system-a'],[dns.resolve6,'system-aaaa']]){
    try { for(const a of await fn(h)) add(a,label); } catch(_){}
  }
  try {
    const r=new dnsNative.promises.Resolver(); r.setServers(DNS_SERVERS);
    for(const [fn,label] of [[r.resolve4.bind(r),'dedicated-a'],[r.resolve6.bind(r),'dedicated-aaaa']]){
      try { for(const a of await fn(h)) add(a,label); } catch(_){}
    }
  } catch(_){}
  for(const provider of DOH){
    for(const type of ['A','AAAA']){
      try {
        const u=`${provider.url}?name=${encodeURIComponent(h)}&type=${type}`;
        let data=null;
        for(const ip of provider.ips){ try{data=await requestJsonByIp(u,ip);break;}catch(_){} }
        if(!data) data=await requestJson(u);
        for(const a of data.Answer||[]) add(a.data,`doh-${provider.name}-${type}`);
      } catch(_){}
    }
  }
  return out;
}
module.exports={cleanHost,isAternosDynHost,isValidEndpoint,normalizeEndpoint,resolveSrv,resolveAddresses};
