import {
  ARWEAVE_HOSTS,
  DATA_GATEWAYS,
  GATEWAY_DOWN_RU,
  GRAPHQL_ENDPOINTS,
  GatewayUnavailableError,
  RawEnvelopeMismatchError,
  fetchTxJson,
  graphqlQuery,
  isGatewayUnavailable,
} from "./gateways";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(GRAPHQL_ENDPOINTS.length >= 3, "graphql fallbacks");
assert(GRAPHQL_ENDPOINTS[0].includes("arweave.net"), "primary graphql");
assert(GRAPHQL_ENDPOINTS.some((u) => u.includes("goldsky")), "goldsky graphql");
assert(DATA_GATEWAYS.length >= 3, "data fallbacks");
assert(ARWEAVE_HOSTS.includes("arweave.net") && ARWEAVE_HOSTS.includes("g8way.io"), "js client hosts");

const origFetch = globalThis.fetch;

globalThis.fetch = async () => {
  throw new Error("blocked");
};
try {
  await graphqlQuery("query { ping }", {});
  throw new Error("graphqlQuery should throw when every host fails");
} catch (e) {
  assert(isGatewayUnavailable(e), "network fail → GatewayUnavailableError");
  assert(e instanceof GatewayUnavailableError, "class");
  assert(e.message === GATEWAY_DOWN_RU, "ru copy");
}

let gqlCalls = 0;
globalThis.fetch = async (input) => {
  gqlCalls += 1;
  const url = String(input);
  if (url.includes("arweave.net")) {
    return new Response("bad gateway", { status: 502 });
  }
  return new Response(JSON.stringify({ data: { transactions: { edges: [] } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const empty = await graphqlQuery<{ transactions: { edges: unknown[] } }>("query Q { transactions { edges { node { id } } } }", {
  vaultId: "x",
});
assert(empty.transactions.edges.length === 0, "empty vault is success, not 'down'");
assert(gqlCalls >= 2, "walked past the failing primary");

let dataCalls = 0;
const envelope = {schema:"sejire/envelope/v1",vault_id:"a".repeat(32),cipher:"aes-gcm-256",kdf:"hkdf-sha256",iv:"AAAAAAAAAAAAAAAA",ciphertext:"AAAAAAAAAAAAAAAAAAAAAAAA",protocol:"sejire/v0.3"};
globalThis.fetch = async (input) => {
  dataCalls += 1;
  const url = String(input);
  assert(url.includes('/raw/txid123'), 'retrieval uses raw endpoint');
  if (url.includes("arweave.net")) {
    return new Response("missing", { status: 404 });
  }
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const tx = await fetchTxJson("txid123");
assert(tx?.vault_id === envelope.vault_id, "data gateway fallback");
assert(dataCalls >= 2, "skipped 404 primary");

globalThis.fetch = async () => {
  throw new TypeError("Failed to fetch");
};
try {
  await fetchTxJson("offline");
  throw new Error("fetchTxJson should throw when no host answers");
} catch (e) {
  assert(isGatewayUnavailable(e), "all data hosts down");
}

for (const status of [429, 500, 503]) {
  globalThis.fetch = async () => new Response("unavailable", { status });
  let failed = false;
  try { await fetchTxJson("existing-vault"); } catch (e) { failed = isGatewayUnavailable(e); }
  assert(failed, `HTTP ${status} must not mean absent vault`);
}
globalThis.fetch = async () => new Response("not JSON", { status: 200 });
let invalidFailed = false;
try { await fetchTxJson("existing-vault"); } catch (e) { invalidFailed = e instanceof RawEnvelopeMismatchError; }
assert(invalidFailed, "malformed raw response must not mean absence or timeout");
globalThis.fetch = async (input) => new Response("missing", { status: String(input).includes("arweave.net") ? 404 : 503 });
let mixedFailed = false;
try { await fetchTxJson("existing-vault"); } catch (e) { mixedFailed = isGatewayUnavailable(e); }
assert(mixedFailed, "mixed 404 and 503 is inconclusive");
globalThis.fetch = async () => new Response("missing", { status: 404 });
assert(await fetchTxJson("absent") === null, "all 404 means absent");
globalThis.fetch = origFetch;

console.log("gateways.selftest: OK", {
  graphql: GRAPHQL_ENDPOINTS.length,
  data: DATA_GATEWAYS.length,
});
