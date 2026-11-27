const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createGitAccountPool,installEditorGitAccounts}=require('../src-main/local-git/account-pool');
const {EDITOR_ORIGIN}=require('../src-main/local-git/git-proxy');
const {randomUUID}=require('node:crypto');
test('account services isolate credentials and disconnect only the selected slot',async()=>{
  const services=[];const pool=createGitAccountPool({clientId:'test',store:{secret:true}},async options=>{
    assert.equal(options.store,undefined);const state={closed:false,disconnected:false};services.push(state);
    return {begin:async remember=>{assert.equal(remember,false);return services.length;},finish:async()=>({}),
      createSession:async remote=>({remote,account:services.indexOf(state)}),getSession:()=>state,
      disconnect:async()=>{state.disconnected=true;},close:async()=>{state.closed=true;}};
  });
  const a=await pool.create(),b=await pool.create();assert.notEqual(a,b);
  await pool.begin(a);await pool.begin(b);await pool.disconnect(b);
  assert.equal((await pool.getSession(a)).closed,false);assert.equal(services[1].closed,true);
  await assert.rejects(pool.getSession(b),{code:'SESSION_REQUIRED'});await pool.close();assert.equal(services[0].closed,true);
});
test('untrusted frames cannot allocate or operate account slots',async()=>{
  const handlers=new Map(),events=new Map();
  const ipc={handle:(name,fn)=>handlers.set(name,fn),on:(name,fn)=>events.set(name,fn)};
  const web={on(){},once(){}};
  installEditorGitAccounts(ipc,web,{clientId:'test'},()=>false);
  const event={};events.get('pair-git-enabled')(event);assert.equal(event.returnValue,false);
  await assert.rejects(handlers.get('pair-git-create')({}),/GIT_UNAVAILABLE/);
});

test('two real loopback proxies send with their own GitHub credentials and survive the other account disconnecting',async t=>{
  let devices=0;const sent=[];
  const request=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/login/device/code')return Response.json({device_code:'device_'+(++devices),user_code:'ABCD-EFGH',
      verification_uri:'https://github.com/login/device',expires_in:600,interval:1});
    if(path==='/login/oauth/access_token')return Response.json({access_token:'ghu_'+options.body.get('device_code'),
      refresh_token:'ghr_test',expires_in:3600,refresh_token_expires_in:7200});
    const token=options.headers.Authorization;
    if(path==='/user')return Response.json({login:token.endsWith('_1')?'alice':'bob'});
    if(path==='/repos/owner/repo')return Response.json({id:7,full_name:'owner/repo',permissions:{pull:true,push:true}});
    sent.push(token);return new Response('ok',{headers:{'Content-Type':path.endsWith('git-receive-pack')?
      'application/x-git-receive-pack-result':'application/x-git-upload-pack-advertisement'}});
  };
  const pool=createGitAccountPool({clientId:'Iv1_test',request,wait:async()=>{}});t.after(()=>pool.close());
  const a=await pool.create(),b=await pool.create();
  await pool.begin(a);await pool.finish(a);await pool.begin(b);await pool.finish(b);
  const remote='https://github.com/owner/repo.git';
  const sa=await pool.authorizeRepository(a,remote,true),sb=await pool.authorizeRepository(b,remote,true);
  assert.notEqual(sa.connection.proxyOrigin,sb.connection.proxyOrigin);assert.equal(sa.account.login,'alice');assert.equal(sb.account.login,'bob');
  const read=async session=>fetch(session.connection.proxyOrigin+'/v1/git/owner/repo.git/info/refs?service=git-upload-pack',
    {headers:{Origin:EDITOR_ORIGIN,Authorization:'Bearer '+session.bearer}});
  const push=await fetch(sb.connection.proxyOrigin+'/v1/git/owner/repo.git/git-receive-pack',{method:'POST',body:'x',
    headers:{Origin:EDITOR_ORIGIN,Authorization:'Bearer '+sb.bearer,'Content-Type':'application/x-git-receive-pack-request','Git-Push-Id':randomUUID()}});
  assert.equal(push.status,200);await push.text();assert.equal(sent.at(-1),'Basic '+Buffer.from('x-access-token:ghu_device_2').toString('base64'));
  await pool.disconnect(b);const response=await read(sa);assert.equal(response.status,200);await response.text();
  assert.equal(sent.at(-1),'Basic '+Buffer.from('x-access-token:ghu_device_1').toString('base64'));
});
