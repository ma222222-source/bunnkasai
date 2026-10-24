const {test,expect,chromium,webkit,devices}=require('@playwright/test');
const {loadGas}=require('./gas-mock');const {mockGas,watchErrors}=require('./mock');
const fs=require('fs'),os=require('os'),path=require('path');
const SID='ABCD2345';
test('抽選履歴：圏外の再起動では前回の結果を残し、再確認後に最新の交換済みへ更新する',async({page,context})=>{
 const g=server(),log={};const ids=g.R8_BOOTHS.slice(0,7).map(b=>b[0]);g.__post({action:'ledger',cid:SID,ev:ids.map(id=>({t:'s',id}))});const win=g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt:1,ev:[]});
 await bridge(context,g,log);await context.addInitScript(sid=>{if(!localStorage.getItem('kuroko_sid'))localStorage.setItem('kuroko_sid',JSON.stringify(sid));},SID);await ready(page);await expect(page.locator('#rally-history li').first()).toContainText('未交換');
 log.offline=true;await context.addInitScript(()=>Object.defineProperty(navigator,'onLine',{value:false,configurable:true}));await page.reload();await page.waitForFunction(()=>window.__booted===true);await expect(page.locator('#rally-history li').first()).toContainText('超大当たり');await expect(page.locator('#rally-history-status')).toContainText('前回確認した結果');await expect(page.locator('#redeem-open')).toBeDisabled();
 g.__post({action:'rally_redeem',policy:g.RALLY_POLICY,cid:SID,ticket:win.rally.entries[0].ticket,code:g.rallyCode_(0)});log.offline=false;await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{value:true,configurable:true});renderRally();});await page.locator('#rally-refresh').click();await expect(page.locator('#rally-history li').first()).toContainText('交換済み');await expect(page.locator('#rally-history-status')).not.toContainText('前回確認した結果');
});
async function lineSdk(context,g){
 g.UrlFetchApp={fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({iss:'https://access.line.me',aud:'2010429448',sub:'U'+'a'.repeat(32),exp:Date.now()/1000+3600})})};
 await bridge(context,g);
 await context.route('https://static.line-scdn.net/liff/edge/2/sdk.js',r=>r.fulfill({contentType:'application/javascript',body:"window.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'test-id-token'}"}));
}
test('LINE連携：端末の保存が全てない新しいブラウザでも、同じLINEでスタンプと全抽選結果が戻る',async({page,context,browser})=>{
 const g=server(),ids=g.R8_BOOTHS.slice(0,21).map(b=>b[0]);g.__post({action:'ledger',cid:SID,ev:ids.map(id=>({t:'s',id}))});
 const first=g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt:1,ev:[]});g.__post({action:'rally_redeem',policy:g.RALLY_POLICY,cid:SID,ticket:first.rally.entries[0].ticket,code:g.rallyCode_(0)});
 g.Math.random=()=>.9;for(let attempt=2;attempt<=3;attempt++)g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt,ev:[]});
 await lineSdk(context,g);await page.goto('/line-stamp.html?from='+SID);await page.waitForFunction(()=>window.__booted===true&&S.stamps.size===21);
 const cid=await page.evaluate(()=>stampId());expect(cid).not.toBe(SID);await expect(page.locator('#rally-history li')).toHaveCount(6);await expect(page.locator('#rally-history li').nth(0)).toContainText('超大当たり');await expect(page.locator('#rally-history li').nth(0)).toContainText('交換済み');await expect(page.locator('#rally-history li').nth(1)).toContainText('はずれ');expect(await page.evaluate(()=>sessionStorage.getItem('kuroko_line_transfer'))).toBeNull();
 const fresh=await browser.newContext({serviceWorkers:'block'});try{await lineSdk(fresh,g);const next=await fresh.newPage();await next.goto('/line-stamp.html');await next.waitForFunction(()=>window.__booted===true&&S.stamps.size===21);expect(await next.evaluate(()=>stampId())).toBe(cid);await expect(next.locator('#rally-history li')).toHaveCount(6);await expect(next.locator('#rally-history li').nth(2)).toContainText('はずれ');await expect(next.locator('#rally-history li').nth(3)).toContainText('未抽選');expect(await next.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('test-id-token');}finally{await fresh.close();}
});
test('LINE連携：0個の初参加とセッション保存が使えない環境でも同じ番号へ復元する',async({page,context})=>{
 const g=server();await lineSdk(context,g);await context.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===sessionStorage&&k==='kuroko_line_transfer')throw Error('denied');return set.call(this,k,v);};});
 await page.goto('/line-stamp.html');await page.waitForFunction(()=>window.__booted===true&&S.booths.length===46);expect(await page.evaluate(()=>S.stamps.size)).toBe(0);expect(await page.evaluate(()=>loadStr('kuroko_line_sid'))).toBe(await page.evaluate(()=>stampId()));await expect(page.locator('#rally-history-status')).toContainText('まだ抽選していません');
});
test('抽選履歴：結果確認前に引かせず、取得後は未交換の当たり・全はずれ・全制覇を表示する',async({page,context})=>{
 const g=server(),ids=g.R8_BOOTHS.map(b=>b[0]);g.__post({action:'ledger',cid:SID,ev:ids.map(id=>({t:'s',id}))});g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt:1,ev:[]});g.Math.random=()=>.9;for(let attempt=2;attempt<=6;attempt++)g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt,ev:[]});g.__post({action:'rally_complete',cid:SID,ev:[]});
 await bridge(context,g);let release;const hold=new Promise(r=>release=r);await context.route(/script\.google(usercontent)?\.com\//,async r=>{if((r.request().method()==='GET'&&new URL(r.request().url()).searchParams.has('ledger'))||(r.request().method()==='POST'&&JSON.parse(r.request().postData()||'{}').action==='ledger'))await hold;return r.fallback();});
 await context.addInitScript(({sid,ids})=>{localStorage.setItem('kuroko_sid',JSON.stringify(sid));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(ids));},{sid:SID,ids});
 try{await ready(page);await expect(page.locator('#rally-draw')).toBeDisabled();await expect(page.locator('#rally-draw')).toContainText('結果を確認中');release();await expect(page.locator('#rally-history li')).toHaveCount(7);await expect(page.locator('#rally-history li').first()).toContainText('未交換');await expect(page.locator('#rally-history li').nth(5)).toContainText('はずれ');await expect(page.locator('#rally-history li').last()).toContainText('全制覇プリクラ');}finally{release();}
});
function server(){const g=loadGas({props:{ADMIN_PASS:'test-password-1234',OWNER_PASS:'owner-himitsu-123456'}});g.setupR8AndArchiveOthers();g.Math=Object.create(Math);g.Math.random=()=>0;return g;}
async function bridge(context,g,log={}){
 await context.route('**/*',r=>/^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)|blob:|data:|about:)/.test(r.request().url())?r.continue():r.abort());
 await context.route(/script\.google(usercontent)?\.com\//,r=>{const q=r.request(),post=q.method()==='POST';if(log.offline)return r.abort();if(post)(log.posts||(log.posts=[])).push(JSON.parse(q.postData()));
  const body=post?g.doPost({postData:{contents:q.postData()}}).getContent():g.doGet({parameter:Object.fromEntries(new URL(q.url()).searchParams)}).getContent();
  return r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body});});
}
async function ready(p,url='/?tab=stamp'){await p.goto(url);await expect.poll(()=>p.evaluate(()=>window.__booted===true&&S.booths.length),{timeout:15000}).toBe(46);}
async function offline(p,yes=true){await p.evaluate(yes=>Object.defineProperty(navigator,'onLine',{value:!yes,configurable:true}),yes);}
async function dbSaved(p){await expect.poll(()=>p.evaluate(async()=>({saved:await checkpointStamps(),db:!!STAMP_VAULT.db,queued:!!STAMP_VAULT.queued,stamps:S.stamps.size}))).toMatchObject({saved:true});}
async function delayVaultOpen(context){
 await context.addInitScript(()=>{
  const open=indexedDB.open.bind(indexedDB);window.__nativeVaultOpen=open;
  Object.defineProperty(indexedDB,'open',{configurable:true,value:(...args)=>{
   const request=open(...args);
   return new Proxy(request,{get(target,key){return Reflect.get(target,key,target);},set(target,key,value){
    if(key==='onsuccess'&&value){target.onsuccess=event=>setTimeout(()=>value.call(target,event),1800);return true;}
    return Reflect.set(target,key,value,target);
   }});
  }});
 });
}

test('遅いDB起動：画面の起動期限を過ぎても予備保存へ復帰し、通常保存が拒否された記録を再読込できる',async({page,context})=>{
 const g=server();await bridge(context,g);await delayVaultOpen(context);
 await context.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(k){if(this===localStorage)throw new Error('storage denied');return get.call(this,k);};Storage.prototype.setItem=function(k,v){if(this===localStorage)throw new Error('storage denied');return set.call(this,k,v);};});
 await ready(page);await offline(page);await page.evaluate(()=>earnStamp('1F-02'));await dbSaved(page);
 const sid=await page.evaluate(()=>stampId());await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&S.stamps.has('1F-02')),{timeout:10000}).toBe(true);
 expect(await page.evaluate(()=>stampId())).toBe(sid);
});

test('遅いDB起動：別の参加番号に切替後は、前の記録を混ぜず新しい番号を保存する',async({page,context})=>{
 await mockGas(context);await ready(page);await offline(page);await page.evaluate(()=>earnStamp('1F-02'));await dbSaved(page);
 const old=await page.evaluate(()=>stampId());await page.evaluate(()=>{localStorage.setItem('kuroko_sid',JSON.stringify('WXYZ6789'));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(['1F-03']));});
 await delayVaultOpen(context);await ready(page);await page.waitForTimeout(2200);
 expect(await page.evaluate(()=>({sid:stampId(),stamps:[...S.stamps]}))).toEqual({sid:'WXYZ6789',stamps:['1F-03']});
 const backup=await page.evaluate(()=>new Promise((resolve,reject)=>{const request=__nativeVaultOpen('kuroko-stamp-vault:/',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,get=db.transaction('backup','readonly').objectStore('backup').get('current');get.onsuccess=()=>{db.close();resolve(get.result);};get.onerror=()=>{db.close();reject(get.error);};};}));
 expect(backup.kuroko_sid).toBe('WXYZ6789');expect(backup.kuroko_stamps_v2).toEqual(['1F-03']);expect(backup.kuroko_sid).not.toBe(old);
});

test('遅いDB起動：容量不足で古い番号だけ通常保存に残っても、Cookieと控えの新番号へ戻る',async({page,context})=>{
 await mockGas(context);await ready(page);await offline(page);
 await page.evaluate(()=>{store('kuroko_sid','ABCD2345');earnStamp('1F-02');});await dbSaved(page);
 const cid=await page.evaluate(async()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='kuroko_sid')throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};earnStamp('1F-03');store('kuroko_sid','WXYZ6789');await checkpointStamps();return deviceId();});
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('kuroko_sid')))).toBe('ABCD2345');
 await delayVaultOpen(context);await ready(page);await expect.poll(()=>page.evaluate(()=>stampId()),{timeout:10000}).toBe('WXYZ6789');
 expect(await page.evaluate(()=>({cid:deviceId(),stamps:[...S.stamps].sort()}))).toEqual({cid,stamps:['1F-02','1F-03']});await dbSaved(page);
});

test('番号だけ残った0個でも台帳から自動復元し、来場者自身が引くまで抽選しない',async({page,context})=>{
 const g=server(),log={posts:[]};const ids=g.R8_BOOTHS.slice(0,14).map(b=>b[0]);g.__post({action:'ledger',cid:SID,ev:ids.map(id=>({t:'s',id}))});await bridge(context,g,log);
 await context.addInitScript(sid=>{localStorage.setItem('kuroko_sid',JSON.stringify(sid));},SID);await ready(page);
 await expect.poll(()=>page.evaluate(()=>S.stamps.size)).toBe(14);await expect(page.locator('#rally-draw')).toBeEnabled();expect(log.posts.filter(p=>p.action==='rally_draw')).toEqual([]);
 await page.locator('#rally-draw').click();await expect.poll(()=>g.rallyStock_(true).issued).toBe(1);await expect(page.locator('#rally-draw')).toBeEnabled();
 await page.locator('#rally-draw').click();await expect.poll(()=>g.rallyStock_(true).issued).toBe(2);await expect(page.locator('#rally-draw')).toBeDisabled();
 await page.evaluate(()=>drawRally());expect(g.rallyStock_(true).issued).toBe(2);
});

test('ローカル保存が消えてもIndexedDBから未送信・交換済み・時刻・番号を戻す',async({page,context})=>{
 const g=server(),log={offline:false};await bridge(context,g,log);await ready(page);await offline(page);log.offline=true;
 const before=await page.evaluate(async()=>{earnStamp('1F-02');earnStamp('1F-03');S.spent=['1F-02'];store('kuroko_spent_v1',S.spent);await checkpointStamps();return {sid:stampId(),at:stampAt()};});
 await page.evaluate(()=>{localStorage.clear();document.cookie='kuroko_sid_backup=; Path=/; Max-Age=0';});
 await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&S.stamps.size)).toBe(2);
 expect(await page.evaluate(()=>({sid:stampId(),spent:S.spent,at:stampAt()}))).toEqual({sid:before.sid,spent:['1F-02'],at:before.at});
});

test('Cookieに残った番号から台帳の当たり券・交換済み・全制覇の枠も戻す',async({page,context})=>{
 const g=server();await bridge(context,g);const ids=g.R8_BOOTHS.map(b=>b[0]);g.__post({action:'rally_draw',policy:g.RALLY_POLICY,cid:SID,attempt:1,ev:ids.map(id=>({t:'s',id}))});g.__post({action:'rally_complete',cid:SID,ev:ids.map(id=>({t:'s',id}))});
 await context.addCookies([{name:'kuroko_sid_backup',value:SID,url:'http://127.0.0.1:8732/'}]);await ready(page);
 await expect.poll(()=>page.evaluate(()=>S.stamps.size)).toBe(46);await expect(page.locator('#rally-result')).toContainText('お菓子1個を確保');await expect(page.locator('#rally-save')).toBeVisible();expect(await page.evaluate(()=>stampId())).toBe(SID);
});

test('localStorageが拒否されても別の保存方式へ残して再読込できる',async({page,context})=>{
 const g=server();await bridge(context,g);await context.addInitScript(()=>{const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(k){if(this===localStorage)throw new Error('storage denied');return get.call(this,k);};Storage.prototype.setItem=function(k,v){if(this===localStorage)throw new Error('storage denied');return set.call(this,k,v);};});
 await ready(page);await page.evaluate(()=>earnStamp('1F-02'));await dbSaved(page);const sid=await page.evaluate(()=>stampId());await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&S.stamps.size)).toBe(1);expect(await page.evaluate(()=>stampId())).toBe(sid);
});

test('両方の端末保存が拒否されても起動し、保存済みとは表示しない',async({page,context})=>{
 await mockGas(context);await context.addInitScript(()=>{Object.defineProperty(window,'indexedDB',{value:{open(){throw new Error('DB denied');}}});Object.defineProperty(navigator,'onLine',{value:false});const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage)throw new Error('LS denied');return set.call(this,k,v);};});
 await page.goto('/?tab=stamp');await page.waitForFunction(()=>window.__booted===true);await page.evaluate(()=>earnStamp('1F-02'));await expect(page.locator('#sid-sync')).toContainText('端末への保存を確認できません');await expect(page.locator('#sid-sync')).not.toContainText('保存済み');
});

test('オフラインの復元ファイルを保存し、空のブラウザへ読み込んでも記録が戻る。不正ファイルは変更しない',async({page,context,browser})=>{
 const g=server(),log={};await bridge(context,g,log);await ready(page);await offline(page);log.offline=true;
 await page.evaluate(()=>{earnStamp('1F-02');earnStamp('1F-03');S.spent=['1F-02'];store('kuroko_spent_v1',S.spent);Object.defineProperty(navigator,'canShare',{value:()=>false,configurable:true});});
 const event=page.waitForEvent('download');await page.locator('#sid-save').click();const d=await event,bytes=fs.readFileSync(await d.path()),data=JSON.parse(bytes);expect(data.stamps).toEqual(['1F-02','1F-03']);expect(data.spent).toEqual(['1F-02']);expect(data).not.toHaveProperty('password');expect(data).not.toHaveProperty('kuroko_cid');
 const fresh=await browser.newContext({serviceWorkers:'block'});try{const next=await fresh.newPage();await bridge(fresh,g,{offline:true});await next.goto('/?tab=stamp');await next.waitForFunction(()=>window.__booted===true);await offline(next);
  await next.locator('#sid-join-box summary').click();await next.locator('#sid-file').setInputFiles({name:d.suggestedFilename(),mimeType:'application/json',buffer:bytes});await expect(next.locator('#sid-file-status')).toContainText('スタンプ2個を戻しました');expect(await next.evaluate(()=>({sid:stampId(),stamps:[...S.stamps],spent:S.spent}))).toEqual({sid:data.sid,stamps:data.stamps,spent:data.spent});
  await next.locator('#sid-join-box summary').click();await next.locator('#sid-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"format":"wrong"}')});await expect(next.locator('#sid-file-status')).toContainText('復元用ファイルではありません');expect(await next.evaluate(()=>S.stamps.size)).toBe(2);
 }finally{await fresh.close();}
});

test('2つのタブの後発保存がIndexedDBのスタンプを減らさず、係員の明示リセットは復活させない',async({page,context})=>{
 await mockGas(context);await ready(page);const b=await context.newPage();await ready(b);await page.evaluate(()=>earnStamp('1F-02'));await b.evaluate(()=>earnStamp('1F-03'));await dbSaved(page);await dbSaved(b);
 await page.evaluate(()=>localStorage.removeItem('kuroko_stamps_v2'));await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&S.stamps.size)).toBe(2);await b.close();
 const old=await page.evaluate(()=>{S.isAdmin=true;return stampId();});page.once('dialog',d=>d.accept());await page.locator('#stamp-reset').evaluate(b=>b.classList.remove('hide'));await page.locator('#stamp-reset').click();await dbSaved(page);await page.reload();await page.waitForFunction(()=>window.__booted===true);expect(await page.evaluate(()=>S.stamps.size)).toBe(0);expect(await page.evaluate(()=>stampId())).not.toBe(old);
});

test('ブラウザを終了し同じプロファイルで再起動してもスタンプと番号が残る',async({baseURL},info)=>{
 test.setTimeout(60000);const engine=info.project.name==='iphone'?webkit:chromium,device=info.project.name==='iphone'?devices['iPhone 13']:info.project.name==='android'?devices['Pixel 7']:{viewport:{width:1280,height:900}};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kuroko-v246-'));const g=server();let c;
 try{c=await engine.launchPersistentContext(dir,{...device,serviceWorkers:'block',locale:'ja-JP'});await bridge(c,g);let p=c.pages()[0]||await c.newPage();await ready(p,baseURL+'/?tab=stamp');const errors=watchErrors(p);await p.evaluate(()=>{earnStamp('1F-02');earnStamp('1F-03');});await dbSaved(p);const sid=await p.evaluate(()=>stampId());await c.close();c=null;
  c=await engine.launchPersistentContext(dir,{...device,serviceWorkers:'block',locale:'ja-JP'});await bridge(c,g);p=c.pages()[0]||await c.newPage();await ready(p,baseURL+'/?tab=stamp');expect(await p.evaluate(()=>({sid:stampId(),n:S.stamps.size}))).toEqual({sid,n:2});expect(errors).toEqual([]);
 }finally{if(c)await c.close();}
});


test('IndexedDBが応答しなくても起動を止めない',async({page,context})=>{
 await mockGas(context);await context.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:{open(){return {};}}}));await ready(page);expect(await page.evaluate(()=>window.__booted)).toBe(true);await page.evaluate(()=>earnStamp('1F-02'));expect(await page.evaluate(()=>S.stamps.size)).toBe(1);
});

test('保存のタイムアウト後の返事と終了済みのDBでも例外を出さず、次の保存で回復する',async({page,context})=>{
 await mockGas(context);await ready(page);await offline(page);const errors=watchErrors(page);
 await page.evaluate(()=>earnStamp('1F-02'));await dbSaved(page);
 for(const mode of ['late','inactive']){
  const result=await page.evaluate(async mode=>{
   await checkpointStamps();const real=STAMP_VAULT.db;let puts=0;
   STAMP_VAULT.db={transaction(){const tx={abort(){},objectStore(){return {get(){const request={result:{}};setTimeout(()=>{if(request.onsuccess)request.onsuccess();},mode==='late'?1600:0);return request;},put(){puts++;throw new DOMException('The transaction is inactive or finished.','TransactionInactiveError');}};}};return tx;}};
   STAMP_VAULT.queued=null;const saved=await checkpointStamps();await new Promise(r=>setTimeout(r,1800));
   STAMP_VAULT.db=real;STAMP_VAULT.queued=null;const recovered=await checkpointStamps();
   return {saved,recovered,puts,stamps:[...S.stamps]};
  },mode);
  expect(result.saved).toBe(false);expect(result.recovered).toBe(true);expect(result.puts).toBe(mode==='late'?0:1);expect(result.stamps).toContain('1F-02');
 }
 expect(errors).toEqual([]);await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&S.stamps.has('1F-02'))).toBe(true);
});

test('別番号の新しい記録に、古い番号のIndexedDB控えを混ぜない',async({page,context})=>{
 await mockGas(context);await ready(page);await page.evaluate(()=>earnStamp('1F-02'));await dbSaved(page);
 await page.evaluate(()=>{localStorage.setItem('kuroko_sid',JSON.stringify('WXYZ6789'));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(['1F-03']));});
 await page.reload();await expect.poll(()=>page.evaluate(()=>window.__booted===true&&stampId())).toBe('WXYZ6789');expect(await page.evaluate(()=>[...S.stamps])).toEqual(['1F-03']);
});


test('LINE入口：保存前に移動せず番号つきで引き継ぐ。空の通常ブラウザでも同じ7個に戻る',async({page,context,browser})=>{
 const g=server(),log={posts:[]};await bridge(context,g,log);const ids=g.R8_BOOTHS.slice(0,7).map(b=>b[0]);
 await context.addInitScript(({ids,sid})=>{Object.defineProperty(navigator,'userAgent',{value:navigator.userAgent+' Line/15.0.0'});localStorage.setItem('kuroko_sid',JSON.stringify(sid));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(ids));},{ids,sid:SID});
 await ready(page);await expect(page.locator('#line-entry')).toBeVisible();expect(new URL(page.url()).searchParams.has('openExternalBrowser')).toBe(false);
 await expect(page.locator('#line-continue')).toBeVisible({timeout:15000});const href=await page.locator('#line-continue').getAttribute('href'),u=new URL(href);expect(u.searchParams.get('restore')).toBe(SID);expect(u.searchParams.get('openExternalBrowser')).toBe('1');expect(g.__get({ledger:SID}).stamps.length).toBe(7);
 const nextCtx=await browser.newContext({serviceWorkers:'block'});try{await bridge(nextCtx,g);const next=await nextCtx.newPage();await next.goto(href);await expect.poll(()=>next.evaluate(()=>window.__booted===true&&S.stamps.size)).toBe(7);expect(await next.evaluate(()=>stampId())).toBe(SID);await expect(next.locator('#line-entry')).toBeHidden();}finally{await nextCtx.close();}
});

test('LINE入口：ブースQRを先に付け、通信できない間は外部への引き継ぎを有効にしない',async({page,context})=>{
 const g=server(),log={offline:true};await bridge(context,g,log);await context.addInitScript(()=>Object.defineProperty(navigator,'userAgent',{value:navigator.userAgent+' Line/15.0.0'}));
 const sig=require('./fixtures/sigs.json')['1F-02'];await page.goto('/?booth=1F-02&qr=1&k='+sig);await page.waitForFunction(()=>window.__booted===true);await expect.poll(()=>page.evaluate(()=>S.stamps.has('1F-02'))).toBe(true);
 await expect(page.locator('#line-continue')).toBeHidden();await expect(page.locator('#line-prepare')).toBeVisible();expect(await page.locator('#line-continue').getAttribute('href')).toBeNull();
});

test('LINE入口：番号だけ残り復元待ちの0個でも、先に通常ブラウザへ同じ番号を渡す',async({page,context,browser})=>{
 const g=server();const ids=g.R8_BOOTHS.slice(0,7).map(b=>b[0]);g.__post({action:'ledger',cid:SID,ev:ids.map(id=>({t:'s',id}))});await bridge(context,g);
 let release;const hold=new Promise(r=>release=r);
 await context.route(/script\.google(usercontent)?\.com\//,async r=>{if(r.request().method()==='GET'&&new URL(r.request().url()).searchParams.has('ledger'))await hold;return r.fallback();});
 await context.addInitScript(sid=>{Object.defineProperty(navigator,'userAgent',{value:navigator.userAgent+' Line/15.0.0'});localStorage.setItem('kuroko_sid',JSON.stringify(sid));},SID);
 let nextCtx;
 try{
  await ready(page);expect(await page.evaluate(()=>S.stamps.size)).toBe(0);await expect(page.locator('#line-continue')).toBeVisible();
  const href=await page.locator('#line-continue').getAttribute('href');expect(new URL(href).searchParams.get('restore')).toBe(SID);
  nextCtx=await browser.newContext({serviceWorkers:'block'});await bridge(nextCtx,g);const next=await nextCtx.newPage();await next.goto(href);
  await expect.poll(()=>next.evaluate(()=>window.__booted===true&&S.stamps.size)).toBe(7);expect(await next.evaluate(()=>stampId())).toBe(SID);
 }finally{release();if(nextCtx)await nextCtx.close();}
});


test('容量不足で古い値が読めるままでも、新しいスタンプと番号を控えから復元する',async({page,context})=>{
 const g=server(),log={};await bridge(context,g,log);
 await context.addInitScript(()=>{if(sessionStorage.getItem('__quota246'))return;sessionStorage.setItem('__quota246','1');localStorage.setItem('kuroko_sid',JSON.stringify('ABCD2345'));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(['1F-02']));});
 await ready(page);await offline(page);log.offline=true;
 const mid=await page.evaluate(async()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k.startsWith('kuroko_'))throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};earnStamp('1F-03');store('kuroko_sid','WXYZ6789');const saved=await checkpointStamps();return {saved,sid:stampId(),disk:JSON.parse(localStorage.getItem('kuroko_sid')),n:STAMP_VAULT.committed.kuroko_stamps_v2.length};});
 expect(mid).toEqual({saved:true,sid:'WXYZ6789',disk:'ABCD2345',n:2});
 log.offline=false;await page.reload();await page.waitForFunction(()=>window.__booted===true&&S.booths.length===46);expect(await page.evaluate(()=>({sid:stampId(),n:S.stamps.size}))).toEqual({sid:'WXYZ6789',n:2});
});
