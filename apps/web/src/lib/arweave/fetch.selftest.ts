import { mapVaultVersionEdges, formatVersionWhen } from "./fetch";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const edges = mapVaultVersionEdges([
  {
    node: {
      id: "tx_newest",
      block: { timestamp: 1_700_000_000, height: 100 },
      tags: [
        { name: "Updated-At", value: "2024-01-15T12:00:00.000Z" },
        { name: "Parent-Tx", value: "tx_older" },
      ],
    },
  },
  {
    node: {
      id: "tx_older",
      block: { timestamp: 1_600_000_000, height: 50 },
      tags: [],
    },
  },
  {
    node: {
      id: "tx_pending",
      block: null,
      tags: [{ name: "Parent-Tx", value: "tx_older" }],
    },
  },
]);

assert(edges.length === 3, "three versions");
assert(edges[0].txId === "tx_newest", "order preserved");
assert(edges[0].parentTxId === "tx_older", "Parent-Tx parsed");
assert(edges[0].updatedAt === "2024-01-15T12:00:00.000Z", "Updated-At parsed");
assert(edges[1].parentTxId === null, "missing parent");
assert(edges[2].blockTimestamp === null, "pending block");
assert(formatVersionWhen(edges[1]).length > 0, "formats block time");
assert(formatVersionWhen(edges[2]) === "время неизвестно", "unknown when");

console.log("fetch.selftest: OK", { versions: edges.length });

// A malformed GraphQL success response cannot establish an empty archive.
const originalFetchForShape = globalThis.fetch;
try {
  const { listVaultVersions } = await import('./fetch');
  const { isGatewayUnavailable } = await import('./gateways');
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }), { status: 200 });
  let refused = false;
  try { await listVaultVersions('synthetic-vault'); } catch(e) { refused = isGatewayUnavailable(e); }
  assert(refused, 'missing transactions must not become an empty vault');
} finally { globalThis.fetch = originalFetchForShape; }

// Future V2 publishes include Vault-Id and use ordinary discovery, not the pilot fallback.
const originalFetchForTags = globalThis.fetch;
try {
  const { listRecoverableVaultVersions } = await import('./fetch');
  const { preservationV2Tags } = await import('../preserveV2/arweave');
  const vaultId='b'.repeat(32), tags=preservationV2Tags({saveId:'future-save',vaultId,archiveDigest:'a'.repeat(64),archiveBytes:100});
  let queries=0;
  globalThis.fetch=async (_input,init)=>{
    queries++;
    const body=JSON.parse(String(init?.body)) as {query:string;variables:{vaultId:string}};
    assert(body.query.includes('Vault-Id'), 'ordinary Vault-Id query');
    assert(!body.query.includes('Save-Id'), 'no legacy Save-Id fallback');
    assert(body.variables.vaultId===vaultId,'derived Vault-Id is queried');
    return new Response(JSON.stringify({data:{transactions:{edges:[{node:{id:'A'.repeat(43),block:{timestamp:1,height:1},tags}}]}}}),{status:200});
  };
  const found=await listRecoverableVaultVersions(vaultId);
  assert(found.length===1 && found[0].txId==='A'.repeat(43),'future V2 transaction is found normally');
  assert(queries===1,'no fallback query needed');
} finally { globalThis.fetch=originalFetchForTags; }
