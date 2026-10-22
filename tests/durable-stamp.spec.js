const {test,expect,chromium,webkit,devices}=require('@playwright/test');
const {loadGas}=require('./gas-mock');const {mockGas,watchErrors}=require('./mock');
const fs=require('fs'),os=require('os'),path=require('path');
const SID='ABCD2345';
function server(){const g=loadGas({props:{ADMIN_PASS:'test-password-1234',OWNER_PASS:'owner-himitsu-123456'}});g.setupR8AndArchiveOthers();g.Math=Object.create(Math);g.Math.random=()=>0;return g;}
async function bridge(context,g,log={}){
 await context.route('**/*',r=>/^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)|blob:|data:|about:)/.test(r.request().url())?r.continue():r.abort());
 await context.route(/script\.google(usercontent)?\.com\//,r=>{const q=r.request(),post=q.method()==='POST';if(log.offline)return r.abort();if(post)(log.posts||(log.posts=[])).push(JSON.parse(q.postData()));
  const body=post?g.doPost({postData:{contents:q.postData()}}).getContent():g.doGet({parameter:Object.fromEntries(new URL(q.url()).searchParams)}).getContent();
  return r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body});});
}
async function ready(p,url='/?tab=stamp'){await p.goto(url);await expect.poll(()=>p.evaluate(()=>window.__booted===true&&S.booths.length),{timeout:15000}).toBe(46);}
async function offline(p,yes=true){await p.evaluate(yes=>Object.defineProperty(navigator,'onLine',{value:!yes,configurable:true}),yes);}
async function dbSaved(p){await expect.poll(()=>p.evaluate(()=>checkpointStamps())).toBe(true);}

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
 const g=server();await bridge(context,g);const ids=g.R8_BOOTHS.map(b=>b[0]);g.__post({action:'rally_draw',cid:SID,attempt:1,ev:ids.map(id=>({t:'s',id}))});g.__post({action:'rally_complete',cid:SID,ev:ids.map(id=>({t:'s',id}))});
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


test('容量不足で古い値が読めるままでも、新しいスタンプと番号を控えから復元する',async({page,context})=>{
 const g=server(),log={};await bridge(context,g,log);
 await context.addInitScript(()=>{if(sessionStorage.getItem('__quota246'))return;sessionStorage.setItem('__quota246','1');localStorage.setItem('kuroko_sid',JSON.stringify('ABCD2345'));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(['1F-02']));});
 await ready(page);await offline(page);log.offline=true;
 const mid=await page.evaluate(async()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k.startsWith('kuroko_'))throw new DOMException('quota','QuotaExceededError');return set.call(this,k,v);};earnStamp('1F-03');store('kuroko_sid','WXYZ6789');const saved=await checkpointStamps();return {saved,sid:stampId(),disk:JSON.parse(localStorage.getItem('kuroko_sid')),n:STAMP_VAULT.committed.kuroko_stamps_v2.length};});
 expect(mid).toEqual({saved:true,sid:'WXYZ6789',disk:'ABCD2345',n:2});
 log.offline=false;await page.reload();await page.waitForFunction(()=>window.__booted===true&&S.booths.length===46);expect(await page.evaluate(()=>({sid:stampId(),n:S.stamps.size}))).toEqual({sid:'WXYZ6789',n:2});
});
