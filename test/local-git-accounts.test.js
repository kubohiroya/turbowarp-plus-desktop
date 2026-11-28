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

test('failed cleanup remains retryable but its account authority is removed immediately',async()=>{
  let fail=true,closes=0;
  const pool=createGitAccountPool({clientId:'test'},async()=>({getSession:()=>({}),disconnect:async()=>{},
    close:async()=>{closes++;if(fail)throw Error('close failed');}}));
  const id=await pool.create();await assert.rejects(pool.disconnect(id),/close failed/);
  await assert.rejects(pool.getSession(id),{code:'SESSION_REQUIRED'});
  fail=false;await pool.disconnect(id);assert.equal(closes,2);await pool.close();
});

test('shutdown attempts every slot and reports cleanup failure instead of reporting success',async()=>{
  let counter=0,fail=true;const stopped=[];
  const pool=createGitAccountPool({clientId:'test'},async()=>{const id=++counter;return {
    disconnect:async()=>{stopped.push(id);},close:async()=>{if(id===1&&fail)throw Error('offline');}};});
  const a=await pool.create(),b=await pool.create();await assert.rejects(pool.close(),{code:'STORAGE_FAILURE'});
  assert.deepEqual(stopped,[1,2]);await assert.rejects(pool.getSession(a),{code:'SESSION_REQUIRED'});
  await assert.rejects(pool.getSession(b),{code:'SESSION_REQUIRED'});fail=false;await pool.close();
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
    if(path==='/user')return Response.json({id:token.endsWith('_1')?1:2,login:token.endsWith('_1')?'alice':'bob'});
    if(path==='/repos/owner/repo')return Response.json({id:7,full_name:'owner/repo',permissions:{pull:true,push:true}});
    sent.push(token);return new Response('ok',{headers:{'Content-Type':path.endsWith('git-receive-pack')?
      'application/x-git-receive-pack-result':'application/x-git-upload-pack-advertisement'}});
  };
  const pool=createGitAccountPool({clientId:'Iv1_test',request,wait:async()=>{},confirmRepository:async()=>true});t.after(()=>pool.close());
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

test('sign-out aborts an in-flight upstream push and rejects reuse of its proxy credential',async t=>{
  let started,aborted=false;const ready=new Promise(resolve=>{started=resolve;});
  const request=async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/login/device/code')return Response.json({device_code:'device',user_code:'ABCD-EFGH',
      verification_uri:'https://github.com/login/device',expires_in:600,interval:1});
    if(path==='/login/oauth/access_token')return Response.json({access_token:'ghu_test',refresh_token:'ghr_test',expires_in:3600,refresh_token_expires_in:7200});
    if(path==='/user')return Response.json({id:1,login:'alice'});
    if(path==='/repos/owner/repo')return Response.json({id:7,full_name:'owner/repo',permissions:{pull:true,push:true}});
    started();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{
      aborted=true;reject(new DOMException('Aborted','AbortError'));
    },{once:true}));
  };
  const pool=createGitAccountPool({clientId:'Iv1_test',request,wait:async()=>{},confirmRepository:async()=>true});t.after(()=>pool.close());
  const id=await pool.create();await pool.begin(id);await pool.finish(id);
  const session=await pool.authorizeRepository(id,'https://github.com/owner/repo.git',true);
  const sending=fetch(session.connection.proxyOrigin+'/v1/git/owner/repo.git/git-receive-pack',{method:'POST',body:'x',
    headers:{Origin:EDITOR_ORIGIN,Authorization:'Bearer '+session.bearer,'Content-Type':'application/x-git-receive-pack-request','Git-Push-Id':randomUUID()}})
    .then(async response=>{await response.arrayBuffer();return response.status;},()=>null);
  await ready;await pool.disconnect(id);assert.equal(aborted,true);
  assert.notEqual(await sending,200);await assert.rejects(pool.getSession(id),{code:'SESSION_REQUIRED'});
});

test('write grants require host consent for the verified account and repository; actor changes and late approvals fail closed',async t=>{
  let actor={id:1,login:'alice'},allow=false,hold=false,enter,release;
  const approvals=[];const request=async(url)=>{
    const path=new URL(url).pathname;
    if(path==='/login/device/code')return Response.json({device_code:'device',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:600,interval:1});
    if(path==='/login/oauth/access_token')return Response.json({access_token:'ghu_test',refresh_token:'ghr_test',expires_in:3600,refresh_token_expires_in:7200});
    if(path==='/user')return Response.json(actor);
    if(path==='/repos/owner/repo')return Response.json({id:7,full_name:'owner/repo',permissions:{pull:true,push:true}});
    throw Error('unexpected upstream request');
  };
  const pool=createGitAccountPool({clientId:'Iv1_test',request,wait:async()=>{},confirmRepository:async(details)=>{
    approvals.push(details);if(hold){enter();await new Promise(resolve=>{release=resolve;});}return allow;
  }});t.after(()=>pool.close());
  const id=await pool.create();await pool.begin(id);await pool.finish(id);const remote='https://github.com/owner/repo.git';
  const read=await pool.authorizeRepository(id,remote,false);assert.equal(approvals.length,0);
  await assert.rejects(pool.authorizeRepository(id,remote,true),{code:'FORBIDDEN'});
  assert.deepEqual(approvals[0],{account:{id:1,login:'alice'},repository:{id:7,owner:'owner',repo:'repo'},write:true,review:false});
  assert.equal(Object.isFrozen(approvals[0]),true);assert.equal((await pool.getSession(id)).bearer,read.bearer);
  allow=true;actor={id:1,login:'renamed-alice'};
  const write=await pool.authorizeRepository(id,remote,true);assert.equal(write.account.id,1);assert.equal(write.account.login,'renamed-alice');
  actor={id:99,login:'alice'};await assert.rejects(pool.authorizeRepository(id,remote,true),{code:'REAUTH_REQUIRED'});
  assert.equal(approvals.length,2);assert.equal(await pool.getSession(id),null);
  actor={id:1,login:'alice'};await pool.begin(id);await pool.finish(id);
  hold=true;const started=new Promise(resolve=>{enter=resolve;});
  const pending=pool.authorizeRepository(id,remote,true);const rejected=assert.rejects(pending,error=>error.name==='AbortError'||error.code==='SESSION_EXPIRED');
  await started;await pool.disconnect(id);release();await rejected;
  await assert.rejects(pool.getSession(id),{code:'SESSION_REQUIRED'});
});

test('a pair host without a consent implementation cannot issue a write grant',async t=>{
  const request=async(url)=>{
    const path=new URL(url).pathname;
    if(path==='/login/device/code')return Response.json({device_code:'device',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:600,interval:1});
    if(path==='/login/oauth/access_token')return Response.json({access_token:'ghu_test',refresh_token:'ghr_test',expires_in:3600,refresh_token_expires_in:7200});
    return Response.json(path==='/user'?{id:1,login:'alice'}:{id:7,full_name:'owner/repo',permissions:{pull:true,push:true}});
  };
  const pool=createGitAccountPool({clientId:'Iv1_test',request,wait:async()=>{}});t.after(()=>pool.close());
  const id=await pool.create();await pool.begin(id);await pool.finish(id);
  await assert.rejects(pool.authorizeRepository(id,'https://github.com/owner/repo.git',true),{code:'FORBIDDEN'});
});
