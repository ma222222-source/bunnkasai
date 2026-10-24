'use strict';
// IDトークンはこのページのメモリと本人確認POSTにだけ使う。URL・ログ・保存領域には入れない。
const LINE_STAMP_LIFF='2010429448-BHqMzuIn';
const LINE_STAMP_GAS='https://script.google.com/macros/s/AKfycbyUZHslRZ6m6S57v25jhUfZy8m_tP6f_cjyunYr196zL6VTF03BHUKTJMZyAJ5q9WBd/exec';
const lineRead=k=>{try{return JSON.parse(localStorage.getItem(k));}catch(e){return null;}};
const lineIds=k=>{const value=lineRead(k);return Array.isArray(value)?value.filter(id=>typeof id==='string'&&/^[0-9A-Za-z_-]{1,24}$/.test(id)).slice(0,300):[];};
async function lineJson(url,init){
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('通信を確認して、もう一度お試しください');
 const data=await response.json();if(!data||data.ok===false)throw Error('LINEの確認・保存が完了しませんでした。もう一度お試しください');return data;
}
async function connectLineStamp(){
 const status=document.querySelector('#status'),retry=document.querySelector('#retry');retry.hidden=true;retry.disabled=true;
 try{
  if(!window.liff)throw Error('LINEを読み込めませんでした。通信を確認してください');
  await liff.init({liffId:LINE_STAMP_LIFF});
  const from=new URL(location.href).searchParams.get('from')||lineRead('kuroko_sid')||'';
  const requestedTab=new URL(location.href).searchParams.get('tab'),tab=['map','list','stamp','info'].includes(requestedTab)?requestedTab:'map';
  if(!liff.isLoggedIn()){status.textContent='LINEのログイン画面を開きます…';const back=new URL('line-stamp.html',location.href);if(/^[0-9A-Za-z]{6,40}$/.test(from))back.searchParams.set('from',from);back.searchParams.set('tab',tab);liff.login({redirectUri:back.href});return;}
  const idToken=liff.getIDToken();if(!idToken)throw Error('LINEの同意を確認できませんでした。LINEから開き直してください');
  status.textContent='スプレッドシートの記録を確認しています…';
  const current=await lineJson(LINE_STAMP_GAS+'?gen=1'),epoch=current.rallyReset?.epoch||'';
  // SDKの初期化後に読む。初期化前にURLを書き換えるとLINEのログインを完了できない。
  const sameEpoch=(lineRead('kuroko_rally_reset')?.epoch||'')===epoch;
  const ev=sameEpoch?[...lineIds('kuroko_stamps_v2').map(id=>({t:'s',id})),...lineIds('kuroko_spent_v1').map(id=>({t:'r',id}))]:[];
  const saved=await lineJson(LINE_STAMP_GAS,{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({action:'line_stamp',idToken,from,ev,rallyEpoch:epoch})});
  if(!saved.lineLinked||!/^[0-9A-Za-z]{6,40}$/.test(saved.cid)||!Array.isArray(saved.stamps)||!Array.isArray(saved.spent))throw Error('保存した記録を確認できませんでした');
  // 引き渡すのは匿名の台帳データだけ。使い終わったらマップ側で削除する。
  try{sessionStorage.setItem('kuroko_line_transfer',JSON.stringify(saved));}catch(e){}
  status.textContent='記録を確認しました。スタンプ画面を開きます！';
  const target=new URL('./',location.href);target.searchParams.set('lineStamp',saved.cid);target.searchParams.set('tab',tab);target.hash=tab;location.replace(target.href);
 }catch(e){status.textContent=e.name==='TimeoutError'?'通信に時間がかかっています。電波の良い場所でもう一度お試しください。':String(e.message||'接続できませんでした');retry.hidden=false;retry.disabled=false;}
}
document.querySelector('#retry').addEventListener('click',connectLineStamp);
connectLineStamp();
