import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('../apps/web/node_modules/playwright');

const out = resolve('tumalas-output');
await mkdir(out, { recursive: true });
await mkdir(resolve(out, 'responses'), { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1200 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36 SEJIRE-research/1.0',
  locale: 'kk-KZ',
  recordHar: { path: resolve(out, 'tumalas.har.zip'), mode: 'full', content: 'embed' },
});
const page = await context.newPage();
const network = [];
const consoleLines = [];
const bodyJobs = [];
let responseIndex = 0;

page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', error => consoleLines.push(`[pageerror] ${error.stack || error.message}`));
page.on('requestfailed', request => network.push({
  type: 'requestfailed',
  url: request.url(),
  method: request.method(),
  resourceType: request.resourceType(),
  error: request.failure()?.errorText || null,
}));
page.on('response', response => {
  const request = response.request();
  const headers = response.headers();
  const item = {
    index: responseIndex++,
    url: response.url(),
    status: response.status(),
    method: request.method(),
    resourceType: request.resourceType(),
    contentType: headers['content-type'] || '',
  };
  network.push(item);
  const interesting = /tumalas|altynkundyz|shejire|genealog|api/i.test(item.url) ||
    /json|javascript|text|xml|octet-stream/i.test(item.contentType);
  if (!interesting) return;
  bodyJobs.push((async () => {
    try {
      const body = await response.body();
      if (body.length > 15_000_000) return;
      const hash = createHash('sha1').update(item.url).digest('hex').slice(0, 12);
      const ext = item.contentType.includes('json') ? '.json'
        : item.contentType.includes('javascript') ? '.js'
        : item.contentType.includes('html') ? '.html'
        : item.contentType.includes('css') ? '.css'
        : '.bin';
      const filename = `${String(item.index).padStart(4, '0')}-${hash}${ext}`;
      await writeFile(resolve(out, 'responses', filename), body);
      item.savedAs = `responses/${filename}`;
      item.bytes = body.length;
    } catch (error) {
      item.bodyError = error instanceof Error ? error.message : String(error);
    }
  })());
});

async function snapshot(name) {
  await page.waitForTimeout(1200);
  const data = await page.evaluate(() => {
    const compact = value => {
      try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
    };
    const all = [...document.querySelectorAll('*')];
    const candidates = all.map((el, index) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const clickable = el.matches('a,button,input,[role="button"],[onclick],svg text,svg g,svg circle') ||
        style.cursor === 'pointer' || el.tabIndex >= 0;
      if (!clickable && !['svg','text','circle'].includes(el.tagName.toLowerCase())) return null;
      return {
        index,
        tag: el.tagName,
        text,
        id: el.id || null,
        className: typeof el.className === 'string' ? el.className : el.getAttribute('class'),
        role: el.getAttribute('role'),
        href: el.getAttribute('href'),
        data: Object.fromEntries([...el.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        display: style.display,
        visibility: style.visibility,
        cursor: style.cursor,
      };
    }).filter(Boolean).slice(0, 3000);
    const globals = Object.keys(window).filter(k => /tree|graph|node|data|family|genealog|tumalas|mobi|shejire/i.test(k)).slice(0, 500);
    const globalValues = {};
    for (const key of globals) {
      try {
        const value = window[key];
        if (value == null || ['string','number','boolean'].includes(typeof value)) globalValues[key] = value;
        else if (Array.isArray(value) && value.length < 5000) globalValues[key] = compact(value);
        else if (typeof value === 'object') {
          const keys = Object.keys(value).slice(0, 100);
          globalValues[key] = { type: value?.constructor?.name || 'Object', keys };
        }
      } catch {}
    }
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 500_000),
      html: document.documentElement.outerHTML,
      scripts: [...document.scripts].map(s => ({ src: s.src, type: s.type, text: s.src ? '' : (s.textContent || '').slice(0, 100_000) })),
      links: [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.textContent || '').trim(), href: a.href })).slice(0, 2000),
      candidates,
      localStorage: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
      sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])),
      globals,
      globalValues,
    };
  });
  await writeFile(resolve(out, `${name}.json`), JSON.stringify({ ...data, html: undefined }, null, 2));
  await writeFile(resolve(out, `${name}.html`), data.html);
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
}

async function tryClick(label, name) {
  const exact = page.getByText(label, { exact: true });
  const count = await exact.count();
  if (!count) return { label, clicked: false, reason: 'not-found' };
  for (let i = 0; i < count; i++) {
    try {
      const locator = exact.nth(i);
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 5000, force: true });
      await page.waitForTimeout(2500);
      await snapshot(name);
      return { label, clicked: true, index: i, url: page.url() };
    } catch (error) {
      if (i === count - 1) return { label, clicked: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

const actions = [];
try {
  const response = await page.goto('https://tumalas.kz/mobi/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  actions.push({ action: 'goto', status: response?.status() || null, url: page.url() });
  await page.waitForTimeout(10_000);
  await snapshot('00-root');

  // Click the root if it is an interactive node, then capture each visible top-level branch from a fresh load.
  actions.push(await tryClick('Алаш', '01-after-alash'));
  for (const [index, label] of ['Ұлы жүз', 'Орта жүз', 'Кіші жүз', 'Жүзден тыс'].entries()) {
    await page.goto('https://tumalas.kz/mobi/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3500);
    const root = page.getByText('Алаш', { exact: true });
    if (await root.count()) {
      try { await root.first().click({ force: true, timeout: 5000 }); await page.waitForTimeout(1500); } catch {}
    }
    actions.push(await tryClick(label, `${String(index + 2).padStart(2, '0')}-${label.replace(/\s+/g, '-')}`));
  }
} catch (error) {
  actions.push({ action: 'fatal', error: error instanceof Error ? error.stack || error.message : String(error) });
}

await Promise.allSettled(bodyJobs);
await writeFile(resolve(out, 'network.json'), JSON.stringify(network, null, 2));
await writeFile(resolve(out, 'console.log'), consoleLines.join('\n'));
await writeFile(resolve(out, 'actions.json'), JSON.stringify(actions, null, 2));
await context.close();
await browser.close();
console.log(JSON.stringify({ actions, responses: network.length, savedBodies: network.filter(x => x.savedAs).length }, null, 2));
