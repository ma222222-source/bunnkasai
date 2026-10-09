// 同じ端末でタブを2つ開いたとき（v182）。
// QR を標準のカメラで読むたびに新しいタブが開くので、この画面がいくつも開いていることは珍しくない。
// 片方のタブでの操作が、もう片方で集めたもの・決めたことを消さないこと、開いたままのタブにもその場で伝わることを確かめる。
// v182 より前は、別のタブで付けた★が消え（外した★は復活し）、音・文字の大きさは開き直すまで伝わらなかった
const { test, expect } = require('@playwright/test');
const { mockGas } = require('./mock');
test('タブを2つ開いても、★・スタンプ・いまここ・設定が消えず、もう片方にその場で伝わる', async ({ context }) => {
  test.setTimeout(120000);
  const out = [];
  const A = await context.newPage(), B = await context.newPage();
  for (const p of [A, B]) { await mockGas(p); p.on('pageerror', e => out.push('pageerror: ' + e.message)); }
  await A.addInitScript(() => { try { localStorage.setItem('kuroko_intro_v1', '1'); } catch (e) {} });
  await A.goto('/?tab=map'); await A.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
  await B.goto('/?tab=list'); await B.waitForFunction(() => typeof S !== 'undefined' && S.booths.length > 0);
  const ls = (p, k) => p.evaluate(k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return 'x'; } }, k);
  const chk = (label, ok, detail) => { if (!ok) out.push(label + ' ' + (detail || '')); };

  // ---- ★：A で付ける → B で別のを付ける → 両方残るか
  await A.evaluate(() => toggleWish('1F-02')); await A.waitForTimeout(200);
  await B.evaluate(() => toggleWish('1F-03')); await B.waitForTimeout(200);
  let w = await ls(A, 'kuroko_wish_v1');
  chk('★：別のタブで付けた★が消えた', Array.isArray(w) && w.includes('1F-02') && w.includes('1F-03'), JSON.stringify(w));
  chk('★：A の画面に B の★が出ていない', await A.evaluate(() => S.wish.has('1F-03')), '');
  chk('★：B の画面に A の★が出ていない', await B.evaluate(() => S.wish.has('1F-02')), '');
  // A で外す → B で別のを付ける → 外したものが復活しないか
  await A.evaluate(() => toggleWish('1F-02')); await A.waitForTimeout(200);
  await B.evaluate(() => toggleWish('1F-05')); await B.waitForTimeout(200);
  w = await ls(A, 'kuroko_wish_v1');
  chk('★：別のタブで外した★が復活した', Array.isArray(w) && !w.includes('1F-02') && w.includes('1F-05') && w.includes('1F-03'), JSON.stringify(w));

  // ---- スタンプ：A で押す → B で別のを押す
  await A.evaluate(() => { stampNow('1F-02'); if (showStampFx.close) showStampFx.close(); }); await A.waitForTimeout(300);
  await B.evaluate(() => { stampNow('1F-03'); if (showStampFx.close) showStampFx.close(); }); await B.waitForTimeout(300);
  let st = await ls(A, 'kuroko_stamps_v2');
  chk('スタンプ：別のタブのスタンプが消えた', st.includes('1F-02') && st.includes('1F-03'), JSON.stringify(st));
  chk('スタンプ：A の画面に B のスタンプが出ていない', await A.evaluate(() => S.stamps.has('1F-03')), '');
  // 押した時刻（kuroko_stamp_at）：両方残るか
  const at = await ls(A, 'kuroko_stamp_at');
  chk('押した時刻：別のタブの分が消えた', at && at['1F-02'] && at['1F-03'], JSON.stringify(at));

  // ---- いまここ：B で決める → A に出るか
  await B.evaluate(() => setHere('1F-07', 'pick')); await B.waitForTimeout(300);
  chk('いまここ：別のタブで決めた場所が出ていない', (await A.evaluate(() => hereId())) === '1F-07', String(await A.evaluate(() => hereId())));

  // ---- 最近見た：A で開く → B で開く
  await A.evaluate(() => { openSheet('1F-08'); closeSheet(); }); await A.waitForTimeout(200);
  await B.evaluate(() => { openSheet('2F-01' in Object ? '1F-08' : S.booths[9].id); closeSheet(); }); await B.waitForTimeout(200);
  const rq = await ls(A, 'kuroko_recent_q');
  chk('最近見た：別のタブで見たものが消えた', rq.includes('1F-08'), JSON.stringify(rq));

  // ---- 設定：B で音を止める・文字を特大に → A に反映されるか（次に開いたときではなく、その場で）
  await B.evaluate(() => { setSound(false); document.querySelector('#fs-xl').click(); }); await B.waitForTimeout(400);
  chk('音：別のタブで止めたのに、こちらでは鳴る設定のまま', (await A.evaluate(() => S.sound)) === false, String(await A.evaluate(() => S.sound)));
  chk('文字の大きさ：別のタブで変えたのに、こちらは前のまま', (await A.evaluate(() => document.documentElement.getAttribute('data-fs'))) === 'xl', '');

  // ---- 交換済み：A で交換（5個）→ B の画面に出るか・B からもう一度交換できてしまわないか
  await A.evaluate(() => { ['1F-05', '1F-07', '1F-08'].forEach(id => earnStamp(id)); }); await A.waitForTimeout(300);
  const left = await B.evaluate(() => { pullStamps(); return stampsLeft(); });
  chk('スタンプ：B から見た使える数が違う', left === 5, String(left));

  console.log(out.length ? out.map(x => '  ✗ ' + x).join('\n') : '  問題なし');
});
