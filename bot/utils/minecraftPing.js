const net=require('net');
const { SERVER_STATE }=require('./aternosClassifier');

function writeVarInt(v){const b=[];let n=v>>>0;do{let x=n&127;n>>>=7;if(n)x|=128;b.push(x);}while(n);return Buffer.from(b);}
function readVarInt(buf,off=0){let n=0,r=0;while(n<5){if(off+n>=buf.length)return null;const x=buf[off+n];r|=(x&127)<<(7*n);n++;if(!(x&128))return{value:r,size:n};}throw Error('VarInt inválido');}
function str(s){const b=Buffer.from(String(s),'utf8');return Buffer.concat([writeVarInt(b.length),b]);}
function packet(id,...parts){const body=Buffer.concat([writeVarInt(id),...parts]);return Buffer.concat([writeVarInt(body.length),body]);}
function connect(host,port,timeout){
 return new Promise((resolve,reject)=>{
  const s=net.createConnection({host,port});let done=false;
  const fail=e=>{if(done)return;done=true;s.destroy();reject(e)};
  s.setTimeout(timeout);s.once('connect',()=>{done=true;s.setTimeout(0);resolve(s)});
  s.once('timeout',()=>fail(Error('connect timeout')));s.once('error',fail);
 });
}
function readPacket(s,timeout){
 return new Promise((resolve,reject)=>{
  let buf=Buffer.alloc(0),done=false;
  const timer=setTimeout(()=>fail(Error('status timeout')),timeout);
  const clean=()=>{clearTimeout(timer);s.off('data',data);s.off('error',err);s.off('close',close)};
  const ok=v=>{if(done)return;done=true;clean();resolve(v)};
  const fail=e=>{if(done)return;done=true;clean();reject(e)};
  const parse=()=>{
   const l=readVarInt(buf);if(!l||buf.length<l.size+l.value)return;
   const p=buf.subarray(l.size,l.size+l.value);const id=readVarInt(p);
   if(!id)return;ok({id:id.value,payload:p.subarray(id.size)});
  };
  const data=c=>{buf=Buffer.concat([buf,c]);try{parse()}catch(e){fail(e)}};const err=e=>fail(e);const close=()=>fail(Error('connection closed'));
  s.on('data',data);s.on('error',err);s.on('close',close);
 });
}
function motd(v){
 if(typeof v==='string')return v;
 if(v?.text||Array.isArray(v?.extra))return `${v.text||''}${(v.extra||[]).map(x=>x?.text||'').join('')}`;
 return '';
}
function players(sample){return Array.isArray(sample)?sample.map(x=>x?.name).filter(x=>typeof x==='string'):[];}
async function queryJava({connectHost,port,handshakeHost,timeout=8000}){
 const started=Date.now(),s=await connect(connectHost,port,timeout);
 try{
  const p=packet(0,writeVarInt(-1),str(handshakeHost),Buffer.from([port>>8,port&255]),writeVarInt(1));
  s.write(p);s.write(packet(0));
  const r=await readPacket(s,timeout);
  if(r.id!==0)throw Error(`unexpected packet ${r.id}`);
  const l=readVarInt(r.payload);if(!l)throw Error('invalid status payload');
  const raw=JSON.parse(r.payload.subarray(l.size,l.size+l.value).toString('utf8'));
  return {raw,ping:Date.now()-started,version:raw.version||{},description:motd(raw.description),
    players:{online:Number.isFinite(raw.players?.online)?raw.players.online:0,max:Number.isFinite(raw.players?.max)?raw.players.max:0,sample:players(raw.players?.sample)}};
 }finally{s.end();}
}
module.exports={queryJava};
