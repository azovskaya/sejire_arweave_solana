import { checkoutApi, type CheckoutApiEnv } from './checkout/api';
export { CheckoutLedger } from './checkout/durableStore';
/**
 * SEJIRE sponsor edge — Cloudflare Worker cashier.
 *
 * Responsibilities:
 *  - Create payment sessions (mock or Kaspi Pay Business)
 *  - Verify payment and upload sealed vault envelopes via Turbo (treasury)
 *  - NEVER accept or handle BIP-39 mnemonics / plaintext trees
 *
 * Owner keys live in /admin (KV). Optional env fallbacks:
 *  - SETUP_PIN             (claim-guard for first visit)
 *  - TURBO_JWK / ADMIN_TOKEN / KASPI_MERCHANT_TOKEN (legacy wrangler secrets)
 */
import { adminPageHtml } from "./adminPage";
import {
  adminNeedsSetup,
  authorizeAdmin,
  hashAdminPassword,
  passwordTooShort,
  setupPinMatches,
  setupPinRequired,
} from "./adminAuth";
import { cashierGuardError } from "./cashierGuard";
import { assertSafeEnvelope, envelopeByteLength } from "./envelope";
import { mapKaspiStatus, verifyKaspiWebhook } from "./kaspi";
import {
  kvOpsStore,
  memoryOpsStore,
  recordPaid,
  recordSaved,
  toPublicOps,
  type OpsStore,
} from "./opsLedger";
import {
  applySecretPatch,
  assertJwkJson,
  deriveTreasuryAddress,
  generateTreasuryJwk,
  kvBound,
  loadOpsSecrets,
  mergeRuntime,
  randomOpsSalt,
  redactSecrets,
  runtimeOpsSalt,
  saveOpsSecrets,
  type StoredOpsSecrets,
} from "./opsSecrets";
import {
  assertSessionPaid,
  createCheckoutSession,
  markSessionPaid,
  syncKaspiSession,
  type KaspiRuntime,
} from "./payments";
import {
  findSessionByOrderId,
  kvSessionStore,
  memorySessionStore,
  type PaymentSession,
  type SessionStore,
} from "./sessions";
import { uploadEnvelope } from "./upload";

export interface Env extends CheckoutApiEnv {
  KASPI_MERCHANT_TOKEN?: string;
  TURBO_JWK?: string;
  SITE_JWK?: string;
  PAYMENT_PROVIDER: string;
  PUBLISH_PRICE_MINOR: string;
  PUBLISH_CURRENCY: string;
  /** @deprecated use PUBLISH_PRICE_MINOR */
  PUBLISH_PRICE_USD?: string;
  MAX_ENVELOPE_BYTES: string;
  APP_ORIGIN: string;
  IDEMPOTENCY?: KVNamespace;
  KASPI_API_BASE?: string;
  KASPI_TRADE_POINT_ID?: string;
  /** Legacy wrangler secret — admin password in KV is preferred. */
  ADMIN_TOKEN?: string;
  /** Optional HMAC salt for ops uniqueness; falls back to stored opsSalt. */
  OPS_SALT?: string;
  /** Public Arweave address of the treasury (safe to show in admin). */
  TREASURY_ADDRESS?: string;
  /** If set, first /admin setup must include this PIN. */
  SETUP_PIN?: string;
}

type Json = Record<string, unknown>;

function allowedOrigin(env: Env, request: Request): string {
  const reqOrigin = request.headers.get("Origin") || "";
  const list = (env.APP_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) return reqOrigin || "*";
  if (reqOrigin && list.includes(reqOrigin)) return reqOrigin;
  return list[0] || "*";
}

function cors(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

function json(origin: string, status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: cors(origin),
  });
}

function priceMinor(env: Env): number {
  if (env.PUBLISH_PRICE_MINOR) return Number(env.PUBLISH_PRICE_MINOR);
  if (env.PUBLISH_PRICE_USD) return Number(env.PUBLISH_PRICE_USD);
  return 1500;
}

const memorySessions = memorySessionStore();
const memoryOps = memoryOpsStore();

function getStore(env: Env): SessionStore {
  if (env.IDEMPOTENCY) {
    return kvSessionStore(env.IDEMPOTENCY);
  }
  return memorySessions;
}

function getOps(env: Env): OpsStore {
  if (env.IDEMPOTENCY) {
    return kvOpsStore(env.IDEMPOTENCY);
  }
  return memoryOps;
}

async function notePaid(env: Env, secrets: StoredOpsSecrets, session: PaymentSession) {
  await recordPaid(getOps(env), runtimeOpsSalt(env, secrets), {
    sessionId: session.id,
    amountMinor: session.amountMinor,
    currency: session.currency,
    provider: session.provider,
    at: session.paidAt ?? Date.now(),
  });
}

async function noteSaved(env: Env, secrets: StoredOpsSecrets, session: PaymentSession, vaultId: string) {
  await recordSaved(getOps(env), runtimeOpsSalt(env, secrets), {
    sessionId: session.id,
    vaultId,
  });
}

function kaspiRuntime(
  env: Env,
  urls?: { successUrl?: string; cancelUrl?: string },
): KaspiRuntime | undefined {
  const apiKey = env.KASPI_MERCHANT_TOKEN;
  if (!apiKey) return undefined;
  return {
    apiBase: env.KASPI_API_BASE || "https://pay.kaspi.kz/api/v2",
    apiKey,
    tradePointId: env.KASPI_TRADE_POINT_ID,
    description: "SEJIRE — вечный сейф на Arweave",
    returnUrl: urls?.successUrl,
    failUrl: urls?.cancelUrl,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* empty */
  }
  return {};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const checkout = await checkoutApi(request, env);
    if (checkout) return checkout;
    const secrets = await loadOpsSecrets(env);
    const rt = mergeRuntime(env, secrets);
    const origin = allowedOrigin(rt, request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    const store = getStore(rt);

    try {
      if (url.pathname === "/v1/health" && request.method === "GET") {
        return json(origin, 200, {
          ok: true,
          service: "sejire-sponsor",
          provider: (rt.PAYMENT_PROVIDER || "mock").toLowerCase(),
          currency: rt.PUBLISH_CURRENCY || "KZT",
          priceMinor: priceMinor(rt),
          kaspiReady: Boolean(rt.KASPI_MERCHANT_TOKEN),
          treasuryReady: Boolean(rt.TURBO_JWK),
        });
      }
      if (url.pathname === "/v1/checkout" && request.method === "POST") {
        return createCheckout(request, rt, secrets, store, origin);
      }
      if (url.pathname === "/v1/mock-pay" && request.method === "POST") {
        return mockPay(request, rt, secrets, store, origin);
      }
      if (url.pathname === "/v1/publish" && request.method === "POST") {
        return publishEnvelope(request, rt, secrets, store, origin);
      }
      if (url.pathname === "/v1/session" && request.method === "GET") {
        return readSession(url, rt, secrets, store, origin);
      }
      if (url.pathname === "/v1/kaspi-webhook" && request.method === "POST") {
        return kaspiWebhook(request, rt, secrets, store, origin);
      }
      if ((url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET") {
        return new Response(adminPageHtml(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
          },
        });
      }
      if (url.pathname === "/v1/admin/status" && request.method === "GET") {
        return json(origin, 200, {
          ok: true,
          needsSetup: adminNeedsSetup(env, secrets),
          pinRequired: setupPinRequired(env),
          kvBound: kvBound(env),
        });
      }
      if (url.pathname === "/v1/admin/setup" && request.method === "POST") {
        return adminSetup(request, env, secrets, origin);
      }
      if (url.pathname === "/v1/admin/overview" && request.method === "GET") {
        return adminOverview(request, rt, secrets, origin);
      }
      if (url.pathname === "/v1/admin/keys" && request.method === "GET") {
        return adminGetKeys(request, rt, secrets, origin);
      }
      if (url.pathname === "/v1/admin/keys" && request.method === "PUT") {
        return adminPutKeys(request, env, secrets, origin);
      }
      if (url.pathname === "/v1/admin/treasury/generate" && request.method === "POST") {
        return adminGenerateTreasury(request, env, secrets, origin);
      }
      if (url.pathname === "/v1/admin/password" && request.method === "POST") {
        return adminPassword(request, env, secrets, origin);
      }
      return json(origin, 404, { ok: false, error: "not_found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status =
        msg === "session_not_found" ||
        msg === "not_paid" ||
        msg === "forbidden_field" ||
        msg === "missing_vault_id" ||
        msg === "vault_mismatch"
          ? 400
          : msg === "envelope_too_large"
            ? 413
            : msg === "mock_forbidden_with_treasury" || msg === "kv_required"
              ? 503
              : 500;
      return json(origin, status, { ok: false, error: msg });
    }
  },
};

async function gated(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response | null> {
  const auth = await authorizeAdmin(request, env, secrets);
  if (auth === "off") return json(origin, 503, { ok: false, error: "admin_off" });
  if (auth !== "ok") return json(origin, 401, { ok: false, error: "unauthorized" });
  return null;
}

async function createCheckout(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  store: SessionStore,
  origin: string,
): Promise<Response> {
  const blocked = cashierGuardError(env);
  if (blocked) return json(origin, blocked.status, { ok: false, error: blocked.error });

  let body: { successUrl?: string; cancelUrl?: string; vaultId?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const vaultId = (body.vaultId || "").trim();
  if (vaultId.length < 8) {
    return json(origin, 400, { ok: false, error: "missing_vault_id" });
  }

  const provider = (env.PAYMENT_PROVIDER || "mock").toLowerCase();
  try {
    const result = await createCheckoutSession(store, {
      provider,
      amountMinor: priceMinor(env),
      currency: env.PUBLISH_CURRENCY || "KZT",
      vaultId,
      kaspiMerchantToken: env.KASPI_MERCHANT_TOKEN,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      kaspi: kaspiRuntime(env, body),
    });
    return json(origin, 200, { ok: true, ...result });
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    const status = code.includes("not_configured") || code.includes("not_wired") ? 501 : 400;
    return json(origin, status, {
      ok: false,
      error: code,
      hint:
        code === "kaspi_merchant_not_configured"
          ? "Нужен ИП/ТОО + Kaspi для бизнеса; до этого PAYMENT_PROVIDER=mock"
          : undefined,
      priceMinor: priceMinor(env),
      currency: env.PUBLISH_CURRENCY || "KZT",
    });
  }
}

async function mockPay(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  store: SessionStore,
  origin: string,
): Promise<Response> {
  const blocked = cashierGuardError(env);
  if (blocked) return json(origin, blocked.status, { ok: false, error: blocked.error });
  if ((env.PAYMENT_PROVIDER || "mock").toLowerCase() !== "mock") {
    return json(origin, 403, { ok: false, error: "mock_pay_disabled" });
  }
  const body = (await request.json()) as { sessionId?: string };
  if (!body.sessionId) {
    return json(origin, 400, { ok: false, error: "missing_session" });
  }
  const session = await markSessionPaid(store, body.sessionId, {
    allowMock: true,
    provider: "mock",
  });
  await notePaid(env, secrets, session);
  return json(origin, 200, {
    ok: true,
    sessionId: session.id,
    status: session.status,
  });
}

async function publishEnvelope(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  store: SessionStore,
  origin: string,
): Promise<Response> {
  const body = (await request.json()) as {
    sessionId?: string;
    /** @deprecated Stripe-era alias */
    stripeSessionId?: string;
    envelope?: unknown;
    /** Previous vault TX (same Vault-Id) — optional chain link. */
    parentTxId?: string | null;
  };

  const sessionId = body.sessionId || body.stripeSessionId;
  if (!sessionId || !body.envelope) {
    return json(origin, 400, { ok: false, error: "missing_fields" });
  }

  let envelope;
  try {
    envelope = assertSafeEnvelope(body.envelope);
  } catch (e) {
    return json(origin, 400, {
      ok: false,
      error: e instanceof Error ? e.message : "invalid_envelope",
    });
  }

  const maxBytes = Number(env.MAX_ENVELOPE_BYTES || "524288");
  if (envelopeByteLength(envelope) > maxBytes) {
    return json(origin, 413, { ok: false, error: "envelope_too_large" });
  }

  const blocked = cashierGuardError(env);
  if (blocked) return json(origin, blocked.status, { ok: false, error: blocked.error });

  const amount = priceMinor(env);
  const kaspi = kaspiRuntime(env);
  if (kaspi) {
    await syncKaspiSession(store, sessionId, kaspi).catch(() => undefined);
  }
  const session = await assertSessionPaid(store, sessionId, amount, envelope.vault_id);
  await notePaid(env, secrets, session);
  if (session.txId) {
    return json(origin, 200, { ok: true, txId: session.txId, idempotent: true });
  }

  const provider = (env.PAYMENT_PROVIDER || "mock").toLowerCase();
  const uploaded = await uploadEnvelope(envelope, {
    turboJwk: env.TURBO_JWK,
    allowMockUpload: provider === "mock",
    parentTxId: body.parentTxId ?? null,
    updatedAt: new Date().toISOString(),
  });

  const next = {
    ...session,
    status: "consumed" as const,
    txId: uploaded.txId,
  };
  await store.put(next);
  await noteSaved(env, secrets, next, String(envelope.vault_id));

  return json(origin, 200, {
    ok: true,
    txId: uploaded.txId,
    mock: uploaded.mock,
    vaultId: envelope.vault_id,
  });
}

async function readSession(
  url: URL,
  env: Env,
  secrets: StoredOpsSecrets,
  store: SessionStore,
  origin: string,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId") || "";
  if (!sessionId) return json(origin, 400, { ok: false, error: "missing_session" });
  const kaspi = kaspiRuntime(env);
  if (kaspi) {
    await syncKaspiSession(store, sessionId, kaspi).catch(() => undefined);
  }
  const session = await store.get(sessionId);
  if (!session) return json(origin, 404, { ok: false, error: "session_not_found" });
  if (session.status === "paid" || session.status === "consumed") {
    await notePaid(env, secrets, session);
  }
  return json(origin, 200, {
    ok: true,
    sessionId: session.id,
    status: session.status,
    provider: session.provider,
    paid: session.status === "paid" || session.status === "consumed",
  });
}

async function kaspiWebhook(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  store: SessionStore,
  origin: string,
): Promise<Response> {
  const token = env.KASPI_MERCHANT_TOKEN;
  if (!token) return json(origin, 503, { ok: false, error: "kaspi_merchant_not_configured" });
  const blocked = cashierGuardError(env);
  if (blocked) return json(origin, blocked.status, { ok: false, error: blocked.error });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(origin, 400, { ok: false, error: "invalid_json" });
  }
  const okSig = await verifyKaspiWebhook(body, token);
  if (!okSig) return json(origin, 400, { ok: false, error: "bad_webhook_signature" });
  const orderId = String(body.orderId || body.order_id || "");
  if (!orderId) return json(origin, 400, { ok: false, error: "missing_order" });
  const session = await findSessionByOrderId(store, orderId);
  if (!session) return json(origin, 404, { ok: false, error: "session_not_found" });
  if (body.amount != null && Math.round(Number(body.amount)) !== session.amountMinor) {
    return json(origin, 400, { ok: false, error: "amount_mismatch" });
  }
  if (mapKaspiStatus(body.status) === "paid") {
    const paid = await markSessionPaid(store, session.id, { allowMock: false, provider: "kaspi" });
    await notePaid(env, secrets, paid);
  } else {
    const kaspi = kaspiRuntime(env);
    if (kaspi) {
      await syncKaspiSession(store, session.id, kaspi).catch(() => undefined);
    }
  }
  return json(origin, 200, { ok: true, received: true });
}

async function adminOverview(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  const deny = await gated(request, env, secrets, origin);
  if (deny) return deny;
  const state = await getOps(env).load();
  const pub = toPublicOps(state, env.PUBLISH_CURRENCY || "KZT");
  const address =
    (await deriveTreasuryAddress(env.TURBO_JWK)) || (env.TREASURY_ADDRESS || "").trim() || null;
  return json(origin, 200, {
    ok: true,
    ...pub,
    kaspiReady: Boolean(env.KASPI_MERCHANT_TOKEN),
    treasuryReady: Boolean(env.TURBO_JWK),
    treasuryAddress: address,
    provider: (env.PAYMENT_PROVIDER || "mock").toLowerCase(),
  });
}

async function adminSetup(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  if (!adminNeedsSetup(env, secrets)) {
    return json(origin, 409, { ok: false, error: "already_setup" });
  }
  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (passwordTooShort(password)) {
    return json(origin, 400, { ok: false, error: "password_too_short" });
  }
  if (!setupPinMatches(env, pin)) {
    return json(origin, 403, { ok: false, error: "bad_pin" });
  }
  const next: StoredOpsSecrets = {
    ...secrets,
    passwordHash: await hashAdminPassword(password),
    opsSalt: secrets.opsSalt || randomOpsSalt(),
  };
  await saveOpsSecrets(env, next);
  return json(origin, 200, { ok: true, persisted: kvBound(env) });
}

async function adminGetKeys(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  const deny = await gated(request, env, secrets, origin);
  if (deny) return deny;
  const redacted = await redactSecrets(env, secrets);
  const dumped = JSON.stringify(redacted);
  if (secrets.turboJwk && dumped.includes(secrets.turboJwk)) {
    return json(origin, 500, { ok: false, error: "redact_failed" });
  }
  return json(origin, 200, { ok: true, ...redacted });
}

async function adminPutKeys(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  const deny = await gated(request, env, secrets, origin);
  if (deny) return deny;
  const patch = await readJson(request);
  const next = applySecretPatch(secrets, patch);
  if (next.turboJwk && next.turboJwk !== secrets.turboJwk) {
    try {
      assertJwkJson(next.turboJwk, "turbo_jwk");
    } catch (e) {
      return json(origin, 400, { ok: false, error: e instanceof Error ? e.message : "turbo_jwk_invalid" });
    }
  }
  if (next.siteJwk && next.siteJwk !== secrets.siteJwk) {
    try {
      assertJwkJson(next.siteJwk, "site_jwk");
    } catch (e) {
      return json(origin, 400, { ok: false, error: e instanceof Error ? e.message : "site_jwk_invalid" });
    }
  }
  if (!next.opsSalt) next.opsSalt = randomOpsSalt();
  await saveOpsSecrets(env, next);
  const redacted = await redactSecrets(mergeRuntime(env, next), next);
  return json(origin, 200, { ok: true, ...redacted });
}

async function adminGenerateTreasury(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  const deny = await gated(request, env, secrets, origin);
  if (deny) return deny;
  const body = await readJson(request);
  if ((secrets.turboJwk || env.TURBO_JWK) && body.replace !== true) {
    return json(origin, 409, { ok: false, error: "treasury_exists" });
  }
  const generated = await generateTreasuryJwk();
  const next: StoredOpsSecrets = {
    ...secrets,
    turboJwk: generated.jwk,
    opsSalt: secrets.opsSalt || randomOpsSalt(),
  };
  await saveOpsSecrets(env, next);
  return json(origin, 200, {
    ok: true,
    address: generated.address,
    jwk: generated.jwk,
    persisted: kvBound(env),
  });
}

async function adminPassword(
  request: Request,
  env: Env,
  secrets: StoredOpsSecrets,
  origin: string,
): Promise<Response> {
  const deny = await gated(request, env, secrets, origin);
  if (deny) return deny;
  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (passwordTooShort(password)) {
    return json(origin, 400, { ok: false, error: "password_too_short" });
  }
  const next: StoredOpsSecrets = {
    ...secrets,
    passwordHash: await hashAdminPassword(password),
    opsSalt: secrets.opsSalt || randomOpsSalt(),
  };
  await saveOpsSecrets(env, next);
  return json(origin, 200, { ok: true });
}
