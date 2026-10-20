// 既存の係員テストでも、初回の名前登録を実際の入力欄から通す。
async function fillStaffName(page, name = 'テスト係員') {
  const input = page.locator('#auth-who');
  if (await input.isVisible() && !(await input.inputValue()).trim()) await input.fill(name);
}
module.exports = { fillStaffName };
