// Read-only diagnosis of one public native endpoint. Not release acceptance.
async function probe(redirect, path = '/info', method = 'GET') {
  const url = 'https://arweave.net' + path;
  let response;
  try {
    response = await fetch(url, {
      method, redirect, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(8000), headers: method === 'OPTIONS'
        ? { Origin: 'https://sejire.ar.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
        : { Origin: 'https://sejire.ar.io' },
    });
    console.log(JSON.stringify({ path, method, redirect, status: response.status, url: response.url,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      cors: response.headers.get('access-control-allow-origin') }));
  } catch (error) {
    console.log(JSON.stringify({ path, method, redirect, error: error?.name, message: error?.message,
      causeName: error?.cause?.name, causeMessage: error?.cause?.message, causeCode: error?.cause?.code }));
  } finally { await response?.body?.cancel().catch(() => {}); }
}
console.log(JSON.stringify({ scope: 'Read-only public native /info diagnostic; no wallet, upload, payment or release acceptance', checkedAt: new Date().toISOString(), node: process.version }));
await Promise.all([['/info', 'GET'], ['/tx_anchor', 'GET'], ['/price/25269', 'GET'], ['/tx', 'OPTIONS'], ['/chunk', 'OPTIONS']].map(([path, method]) => probe('error', path, method)));
await probe('error');
await probe('manual');
