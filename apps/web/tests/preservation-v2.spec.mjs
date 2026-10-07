import {test,expect} from '@playwright/test';

test('V2 route shows the three stages and exact pilot limits without wallet access',async({page})=>{
  let walletCalls=0;
  await page.addInitScript(()=>{
    Object.defineProperty(window,'phantom',{value:{solana:{isPhantom:true,connect:()=>{window.__walletCalls=(window.__walletCalls??0)+1;throw Error('unexpected wallet call');}}}});
    Object.defineProperty(window,'arweaveWallet',{value:{connect:()=>{window.__walletCalls=(window.__walletCalls??0)+1;throw Error('unexpected wallet call');}}});
  });
  await page.goto('/#/save');
  await expect(page.getByRole('heading',{name:'Сохранить семейную историю'})).toBeVisible();
  await expect(page.getByText('Solana Devnet · комиссия сети отдельно')).toBeVisible();
  await expect(page.getByText('Реальные AR · до 0.004 AR')).toBeVisible();
  await expect(page.getByRole('list',{name:'Ход сохранения'}).locator('li')).toHaveCount(3);
  await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
  walletCalls=await page.evaluate(()=>window.__walletCalls??0);expect(walletCalls).toBe(0);
});

test('wrong file is rejected before either wallet',async({page})=>{
  await page.goto('/#/save');
  await page.getByLabel('Зашифрованный архив пилота').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from('{"synthetic":true}')});
  await expect(page.getByRole('alert')).toContainText('Файл архива не совпадает');
  await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
});
