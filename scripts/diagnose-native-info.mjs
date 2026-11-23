// Read-only diagnosis of one public native endpoint. Not release acceptance.
const url = 'https://arweave.net/info';
async function probe(redirect) {
  let response;
  try {
    response = await fetch(url, {
      redirect, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(8000), headers: { Origin: 'https://sejire.ar.io' },
    });
    console.log(JSON.stringify({ redirect, status: response.status, url: response.url,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      cors: response.headers.get('access-control-allow-origin') }));
  } catch (error) {
    console.log(JSON.stringify({ redirect, error: error?.name, message: error?.message,
      causeName: error?.cause?.name, causeMessage: error?.cause?.message, causeCode: error?.cause?.code }));
  } finally { await response?.body?.cancel().catch(() => {}); }
}
console.log(JSON.stringify({ scope: 'Read-only public native /info diagnostic; no wallet, upload, payment or release acceptance', checkedAt: new Date().toISOString(), node: process.version }));
await probe('error');
await probe('manual');
