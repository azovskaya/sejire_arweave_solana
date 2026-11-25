import { expect } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
export const adminPassword = 'Synthetic server-admin credential 2026!';
export const treasuryAddress = 'A'.repeat(43);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function solAddress(byte) { let n = BigInt('0x' + Buffer.alloc(32, byte).toString('hex')), out = ''; for (; n; n /= 58n) out = alphabet[Number(n % 58n)] + out; return out; }
export const serviceRecipient = solAddress(31), fundRecipient = solAddress(32);
export const dashboard = () => ({
  promo: { enabled: true, displayHint: 'TEST••••26', revision: 1, createdAt: 1795580000000, updatedAt: 1795580000000 },
  treasuryAddress, signerVerified: true, limitWinston: '13000000000000', actualSpentWinston: '3000000000', reservedWinston: '0',
  budgetRemainingWinston: '12997000000000', walletBalanceWinston: '20000000000000', lastBalanceCheck: 1795580000000,
  currentQuoteWinston: '3000000000', currentQuoteBytes: 1024, effectiveAvailableWinston: '12997000000000', estimatedTreesRemaining: '4332',
  fundStatus: 'READY', successfulTrees: 1, today: 1, last7Days: 1, failedAttempts: 0, pending: 0, totalEncryptedBytes: 1024,
  averageArchiveBytes: 1024, largestArchiveBytes: 1024, smallestArchiveBytes: 1024, averageActualWinston: '3000000000',
  minActualWinston: '3000000000', maxActualWinston: '3000000000', latestActualWinston: '3000000000',
  currentRevisionTrees: 1, currentRevisionSpentWinston: '3000000000', lastReconciliation: null, history: [],
});
export const paidOverview = () => ({ schema: 'sejire/admin-paid-orders/v1', checkedAt: 1795580000000, configuredNetwork: 'mainnet-beta',
  policy: { serviceLamports: '30000000', serviceRecipient, fundRecipient, paymentEnabled: true, executionEnabled: true, maxArchiveBytes: 524288 },
  totals: [
    { network: 'mainnet-beta', totalOrders: 2, paymentConfirmed: 2, storageCompleted: 1, pending: 1, failed: 0, serviceLamports: '60000000', contributionLamports: '1000000' },
    { network: 'devnet', totalOrders: 1, paymentConfirmed: 1, storageCompleted: 1, pending: 0, failed: 0, serviceLamports: '30000000', contributionLamports: '9000000' },
  ],
  orders: [
    { id: 'a'.repeat(32), kind: 'preservation', network: 'mainnet-beta', createdAt: 1795580000000, updatedAt: 1795580000001,
      paymentStatus: 'confirmed', storageStatus: 'COMPLETED', serviceLamports: '30000000', contributionLamports: '0', signature: '2'.repeat(88), arweaveTxId: 'B'.repeat(43), archiveBytes: 1024, rewardWinston: '3000000000' },
    { id: 'b'.repeat(32), kind: 'preservation', network: 'devnet', createdAt: 1795580000000, updatedAt: 1795580000001,
      paymentStatus: 'confirmed', storageStatus: 'COMPLETED', serviceLamports: '30000000', contributionLamports: '0', signature: '3'.repeat(88) },
  ], hasMore: false, cursor: null,
});
export const topupsView = () => ({ schema: 'sejire/treasury-topups/v1', checkedAt: 1795580000000, minimumConfirmations: 12,
  treasuries: [{ address: treasuryAddress, revision: 0, ceilingWinston: null, heldWinston: '0', unobservedDebitWinston: '0' }],
  intents: [], hasMore: false, cursor: null });
export async function mockServerAdmin(page, options = {}) {
  const requests = [], blocked = [], origin = options.origin ?? 'http://127.0.0.1:5181';
  const state = { dashboard: dashboard(), paid: paidOverview(), topups: topupsView(), credential: options.credential ?? adminPassword,
    denied: false, overviewError: false, readbackMismatch: false, topupError: null, holdDashboard: null, holdPromo: null,
    prepareLostAck: false, confirmReadbackMismatch: false, transfers: new Map(), ...options };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      if (state.native && ['https://arweave.net', 'https://g8way.io'].includes(url.origin)) {
        expect(request.headers().authorization).toBeUndefined();
        if (url.pathname === '/info') return route.fulfill({ json: { network: 'arweave.N.1' } });
        if (url.pathname === `/price/0/${treasuryAddress}`) return route.fulfill({ body: '1000' });
        if (url.pathname === `/wallet/${state.native.owner}/balance`) return route.fulfill({ body: '900000000000000' });
        if (url.pathname === '/tx_anchor') return route.fulfill({ body: 'E'.repeat(64) });
        if (url.pathname === '/tx' && request.method() === 'POST') {
          const raw = request.postData();
          expect([...state.transfers.values()].some(transfer => transfer.signedTx === raw)).toBe(true);
          state.native.posts.push(raw);
          if (state.native.loseAck) return route.abort('connectionfailed');
          return route.fulfill({ status: 200, body: '' });
        }
      }
      blocked.push(url.origin); return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/admin-lock.json') return route.continue();
    requests.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
    if (url.pathname === '/admin-lock.json') return route.fulfill({ json: { configured: true, digest: 'public-verifier-must-not-authorize' } });
    const reply = (body, status = 200) => route.fulfill({ status, json: body });
    if (!url.pathname.startsWith('/api/fund/admin/')) return reply({ error: 'unmocked_test_api' }, 404);
    if (request.headers().authorization !== `Bearer ${state.credential}` || state.denied) return reply({ error: 'admin_unauthorized' }, 401);
    const suffix = url.pathname.slice('/api/fund/admin'.length);
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    if (suffix === '/dashboard') { if (state.holdDashboard) await state.holdDashboard; return reply(state.dashboard); }
    if (suffix === '/paid-orders') return state.overviewError ? reply({ error: 'provider_unavailable' }, 503) : reply(state.paid);
    if (suffix === '/solana-recipients') return reply({ schema: 'sejire/sol-recipients-admin/v1', serviceRecipient, fundRecipient,
      revision: 1, updatedAt: 1795580000000, source: 'admin', network: 'mainnet-beta', paymentEnabled: true, executionEnabled: true, contributionEnabled: true });
    if (suffix === '/treasury-topups') return reply(state.topups);
    const transferPath = /^\/treasury-topups\/([a-f0-9]{32})\/transfer(?:\/(claim|signed))?$/.exec(suffix);
    if (transferPath) {
      const id = transferPath[1], old = state.transfers.get(id) ?? null;
      if (!transferPath[2]) return reply({ transfer: old });
      if (transferPath[2] === 'claim') {
        if (old && (old.claimId !== body.claimId || old.unsignedTx !== body.unsignedTx)) return reply({ error: 'topup_transfer_conflict' }, 409);
        const transfer = old ?? { claimId: body.claimId, unsignedTx: body.unsignedTx, signedTx: null, txId: null };
        state.transfers.set(id, transfer); return reply({ transfer, reused: Boolean(old) });
      }
      if (!old || old.claimId !== body.claimId || old.signedTx && old.signedTx !== body.signedTx) return reply({ error: 'topup_transfer_conflict' }, 409);
      const transfer = { ...old, signedTx: body.signedTx, txId: JSON.parse(body.signedTx).id };
      state.transfers.set(id, transfer); return reply({ transfer, reused: Boolean(old.signedTx) });
    }
    if (suffix === '/promo') {
      if (state.holdPromo) await state.holdPromo;
      if (!state.readbackMismatch) {
        const code = body.code.trim().toUpperCase();
        state.dashboard.promo = { ...state.dashboard.promo, enabled: true, revision: state.dashboard.promo.revision + 1, displayHint: `${code.slice(0, 4)}••••${code.slice(-2)}` };
      }
      return reply({ ok: true });
    }
    if (suffix === '/enabled') { state.dashboard.promo.enabled = body.enabled; return reply({ ok: true }); }
    if (suffix === '/limit') {
      state.dashboard.limitWinston = (BigInt(body.limitAr) * 1_000_000_000_000n).toString(); return reply({ ok: true });
    }
    if (suffix === '/treasury-topups/prepare') {
      expect(Object.keys(body).sort()).toEqual(['address', 'amountWinston', 'expectedRevision', 'requestId']);
      if (state.topupError) return reply({ error: state.topupError }, 409);
      const treasury = state.topups.treasuries[0];
      let intent = state.topups.intents.find(row => row.id === body.requestId);
      if (!intent) {
        expect(body.expectedRevision).toBe(treasury.revision);
        intent = { id: body.requestId, address: body.address, amountWinston: body.amountWinston, status: 'prepared', baselineHeight: 123,
          transferTag: { name: 'SEJIRE-Topup-Intent', value: 'd'.repeat(64) },
          priorCeilingWinston: '20000000000000', preparedRevision: treasury.revision, createdAt: 1795580000000,
          txId: null, creditedWinston: null, creditedRevision: null, confirmedAt: null };
        state.topups.intents.unshift(intent); treasury.ceilingWinston = '20000000000000';
      }
      if (state.prepareLostAck) { state.prepareLostAck = false; return route.abort('connectionfailed'); }
      return reply({ intent, treasury });
    }
    if (/^\/treasury-topups\/[a-f0-9]{32}\/confirm$/.test(suffix)) {
      if (state.topupError) return reply({ error: state.topupError }, 409);
      const id = suffix.split('/')[2], treasury = state.topups.treasuries[0];
      const intent = state.topups.intents.find(row => row.id === id);
      expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'txId']);
      const reused = intent.status === 'credited';
      if (!reused) expect(body.expectedRevision).toBe(treasury.revision);
      const next = { ...intent, status: 'credited', txId: body.txId, creditedWinston: intent.amountWinston,
        creditedRevision: treasury.revision + (reused ? 0 : 1), confirmedAt: 1795580001000 };
      if (!state.confirmReadbackMismatch) { Object.assign(intent, next); if (!reused) { treasury.revision++; treasury.ceilingWinston = (BigInt(treasury.ceilingWinston) + BigInt(intent.amountWinston)).toString(); } }
      return reply({ intent: next, treasury, reused });
    }
    return reply({ error: 'not_found' }, 404);
  });
  return { requests, blocked, state };
}
export async function loginServerAdmin(page, pass = adminPassword) {
  await page.getByLabel('Пароль', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}
export async function openFundAdmin(page) {
  await page.getByRole('tab', { name: 'Промокод и фонд', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Пополнение фонда AR', exact: true })).toBeVisible();
}
let signer;
export async function installSyntheticWander(page) {
  if (!signer) {
    const Arweave = createRequire(import.meta.url)('arweave');
    const ar = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
    const jwk = generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' });
    signer = { ar, jwk, owner: await ar.wallets.jwkToAddress(jwk) };
  }
  await page.exposeFunction('__syntheticTopupSignature', async raw => {
    const tx = signer.ar.transactions.fromRaw(raw);
    tx.addTag('Signing-Client', 'Synthetic Wander'); tx.addTag('Signing-Client-Version', '1.0.0');
    await signer.ar.transactions.sign(tx, signer.jwk); return tx.toJSON();
  });
  await page.addInitScript(({ owner, publicKey }) => {
    window.__wanderCalls = { connect: 0, sign: 0 };
    window.arweaveWallet = {
      connect: async () => { window.__wanderCalls.connect++; }, getActiveAddress: async () => owner, getActivePublicKey: async () => publicKey,
      sign: async tx => { window.__wanderCalls.sign++; return window.__syntheticTopupSignature(tx.toJSON()); },
    };
  }, { owner: signer.owner, publicKey: signer.jwk.n });
  return { owner: signer.owner, posts: [], loseAck: false };
}
