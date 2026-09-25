const assert=require('assert');
const {SERVER_STATE,classifyProxy,classifyDirect}=require('../utils/aternosClassifier');
assert.equal(classifyProxy({description:'This server is offline',version:{name:'Offline'},players:{max:0}}).state,SERVER_STATE.OFFLINE);
assert.equal(classifyProxy({description:'This server is currently starting',version:{name:'Starting'},players:{max:0}}).state,SERVER_STATE.STARTING);
assert.equal(classifyProxy({description:'Waiting for server',version:{name:'Aternos'},players:{max:0}}).state,SERVER_STATE.OFFLINE);
assert.equal(classifyProxy({description:'Looks online',version:{name:'1.21.8',protocol:772},players:{online:0,max:20}}).state,SERVER_STATE.UNKNOWN);
assert.equal(classifyDirect({description:'Empires SMP',version:{name:'1.21.8',protocol:772},players:{online:0,max:20}}).state,SERVER_STATE.ONLINE);
assert.equal(classifyDirect({description:'Waiting for server',version:{name:'Aternos'},players:{online:0,max:0}}).state,SERVER_STATE.OFFLINE);
console.log('✅ Monitor Aternos strict tests passed.');
