import { mkdir, writeFile, stat, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('../apps/web/node_modules/playwright');
const out = resolve('tumalas-apk-output');
await mkdir(out, { recursive: true });

const candidates = [
  'https://apkcombo.com/%D0%B6%D0%B5%D1%82%D1%96-%D0%B0%D1%82%D0%B0-%D1%88%D0%B5%D0%B6%D1%96%D1%80%D0%B5%D1%81%D1%96/fly.altynkundyz.zhetiatashejiresi/download/apk',
  'https://apkpure.net/%D0%B6%D0%B5%D1%82%D1%96-%D0%B0%D1%82%D0%B0-%D1%88%D0%B5%D0%B6%D1%96%D1%80%D0%B5%D1%81%D1%96/fly.altynkundyz.zhetiatashejiresi/download',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1400, height: 1000 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
});
const page = await context.newPage();
const logs = [];
const responses = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
page.on('response', r => {
  const ct = r.headers()['content-type'] || '';
  const cd = r.headers()['content-disposition'] || '';
  if (/apk|octet-stream|zip|download/i.test(`${r.url()} ${ct} ${cd}`)) responses.push({url:r.url(),status:r.status(),ct,cd});
});

let saved = null;
for (let i=0;i<candidates.length && !saved;i++) {
  const url=candidates[i];
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForTimeout(8000);
    await page.screenshot({path:resolve(out,`page-${i}.png`),fullPage:true});
    await writeFile(resolve(out,`page-${i}.html`),await page.content());
    const locators = [
      page.getByRole('link',{name:/download apk/i}),
      page.getByRole('button',{name:/download apk/i}),
      page.getByText(/download apk/i),
      page.locator('a[href*="download"],a[href*="apk"]'),
    ];
    for (const locator of locators) {
      const count=Math.min(await locator.count(),10);
      for(let j=0;j<count && !saved;j++){
        try{
          const el=locator.nth(j);
          const href=await el.getAttribute('href').catch(()=>null);
          logs.push(`[candidate] ${url} index=${j} href=${href}`);
          const downloadPromise=page.waitForEvent('download',{timeout:20000}).catch(()=>null);
          await el.click({force:true,timeout:10000});
          const download=await downloadPromise;
          if(download){
            const path=await download.path();
            const name=download.suggestedFilename() || `tumalas-${i}-${j}.apk`;
            const target=resolve(out,name.endsWith('.apk')?name:`${name}.apk`);
            if(path){await copyFile(path,target);saved=target;}
          }
          await page.waitForTimeout(3000);
        }catch(e){logs.push(`[click-error] ${e instanceof Error?e.message:String(e)}`)}
      }
    }
  }catch(e){logs.push(`[page-error] ${url}: ${e instanceof Error?e.stack||e.message:String(e)}`)}
}

await writeFile(resolve(out,'network-downloads.json'),JSON.stringify(responses,null,2));
await writeFile(resolve(out,'browser.log'),logs.join('\n'));
await context.close();
await browser.close();
console.log(JSON.stringify({saved,responses,logs:logs.slice(-30)},null,2));
