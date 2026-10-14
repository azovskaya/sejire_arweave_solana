import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = resolve('tumalas-proxy-output');
await mkdir(out, { recursive: true });

const target = id => `https://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get&id=${id}&nodeid=14`;
const ancestors = id => `https://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_mobile_get_ancestors&id=${id}`;
const encoded = value => encodeURIComponent(value);

const paths = id => [
  { name: 'direct-https', url: target(id) },
  { name: 'direct-http', url: target(id).replace('https://', 'http://') },
  { name: 'jina-http', url: `https://r.jina.ai/http://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get%26id=${id}%26nodeid=14` },
  { name: 'jina-https', url: `https://r.jina.ai/https://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get%26id=${id}%26nodeid=14` },
  { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encoded(target(id))}` },
  { name: 'corsproxy', url: `https://corsproxy.io/?url=${encoded(target(id))}` },
  { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${encoded(target(id))}` },
  { name: 'translate', url: `https://tumalas-kz.translate.goog/wp-admin/admin-ajax.php?action=tuma_cached_childnew_get&id=${id}&nodeid=14&_x_tr_sl=kk&_x_tr_tl=en&_x_tr_hl=en` },
  { name: 'googleweblight', url: `https://googleweblight.com/i?u=${encoded(target(id))}` },
];

const results = [];
for (const id of ['14', '1', '2', '3', '4']) {
  for (const item of paths(id)) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(item.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
          accept: 'application/json,text/plain,*/*',
          referer: 'https://tumalas.kz/mobi/',
          origin: 'https://tumalas.kz',
        },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const safe = item.name.replace(/[^a-z0-9_-]+/gi, '-');
      await writeFile(resolve(out, `${id}-${safe}.txt`), bytes);
      results.push({ id, ...item, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type'), bytes: bytes.length, jsonType: Array.isArray(json) ? 'array' : json && typeof json, jsonLength: Array.isArray(json) ? json.length : null, preview: text.slice(0, 500), ms: Date.now() - started });
    } catch (error) {
      results.push({ id, ...item, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    } finally { clearTimeout(timer); }
  }
}

for (const id of ['14', '1', '2', '3', '4']) {
  const url = `https://r.jina.ai/http://tumalas.kz/wp-admin/admin-ajax.php?action=tuma_mobile_get_ancestors%26id=${id}`;
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await response.text();
    await writeFile(resolve(out, `${id}-ancestors-jina.txt`), text);
    results.push({ id, name: 'ancestors-jina', url, status: response.status, bytes: text.length, preview: text.slice(0, 500) });
  } catch (error) { results.push({ id, name: 'ancestors-jina', error: String(error) }); }
}

await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
