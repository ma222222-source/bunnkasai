// 既存の係員テストでも、初回の名前登録を実際の入力欄から通す。
async function fillStaffName(page, name = 'テスト係員') {
  const input = page.locator('#auth-who');
  if (await input.isVisible() && !(await input.inputValue()).trim()) await input.fill(name);
}
async function enterStaff(page,name){
  await page.waitForFunction(()=>S.isAdmin||login._on||AUTH_WAIT.pass||(S.view==='auth'&&(staffName()||!document.querySelector('#auth-name-entry').classList.contains('hide'))));
  if(await page.locator('#auth-name-entry').isVisible()){
    await fillStaffName(page,name);await page.locator('#btn-login').click();
  }else if(!await page.evaluate(()=>S.isAdmin||login._on||AUTH_WAIT.pass)){
    await page.locator('#btn-login').click();
  }
}
module.exports = { fillStaffName, enterStaff };
