import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_BROWSER_ENV, webProfile, webDefines } from './web-profile.mjs';

test('fresh/default builds select Arweave-only; historical mode requires explicit false', () => {
  for (const mode of [undefined, '', 'true']) assert.equal(webProfile(mode), 'decentralized-direct-arweave');
  assert.equal(webProfile('false'), 'legacy');
  for (const mode of ['0', '1', 'FALSE', 'TRUE', 'arweave', null, false]) assert.throws(() => webProfile(mode), /invalid_web_profile/);
});

test('public dev/build definitions remove stale service and payment configuration', () => {
  for (const mode of [undefined, '', 'true']) {
    const defines = webDefines(mode);
    for (const key of ['VITE_FUND_API_URL', 'VITE_CHECKOUT_API_URL', 'VITE_SPONSOR_API_URL', 'VITE_SPONSOR_URL', 'VITE_SEJIRE_FACTORY_ID']) {
      assert.equal(JSON.parse(defines[`import.meta.env.${key}`]), '');
    }
    for (const key of ['VITE_PORTABLE_FUNDED', 'VITE_CHECKOUT_ENABLED', 'VITE_NATIVE_SOL_MAINNET', 'VITE_PRESERVATION_V2_ENABLED', 'VITE_QA_TOOLS']) {
      assert.equal(JSON.parse(defines[`import.meta.env.${key}`]), '0');
    }
    assert.equal(JSON.parse(defines['import.meta.env.VITE_DECENTRALIZED_MODE']), 'true');
    assert.equal(JSON.parse(defines['import.meta.env.VITE_PUBLISH_MODE']), 'arweave');
  }
  assert.ok(Object.isFrozen(DIRECT_BROWSER_ENV));
  assert.deepEqual(webDefines('false'), { 'import.meta.env.VITE_DECENTRALIZED_MODE': '"false"' });
});
