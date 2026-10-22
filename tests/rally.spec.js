// v245：実際のCode.gsにつなぎ、抽選・交換・通信障害・個人の記念画像を確認。本番通信は遮断する。
const { test, expect }=require('@playwright/test');
const { loadGas }=require('./gas-mock');
const { watchErrors }=require('./mock');
const fs=require('fs'); const path=require('path');
const ART=path.resolve(process.env.RALLY_SHOTS || path.join(__dirname,'shots','rally'));
const CID='ABCD2345';
function server(value=0){
 const g=loadGas({props:{ADMIN_PASS:'test-password-1234',OWNER_PASS:'owner-himitsu-123456'}});
 g.setupR8AndArchiveOthers();g.Math=Object.create(Math);g.Math.random=()=>value;
 return g;
}
async function bridge(ctx,g,opt={}){
 await ctx.route('**/*',route=>/^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)|blob:http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)|data:|about:)/.test(route.request().url()) ? route.continue() : route.abort());
 await ctx.route(/script\.google(usercontent)?\.com\//,async route=>{
  const req=route.request(); const isPost=req.method()==='POST';
  const data=isPost?JSON.parse(req.postData()||'{}'):null;if(data&&opt.posts)opt.posts.push(data);
  let body=isPost ? g.doPost({postData:{contents:req.postData()}}).getContent() : g.doGet({parameter:Object.fromEntries(new URL(req.url()).searchParams)}).getContent();
  if(data && opt.drop===data.action && !opt.dropped){opt.dropped=true;return route.abort();}
  if(opt.old && !isPost){const j=JSON.parse(body);j.serverVersion='2026-10-19a';body=JSON.stringify(j);}
  return route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},contentType:'application/json',body});
 });
}
async function seed(ctx,g,count=7,cid=CID){
 const ids=g.R8_BOOTHS.slice(0,count).map(b=>b[0]);
 g.__post({action:'ledger',cid,ev:ids.map(id=>({t:'s',id}))});
 await ctx.addInitScript(({ids,cid})=>{localStorage.setItem('kuroko_sid',JSON.stringify(cid));localStorage.setItem('kuroko_stamps_v2',JSON.stringify(ids));},{ids,cid});
}
async function open(page,baseURL){await page.goto(baseURL+'/?tab=stamp');await expect(page.locator('#rally-card')).toBeVisible();await expect.poll(()=>page.evaluate(()=>S.serverVersion)).toBe('2026-10-22a');}
async function draw(page){await expect(page.locator('#rally-draw')).toBeEnabled();await page.locator('#rally-draw').click();await expect.poll(()=>page.evaluate(()=>RALLY.busy)).toBe(false);await expect.poll(()=>page.evaluate(()=>rallyDraws().length)).toBeGreaterThan(0);}

test('7個の抽選：6個では参加できず、7個で当たり。再読込後も券が残り、4桁で1回だけ交換',async({page,context,baseURL})=>{
 const g=server(),errors=watchErrors(page);await bridge(context,g);await seed(context,g,6);await open(page,baseURL);
 await expect(page.locator('#rally-draw')).toBeDisabled();await expect(page.locator('#rally-result')).toContainText('あと1個');
 await page.evaluate(id=>{S.stamps.add(id);store('kuroko_stamps_v2',[...S.stamps]);renderStamps();},g.R8_BOOTHS[6][0]);
 await draw(page);await expect(page.locator('#rally-result')).toContainText('お菓子1個を確保');
 expect(g.rallyStock_().issued).toBe(1);await page.reload();await expect(page.locator('#rally-result')).toContainText('お菓子1個を確保');
 await page.locator('#redeem-open').click();await page.locator('#staff-code').fill(await page.evaluate(()=>redeemCode()));await page.locator('#redeem-ok').click();
 await expect(page.locator('#pfx')).toContainText('お菓子を1個');await expect(page.locator('#pfx')).toContainText('スタンプと記念カードはそのまま');
 expect(await page.evaluate(()=>S.stamps.size)).toBe(7);expect(await page.evaluate(()=>S.spent.length)).toBe(0);
 expect(g.rallyStock_().given).toBe(1);await page.keyboard.press('Escape');await page.reload();await expect(page.locator('#rally-result')).toContainText('交換済み');expect(errors).toEqual([]);
});


const photoFixture={name:'sample.png',mimeType:'image/png',buffer:null};
async function samplePhoto(page){
 const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=900;const g=c.getContext('2d');g.fillStyle='#cbe8f8';g.fillRect(0,0,1200,900);g.fillStyle='#f59e0b';g.beginPath();g.arc(600,370,160,0,Math.PI*2);g.fill();g.fillStyle='#1e3a8a';g.fillRect(380,545,440,355);g.fillStyle='#111827';g.font='60px sans-serif';g.fillText('PHOTO TEST',400,850);return c.toDataURL();});
 return {name:'sample.png',mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')};
}
test('全制覇プリクラ：45個では出ず46個で解放。写真を枠付きで保存でき、人ごとの枠も異なる',async({page,context,baseURL},info)=>{
 const g=server(),opt={posts:[]};await bridge(context,g,opt);await seed(context,g,45);await open(page,baseURL);
 await expect(page.locator('#rally-complete')).toBeHidden();
 await page.evaluate(id=>{S.stamps.add(id);store('kuroko_stamps_v2',[...S.stamps]);renderStamps();},g.R8_BOOTHS[45][0]);
 await page.locator('#rally-complete').click();await expect(page.locator('#rally-photo')).toBeVisible();
 const file=await samplePhoto(page);await page.locator('#rally-photo-file').setInputFiles(file);await expect(page.locator('#rally-photo-save')).toBeVisible();
 const first=await page.evaluate(()=>({entry:rallyComplete(),png:document.querySelector('#rally-photo-canvas').toDataURL()}));
 const other=g.__post({action:'rally_complete',cid:'EFGH6789',ev:g.R8_BOOTHS.map(b=>({t:'s',id:b[0]}))}).rally.entries.find(e=>e.result==='complete');
 const second=await page.evaluate(async({entry,data})=>{const img=new Image();img.src=data;await img.decode();return rallyPhotoCanvas(entry,img,false).toDataURL();},{entry:other,data:'data:image/png;base64,'+file.buffer.toString('base64')});
 expect(second).not.toBe(first.png);expect(other.serial).not.toBe(first.entry.serial);expect(other.art).not.toBe(first.entry.art);
 fs.mkdirSync(ART,{recursive:true});fs.writeFileSync(path.join(ART,info.project.name+'-photo-person-a.png'),Buffer.from(first.png.split(',')[1],'base64'));fs.writeFileSync(path.join(ART,info.project.name+'-photo-person-b.png'),Buffer.from(second.split(',')[1],'base64'));
 await page.evaluate(()=>Object.defineProperty(navigator,'canShare',{value:()=>false,configurable:true}));
 const download=page.waitForEvent('download');await page.locator('#rally-photo-save').click();const d=await download;expect(d.suggestedFilename()).toMatch(/kuroko-complete-\d{6}\.png/);
 const buf=fs.readFileSync(await d.path());expect(buf.readUInt32BE(16)).toBe(1080);expect(buf.readUInt32BE(20)).toBe(1440);
 expect(JSON.stringify(opt.posts)).not.toContain('data:image');expect(opt.posts.every(p=>!p.photo&&!p.image&&!p.file)).toBe(true);
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(ART,`${info.project.name}-${width}-photo.png`)});expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);}
 await page.locator('#rally-photo-close').click();await page.reload();await expect(page.locator('#rally-save')).toBeVisible();
 expect(await page.evaluate(()=>rallyComplete().art)).toBe(first.entry.art);
});
test('全制覇プリクラ：カメラの撮影・撮り直し・終了時の停止。拒否された場合は写真選択を案内',async({page,context,baseURL},info)=>{
 test.skip(info.project.name!=='chromium','Canvasの模擬カメラはChromiumで検証。写真選択は3ブラウザで検証');
 const g=server();await bridge(context,g);await seed(context,g,46);await open(page,baseURL);await page.locator('#rally-complete').click();
 await page.evaluate(()=>{const cv=document.createElement('canvas');cv.width=600;cv.height=800;const gc=cv.getContext('2d');gc.fillStyle='#efb';gc.fillRect(0,0,600,800);window.photoTestStream=cv.captureStream(5);Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>window.photoTestStream,configurable:true});});
 await page.locator('#rally-photo-start').click();await expect(page.locator('#rally-photo-capture')).toBeVisible();await page.locator('#rally-photo-capture').click();await expect(page.locator('#rally-photo-save')).toBeVisible();expect(await page.evaluate(()=>photoTestStream.getTracks()[0].readyState)).toBe('ended');
 await page.locator('#rally-photo-retake').click();await page.evaluate(()=>Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('denied','NotAllowedError');},configurable:true}));
 await page.locator('#rally-photo-start').click();await expect(page.locator('#rally-photo-error')).toContainText('写真を1枚選んで作る');await page.locator('#rally-photo-close').click();
});

test('通信失敗：サーバー確定後に抽選の返事が消えても再送で引き直さず、交換の返事が消えても二重に渡さない',async({page,context,baseURL})=>{
 const g=server(),opt={drop:'rally_draw'};await bridge(context,g,opt);await seed(context,g);await open(page,baseURL);
 await page.locator('#rally-draw').click();await expect(page.locator('#rally-error')).toBeVisible();expect(g.rallyStock_().issued).toBe(1);
 await draw(page);expect(g.rallyStock_().issued).toBe(1);
 opt.drop='rally_redeem';opt.dropped=false;
 await page.locator('#redeem-open').click();await page.locator('#staff-code').fill(await page.evaluate(()=>redeemCode()));await page.locator('#redeem-ok').click();
 await expect(page.locator('#redeem-err')).toBeVisible();expect(g.rallyStock_().given).toBe(1);
 await page.locator('#redeem-ok').click();await expect(page.locator('#rally-result')).toContainText('交換済み');await expect(page.locator('#pfx')).toHaveCount(0);expect(g.rallyStock_().given).toBe(1);
});

test('圏外では抽選も交換も確定しない。復帰後に続けられる',async({page,context,baseURL})=>{
 const g=server();await bridge(context,g);await seed(context,g);await open(page,baseURL);
 await context.setOffline(true);await expect(page.locator('#rally-draw')).toBeDisabled();expect(g.rallyStock_().issued).toBe(0);
 await context.setOffline(false);await draw(page);await context.setOffline(true);await expect(page.locator('#redeem-open')).toBeDisabled();expect(g.rallyStock_().given).toBe(0);
});

test('旧サーバーは交換を迂回せず、抽選サーバーの準備待ちになる',async({page,context,baseURL})=>{
 const g=server();await bridge(context,g,{old:true});await seed(context,g);await page.goto(baseURL+'/?tab=stamp');
 await expect(page.locator('#rally-draw')).toBeDisabled();await expect(page.locator('#rally-draw')).toContainText('準備');await expect(page.locator('#redeem-card')).toBeHidden();
});

test('PC・スマホ：320・390・768・1280pxと特大文字で抽選、当たり、記念画像がはみ出さない',async({page,context,baseURL},info)=>{
 test.setTimeout(90000);
 const g=server(),errors=watchErrors(page);await bridge(context,g);await seed(context,g);await open(page,baseURL);await draw(page);
 fs.mkdirSync(ART,{recursive:true});
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>document.documentElement.dataset.fs='xl');
  await page.locator('#rally-card').scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
  const box=await page.locator('#rally-card').boundingBox();expect(box.width).toBeLessThanOrEqual(width);
  await page.screenshot({path:path.join(ART,`${info.project.name}-${width}-winner.png`),fullPage:true});
 }
 expect(errors).toEqual([]);
});

test('司令塔：500個の上限・未交換の当たり・交換済みが見える',async({page,context,baseURL})=>{
 const g=server();await bridge(context,g);g.__post({action:'rally_draw',cid:CID,attempt:1,ev:g.R8_BOOTHS.slice(0,7).map(b=>({t:'s',id:b[0]}))});
 await page.goto(baseURL+'/?mode=owner');await page.locator('#own-pw').fill('owner-himitsu-123456');await page.locator('#own-login').click();await expect(page.locator('#own-main')).toBeVisible();await page.locator('#owntab-event').click();
 await expect(page.locator('#own-rally-stock')).toContainText('499');await expect(page.locator('#own-rally-stock')).toContainText('未交換の当たり1個');
});

test('司令塔：全11種の演出を試しても実際の抽選・在庫・交換・スタンプは増えず、見本の撮影もできる',async({page,context,baseURL},info)=>{
 test.setTimeout(90000);
 const g=server(),opt={posts:[]},errors=watchErrors(page);await bridge(context,g,opt);
 const sheet=g.rallyWriteSheet_();for(let i=0;i<500;i++)sheet.appendRow([new Date().toISOString(),'FULL'+i,'candy','filled-'+i,'','', '']);g.__cache.clear();expect(g.rallyStock_(true).remaining).toBe(0);
 await page.goto(baseURL+'/?mode=owner');await page.locator('#own-pw').fill('owner-himitsu-123456');await page.locator('#own-login').click();await expect(page.locator('#own-main')).toBeVisible();await page.locator('#owntab-event').click();
 const state=JSON.stringify(g.rallyStock_(true));const start=opt.posts.length;
 const types=await page.locator('#own-effects [data-effect-test]').evaluateAll(bs=>bs.map(b=>b.dataset.effectTest));expect(types.length).toBe(11);
 for(const kind of types){
  await page.locator(`[data-effect-test="${kind}"]`).click();
  if(kind==='photo'){
   await expect(page.locator('#rally-photo')).toBeVisible();await expect(page.locator('#rally-photo-title')).toContainText('テスト表示');
   await page.locator('#rally-photo-file').setInputFiles(await samplePhoto(page));await expect(page.locator('#rally-photo-save')).toBeVisible();
   expect(await page.evaluate(()=>RALLY_PHOTO.entry.demo)).toBe(true);
   await page.locator('#rally-photo-retake').click();await expect(page.locator('#rally-photo-start')).toBeVisible();
   await page.screenshot({path:path.join(ART,info.project.name+'-owner-photo-preview.png')});
   await page.locator('#rally-photo-close').click();
  }else if(kind==='redeem'){
   await expect(page.locator('#pfx')).toContainText('テスト表示');await expect(page.locator('#pfx')).not.toContainText('受け取ってください');await page.locator('#pfx [data-fx="close"]').click();await expect(page.locator('#pfx')).toHaveCount(0);
  }else{
   await expect(page.locator('#lfx')).toContainText('テスト表示');await page.locator('#lfx [data-fx="close"]').click();await expect(page.locator('#lfx')).toHaveCount(0);
  }
 }
 expect(JSON.stringify(g.rallyStock_(true))).toBe(state);
 expect(opt.posts.slice(start).filter(p=>p.action!=='owner_state'&&!(p.action==='owner_draw'&&p.dry===true))).toEqual([]);
 expect(await page.evaluate(()=>S.stamps.size)).toBe(0);expect(await page.evaluate(()=>S.spent.length)).toBe(0);expect(errors).toEqual([]);
 await page.locator('[data-effect-test="photo"]').click();
 const AxeBuilder=require('@axe-core/playwright').default;
 for(const theme of ['paper','heavy']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const a=await new AxeBuilder({page}).include('#rally-photo').withTags(['wcag2a','wcag2aa']).analyze();
  expect(a.violations.filter(v=>v.impact==='critical'||v.impact==='serious')).toEqual([]);
 }
});
