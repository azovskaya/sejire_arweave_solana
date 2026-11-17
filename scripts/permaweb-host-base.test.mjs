import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile('apps/web/index.html', 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inline.length, 1, 'the actual entry contains one portable-base script');
const id = 'C'.repeat(43);

for (const [url, expected] of [
  ['https://sejire.ar.io/unknown/deep/route', '/'],
  [`https://sejire.ar.io/${id}/unknown/deep/route`, '/'],
  [`https://sejire.arweave.net/${id}/unknown/deep/route`, '/'],
  [`https://arweave.net/${id}/unknown/deep/route`, `/${id}/`],
  [`https://${'a'.repeat(52)}.arweave.net/${id}/unknown/deep/route`, `/${id}/`],
  [`https://turbo-gateway.com/${id}`, `/${id}/`],
  [`https://${'a'.repeat(52)}.turbo-gateway.com/${id}/unknown/deep/route`, `/${id}/`],
  [`https://another-gateway.example/${id}/unknown/deep/route`, `/${id}/`],
  ['https://azovskaya.github.io/sejire_arweave_solana/', null],
  ['http://127.0.0.1:5193/local/subdirectory/', null],
]) test(`entry keeps the correct asset and recovery root at ${url}`, () => {
  const location = new URL(url), bases = [];
  const document = {
    createElement(name) {
      assert.equal(name, 'base');
      return { setAttribute(key, value) { assert.equal(key, 'href'); this.href = value; } };
    },
    head: { appendChild(element) { bases.push(element.href); } },
  };
  runInNewContext(inline[0][1], { location, document });
  assert.deepEqual(bases, expected === null ? [] : [expected]);
  if (expected !== null) {
    const base = new URL(expected, url);
    assert.equal(new URL('./assets/app.js', base).pathname, expected + 'assets/app.js');
    assert.equal(new URL('./recovery/recovery.html', base).pathname, expected + 'recovery/recovery.html');
  }
});
