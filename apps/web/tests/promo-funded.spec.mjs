import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockAdminLock, adminPassword } from './admin-password.fixture.mjs';
const archive=JSON.stringify({schema:'sejire/envelope/v1',vault_id:'a'.repeat(32),cipher:'aes-gcm-256',kdf:'hkdf-sha256',iv:'AAAAAAAAAAAAAAAA',ciphertext:'A'.repeat(32),protocol:'sejire/v0.3'});
const tx='A'.repeat(43),initial='13000000000000';
test('Admin changes one promo and cumulative limit; user preserves encrypted archive without Solana',async({page})=>{
 await mockAdminLock(page);
 let code='',revision=0,enabled=false,limit=initial,spent=0n;
 const rows=[];
 const dashboard=()=>({promo:{enabled,displayHint:code?`${code.slice(0,4)}••••${code.slice(-2)}`:'',revision,createdAt:Date.now(),updatedAt:Date.now()},treasuryAddress:'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',
  limitWinston:limit,actualSpentWinston:spent.toString(),reservedWinston:'0',budgetRemainingWinston:(BigInt(limit)-spent).toString(),walletBalanceWinston:'68996561462544',lastBalanceCheck:Date.now(),
  currentQuoteWinston:'3000000000',currentQuoteBytes:rows.length?archive.length:6144,effectiveAvailableWinston:(BigInt(limit)-spent).toString(),estimatedTreesRemaining:rows.length?String((BigInt(limit)-spent)/3000000000n):null,
  fundStatus:'HEALTHY',successfulTrees:rows.length,today:rows.length,last7Days:rows.length,failedAttempts:0,pending:0,totalEncryptedBytes:rows.reduce((n,x)=>n+x.archiveSizeBytes,0),
  averageArchiveBytes:rows.length?archive.length:null,largestArchiveBytes:rows.length?archive.length:null,smallestArchiveBytes:rows.length?archive.length:null,
  averageActualWinston:rows.length?'3000000000':null,minActualWinston:rows.length?'3000000000':null,maxActualWinston:rows.length?'3000000000':null,latestActualWinston:rows.length?'3000000000':null,
  currentRevisionTrees:rows.filter(x=>x.promoRevision===revision).length,currentRevisionSpentWinston:String(BigInt(rows.filter(x=>x.promoRevision===revision).length)*3000000000n),lastReconciliation:null,history:rows});
 await page.route('**/api/fund/**',async route=>{const url=new URL(route.request().url()),path=url.pathname,method=route.request().method(),body=method==='POST'?route.request().postDataJSON():null;
  let status=200,value={};
  if(path.startsWith('/api/fund/admin/')&&route.request().headers()['authorization']!==`Bearer ${adminPassword}`){status=401;value={error:'admin_unauthorized'};}
  else if(path.endsWith('/balance'))value={treasuryAddress:'qgoIFw9WsusMRapWzcFg4jNW08HSWvQkpAKOz86BUuI',walletBalanceWinston:'68996561462544',lastBalanceCheck:Date.now()};
  else if(path.endsWith('/dashboard'))value=dashboard();
  else if(path.endsWith('/promo')){code=body.code.trim().toUpperCase();revision++;enabled=true;value=dashboard();}
  else if(path.endsWith('/enabled')){enabled=body.enabled;value=dashboard();}
  else if(path.endsWith('/limit')){limit=String(BigInt(body.limitAr)*1000000000000n);value=dashboard();}
  else if(path.endsWith('/validate')){if(!enabled){status=409;value={error:'promo_disabled'};}else if(body.code.trim().toUpperCase()!==code){status=400;value={error:'promo_invalid'};}else value={accepted:true};}
  else if(path==='/api/fund/orders'&&method==='POST'){
   expect(Object.keys(body).sort()).toEqual(['archive','code','orderId','preservationId']);
   expect(Object.keys(JSON.parse(body.archive)).sort()).toEqual(Object.keys(JSON.parse(archive)).sort());
   expect(JSON.stringify(body)).not.toMatch(/recoveryWords|seedPhrase|plaintextTree|familyName/);
   const row={preservationId:body.preservationId,orderId:body.orderId,promoRevision:revision,archiveSizeBytes:body.archive.length,archiveDigest:'b'.repeat(64),vaultId:'a'.repeat(32),estimatedRewardWinston:'2900000000',reservedRewardWinston:'3000000000',actualRewardWinston:'3000000000',arweaveTxId:tx,status:'COMPLETED',createdAt:Date.now(),uploadedAt:Date.now(),verifiedAt:Date.now()};rows.push(row);spent+=3000000000n;value={order:row};}
  else if(path.startsWith('/api/fund/orders/'))value={order:rows.find(x=>x.orderId===path.split('/').at(-1))};
  else {status=404;value={error:'not_found'};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.route('https://**/*',route=>route.abort());
 await page.goto('/#/admin');await page.getByLabel('Пароль',{exact:true}).fill(adminPassword);await page.getByRole('button',{name:'Войти'}).click();
 await page.getByRole('button',{name:'Free Preservation Fund'}).click();
 await page.getByLabel('Server admin credential').fill(adminPassword);await page.getByRole('button',{name:'Refresh balance and dashboard'}).click();
 await expect(page.getByText('13.000000 AR').first()).toBeVisible();
 await page.getByRole('button',{name:'Change promo code'}).click();await page.getByLabel('New promo code',{exact:true}).fill('TEST-PENSIONER');await page.getByLabel('Confirm new promo code').fill('TEST-PENSIONER');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'SAVE NEW CODE'}).click();await expect(page.getByText('TEST••••ER')).toBeVisible();
 await page.goto('/#/save');await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(archive)});
 await page.getByLabel('Promo code').fill('TEST-PENSIONER');await page.getByRole('button',{name:'Apply promo code'}).click();
 await expect(page.getByText(/Promo code accepted/)).toBeVisible();await page.getByRole('button',{name:'Preserve encrypted tree for free'}).click();
 await expect(page.getByText(/Verified and complete/)).toBeVisible();await expect(page.getByRole('button',{name:'Оплатить 0.03 SOL'})).toHaveCount(0);
 await page.reload();await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(archive)});
 await expect(page.getByText(/Verified and complete/)).toBeVisible();expect(rows).toHaveLength(1);
 await page.goto('/#/admin');await page.getByLabel('Пароль',{exact:true}).fill(adminPassword);await page.getByRole('button',{name:'Войти'}).click();await page.getByRole('button',{name:'Free Preservation Fund'}).click();
 await page.getByLabel('Server admin credential').fill(adminPassword);await page.getByRole('button',{name:'Refresh balance and dashboard'}).click();
 await expect(page.getByText('Saved trees 1')).toBeVisible();await mkdir('../../artifacts',{recursive:true});
 await page.screenshot({path:'../../artifacts/promo-funded-admin.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'../../artifacts/promo-funded-admin-mobile.png',fullPage:true});
 await expect(page.getByText('0.003000 AR',{exact:false}).first()).toBeVisible();await expect(page.getByRole('link',{name:/AAAAAAA/})).toBeVisible();
 await page.getByRole('button',{name:'Change promo code'}).click();await page.getByLabel('New promo code',{exact:true}).fill('TEST-PENSIONER-2');await page.getByLabel('Confirm new promo code').fill('TEST-PENSIONER-2');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'SAVE NEW CODE'}).click();
 await page.getByLabel('New cumulative limit (AR)').fill('26');await page.getByRole('button',{name:'UPDATE FUND LIMIT'}).click();
 await expect(page.getByText('26.000000 AR').first()).toBeVisible();await expect(page.getByText('Saved trees 1')).toBeVisible();
 const nextArchive=JSON.parse(archive);nextArchive.ciphertext='B'+nextArchive.ciphertext.slice(1);
 await page.goto('/#/save');await page.getByLabel('Зашифрованный архив для промокода').setInputFiles({name:'synthetic-2.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(nextArchive))});
 await page.getByLabel('Promo code').fill('TEST-PENSIONER');await page.getByRole('button',{name:'Apply promo code'}).click();await expect(page.getByText('Promo code is invalid.')).toBeVisible();
 await page.getByLabel('Promo code').fill('TEST-PENSIONER-2');await page.getByRole('button',{name:'Apply promo code'}).click();await expect(page.getByText(/Promo code accepted/)).toBeVisible();
});
