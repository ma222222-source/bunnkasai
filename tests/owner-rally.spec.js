const {test,expect}=require('@playwright/test');
const {loadGas}=require('./gas-mock');
const {watchErrors}=require('./mock');
const OWNER='owner-rally-test-1234',CID='RESET2345';
function server(){const g=loadGas({props:{ADMIN_PASS:'legacy-test-1234',OWNER_PASS:OWNER}});g.setupR8AndArchiveOthers();return g;}
async function bridge(ctx,g,opt={}){
 await ctx.route(/script\.google(usercontent)?\.com\//,async route=>{
  const req=route.request(),post=req.method()==='POST',body=post?JSON.parse(req.postData()||'{}'):null;
  const text=post?g.doPost({postData:{contents:JSON.stringify(body)}}).getContent():g.doGet({parameter:Object.fromEntries(new URL(req.url()).searchParams)}).getContent();
  if(body&&body.action==='owner_rally_reset'){(opt.resets||(opt.resets=[])).push(body);if(opt.drop){opt.drop=false;return route.abort();}}
  await route.fulfill({contentType:'application/json',body:text});
 });
}
async function enter(page,url='/?mode=owner'){
 await page.goto(url);if(url.includes('mode=admin')){await page.locator('#auth-who').fill('担当者');await page.locator('#btn-login').click();await expect(page.locator('#v-admin')).toBeVisible();await page.locator('#btn-open-owner').click();}
 await page.locator('#own-pw').fill(OWNER);await page.locator('#own-login').click();await expect(page.locator('#own-main')).toBeVisible();
}
async function openReset(page){await page.locator('#owntab-setup').click();await page.locator('#own-rally-reset summary').click();}
async function reset(page){await page.locator('#own-reset-confirm').fill('全体リセット');page.once('dialog',d=>d.accept());await page.locator('#own-reset-send').click();}

test('司令塔は担当QRの制限を受けず、全ブースの人数・混雑・休止を変更できる',async({page,context})=>{
 const g=server(),errors=watchErrors(page);await bridge(context,g);await enter(page,'/?mode=admin&staffBooth=1F-02');await page.locator('#owntab-home').click();
 await expect(page.locator('#own-crowd-booth option')).toHaveCount(46);await page.locator('#own-crowd-booth').selectOption('1F-03');await page.locator('#own-crowd-wait').fill('18');await page.locator('#own-crowd-send').click();
 await expect(page.locator('#own-crowd-result')).toContainText('反映しました');expect(g.__get().booths.find(b=>b.id==='1F-03').wait).toBe(18);
 await page.locator('[data-own-status="やや混雑"]').click();await expect(page.locator('#own-crowd-result')).toContainText('やや混雑に反映');
 page.once('dialog',d=>d.accept());await page.locator('#own-crowd-pause').click();await expect(page.locator('#own-crowd-pause')).toHaveText('休止をやめる（再開）');await page.locator('#own-crowd-pause').click();await expect.poll(()=>g.__get().booths.find(b=>b.id==='1F-03').wait).toBe(0);
 await page.locator('#own-crowd-booth').selectOption('3F-04');await page.locator('#own-crowd-wait').fill('9999');await page.locator('#own-crowd-send').click();await expect(page.locator('#own-crowd-result')).toContainText('0〜999');expect(g.__get().booths.find(b=>b.id==='3F-04').wait).not.toBe(9999);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);expect(errors).toEqual([]);
});

test('全体リセットは確認入力・最終確認が必要。全員の記録を新しい回へ切り替え、再読込でも戻らない',async({page,context,browser})=>{
 const g=server(),opt={},errors=watchErrors(page),ids=g.__get().booths.slice(0,7).map(b=>b.id);await bridge(context,g,opt);g.__post({action:'ledger',cid:CID,ev:ids.map(id=>({t:'s',id}))});
 const visitor=await browser.newContext({serviceWorkers:'block'});await bridge(visitor,g);await visitor.addInitScript(({cid,ids})=>{if(!localStorage.getItem('seeded')){localStorage.setItem('seeded','1');localStorage.setItem('kuroko_sid',JSON.stringify(cid));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(ids));}},{cid:CID,ids});const v=await visitor.newPage();await v.goto(new URL('/?tab=stamp',page.url()==='about:blank'?'http://127.0.0.1:8732':page.url()).href);await expect.poll(()=>v.evaluate(()=>S.stamps.size)).toBe(7);await v.evaluate(()=>checkpointStamps());const backup=await v.evaluate(()=>stampBackup());
 await enter(page);await openReset(page);await expect(page.locator('#own-reset-send')).toBeDisabled();await page.locator('#own-reset-confirm').fill('全体リセット');page.once('dialog',d=>d.dismiss());await page.locator('#own-reset-send').click();expect(opt.resets||[]).toHaveLength(0);
 await reset(page);await expect(page.locator('#own-reset-result')).toContainText('全体リセットしました');await v.evaluate(()=>sync(false));await expect.poll(()=>v.evaluate(()=>S.stamps.size)).toBe(0);
 // 古いIndexedDBの控えが遅れて戻っても、リセット後の通常保存と混ぜない。
 await v.evaluate(async({cid,ids})=>{await checkpointStamps();await new Promise((resolve,reject)=>{const tx=STAMP_VAULT.db.transaction('backup','readwrite');tx.objectStore('backup').put({kuroko_sid:cid,kuroko_stamps_v2:ids,kuroko_spent_v1:[]},'current');tx.oncomplete=resolve;tx.onerror=reject;});},{cid:CID,ids});
 await v.reload();await expect.poll(()=>v.evaluate(()=>S.stamps.size)).toBe(0);await expect.poll(()=>v.evaluate(()=>S.serverVersion)).toBe(g.GAS_VERSION);
 const message=await v.evaluate(async data=>{try{await importStampBackup(new File([JSON.stringify(data)],'old.json',{type:'application/json'}));return 'accepted';}catch(e){return e.message;}},backup);expect(message).toContain('全体リセット前');
 expect(g.__ss.getSheetByName('スタンプ記録').getLastRow()).toBe(8);expect(g.__get({ledger:CID}).stamps).toEqual([]);await visitor.close();expect(errors).toEqual([]);
});

test('全体リセットの返事が失われても、同じ実行番号で再確認して二度リセットしない',async({page,context})=>{
 const g=server(),opt={drop:true};await bridge(context,g,opt);await enter(page);await openReset(page);await reset(page);await expect(page.locator('#own-reset-result')).toContainText('確認できませんでした');const first=JSON.parse(g.__props.RALLY_RESET).epoch;
 await reset(page);await expect(page.locator('#own-reset-result')).toContainText('全体リセットしました');expect(opt.resets).toHaveLength(2);expect(opt.resets[0].requestId).toBe(opt.resets[1].requestId);expect(JSON.parse(g.__props.RALLY_RESET).epoch).toBe(first);
});

test('リセット前の台帳の返事が遅れて届いても、新しく集めたスタンプに混ぜない',async({page,context})=>{
 const g=server(),ids=g.__get().booths.slice(0,7).map(b=>b.id),opt={};g.__post({action:'ledger',cid:'HOLD2345',ev:ids.map(id=>({t:'s',id}))});await bridge(context,g);
 await context.route(/ledger=HOLD2345/,async route=>{const text=g.doGet({parameter:{ledger:'HOLD2345'}}).getContent();opt.held=true;await new Promise(resolve=>opt.release=resolve);await route.fulfill({contentType:'application/json',body:text});});
 await page.goto('/?tab=stamp');await expect.poll(()=>page.evaluate(()=>S.serverVersion)).toBe(g.GAS_VERSION);
 const pending=page.evaluate(()=>fetchLedger('HOLD2345').then(l=>{absorbLedger(l);return 'accepted';},e=>e.message));await expect.poll(()=>opt.held).toBe(true);
 try{
  const token=g.__post({action:'owner_login',opass:OWNER,cid:'owner-device-0001'}).token;g.__post({action:'owner_rally_reset',token,confirm:'全体リセット',requestId:'held-reset-0001',epoch:''});await page.evaluate(()=>sync(false));await expect.poll(()=>page.evaluate(()=>rallyResetMarker().epoch)).not.toBe('');
  const next=g.__get().booths[8].id;await page.evaluate(id=>{S.stamps.add(id);store('kuroko_stamps_v2',[...S.stamps]);},next);opt.release();expect(await pending).toContain('rally_stale');expect(await page.evaluate(()=>[...S.stamps])).toEqual([next]);
 }finally{opt.release();}
});
