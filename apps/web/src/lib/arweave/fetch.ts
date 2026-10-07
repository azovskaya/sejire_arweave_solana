import type { EnvelopeV1 } from "../crypto/encrypt";
import { PRESERVATION_V2_PILOT_POLICY as P, saveIdForPolicy } from "../preserveV2/policy";
import { LEGACY_V2_PILOT_TX_ID } from "../preserveV2/legacyPilot";
import { fetchTxJson, GatewayUnavailableError, graphqlQuery, RawEnvelopeMismatchError } from "./gateways";

export { GatewayUnavailableError, isGatewayUnavailable } from "./gateways";

export type VaultVersionMeta = {
  txId: string;
  /** Block time (unix seconds) when available. */
  blockTimestamp: number | null;
  /** ISO from Updated-At tag when publisher set it. */
  updatedAt: string | null;
  /** Parent vault TX when publisher set Parent-Tx. */
  parentTxId: string | null;
};

type GqlTag = { name: string; value: string };

type GqlEdge = {
  node: {
    id: string;
    block: { timestamp: number; height: number } | null;
    tags?: GqlTag[];
  };
};

function tagValue(tags: GqlTag[] | undefined, name: string): string | null {
  if (!tags) return null;
  const hit = tags.find((t) => t.name === name);
  return hit?.value ?? null;
}

/** Pure helper for tests — map GraphQL edges to version metadata. */
export function mapVaultVersionEdges(edges: GqlEdge[]): VaultVersionMeta[] {
  return edges.map((edge) => ({
    txId: edge.node.id,
    blockTimestamp: edge.node.block?.timestamp ?? null,
    updatedAt: tagValue(edge.node.tags, "Updated-At"),
    parentTxId: tagValue(edge.node.tags, "Parent-Tx"),
  }));
}

export async function fetchEnvelopeByTx(txId: string): Promise<EnvelopeV1 | null> {
  return fetchTxJson(txId);
}

type PilotBinding = {version:string;vaultId:string;archiveDigest:string;archiveBytes:number;payer:string;txId:string};
function pilotBinding(): PilotBinding {
  if (import.meta.env?.VITE_PRESERVATION_V2_TEST === '1' && typeof window !== 'undefined') {
    const fixture=(window as Window & {__SEJIRE_V2_RECOVERY_TEST_PILOT__?:PilotBinding}).__SEJIRE_V2_RECOVERY_TEST_PILOT__;
    if (fixture) return fixture;
  }
  return {...P,txId:LEGACY_V2_PILOT_TX_ID};
}

function exactTag(tags:GqlTag[]|undefined,name:string,value:string):boolean {
  return tags?.filter(tag=>tag.name===name).length===1 && tagValue(tags,name)===value;
}

async function legacyPilotVersions(vaultId:string):Promise<VaultVersionMeta[]> {
  const pilot=pilotBinding();
  if (vaultId!==pilot.vaultId) return [];
  const saveId=await saveIdForPolicy(pilot);
  const fields='edges { node { id block { timestamp height } tags { name value } } }';
  const bySaveId=`query ($saveId: String!) { transactions(first: 10, tags: [
    {name:"App-Name",values:["SEJIRE"]}, {name:"Type",values:["vault-envelope"]},
    {name:"Save-Id",values:[$saveId]}], sort: HEIGHT_DESC) { ${fields} } }`;
  const indexed=await graphqlQuery<{transactions?:{edges:GqlEdge[]}}>(bySaveId,{saveId});
  if (!Array.isArray(indexed.transactions?.edges)) throw new GatewayUnavailableError();
  let edges=indexed.transactions.edges;
  // The pilot TX is confirmed but public tag indexes can lag. Its ID is only a hint:
  // the returned tags, raw bytes, SHA-256 and vault ID still have to match.
  if (edges.length===0) {
    const byId=`query ($ids: [ID!]!) { transactions(ids:$ids) { ${fields} } }`;
    const direct=await graphqlQuery<{transactions?:{edges:GqlEdge[]}}>(byId,{ids:[pilot.txId]});
    if (!Array.isArray(direct.transactions?.edges)) throw new GatewayUnavailableError();
    edges=direct.transactions.edges;
  }
  const candidates=edges.filter(edge=>
    /^[A-Za-z0-9_-]{43}$/.test(edge.node.id) && edge.node.block &&
    exactTag(edge.node.tags,'App-Name','SEJIRE') &&
    exactTag(edge.node.tags,'Type','vault-envelope') &&
    exactTag(edge.node.tags,'Save-Id',saveId) &&
    !edge.node.tags?.some(tag=>tag.name==='Vault-Id'));
  const verified:VaultVersionMeta[]=[];
  for (const edge of candidates) {
    const envelope=await fetchTxJson(edge.node.id,{bytes:pilot.archiveBytes,sha256:pilot.archiveDigest});
    if (!envelope) throw new GatewayUnavailableError();
    if (envelope.vault_id!==vaultId) throw new RawEnvelopeMismatchError();
    verified.push(...mapVaultVersionEdges([edge]));
  }
  if (verified.length>1) throw new Error('ambiguous_legacy_pilot');
  return verified;
}

/** Restore only: ordinary Vault-Id discovery, then the exact immutable V2 pilot. */
export async function listRecoverableVaultVersions(vaultId:string,opts?:{limit?:number}):Promise<VaultVersionMeta[]> {
  const versions=await listVaultVersions(vaultId,opts);
  return versions.length?versions:legacyPilotVersions(vaultId);
}

/**
 * List SEJIRE vault envelopes for vaultId (newest first).
 * Does not download ciphertext until a version is opened.
 */
export async function listVaultVersions(
  vaultId: string,
  opts?: { limit?: number }
): Promise<VaultVersionMeta[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const query = `
    query ($vaultId: String!, $limit: Int!) {
      transactions(
        first: $limit
        tags: [
          { name: "App-Name", values: ["SEJIRE"] }
          { name: "Type", values: ["vault-envelope"] }
          { name: "Vault-Id", values: [$vaultId] }
        ]
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            block { timestamp height }
            tags { name value }
          }
        }
      }
    }
  `;

  const data = await graphqlQuery<{ transactions?: { edges: GqlEdge[] } }>(query, {
    vaultId,
    limit,
  });
  if (!Array.isArray(data.transactions?.edges)) throw new GatewayUnavailableError();
  return mapVaultVersionEdges(data.transactions.edges);
}

/**
 * Find newest SEJIRE vault envelope for vaultId on Arweave.
 * Validates schema + vault_id by downloading candidates newest-first.
 */
export async function fetchLatestEnvelope(vaultId: string): Promise<{
  txId: string;
  envelope: EnvelopeV1;
} | null> {
  const versions = await listVaultVersions(vaultId, { limit: 10 });
  for (const v of versions) {
    const envelope = await fetchEnvelopeByTx(v.txId);
    if (envelope && envelope.vault_id === vaultId) {
      return { txId: v.txId, envelope };
    }
  }
  return null;
}

/** Download + validate a specific vault TX. */
export async function fetchVaultEnvelope(
  vaultId: string,
  txId: string
): Promise<{ txId: string; envelope: EnvelopeV1 } | null> {
  const envelope = await fetchEnvelopeByTx(txId);
  if (!envelope || envelope.vault_id !== vaultId) return null;
  return { txId, envelope };
}

export function formatVersionWhen(meta: VaultVersionMeta): string {
  if (meta.updatedAt) {
    const d = Date.parse(meta.updatedAt);
    if (!Number.isNaN(d)) {
      return new Date(d).toLocaleString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  if (meta.blockTimestamp != null) {
    return new Date(meta.blockTimestamp * 1000).toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return "время неизвестно";
}
