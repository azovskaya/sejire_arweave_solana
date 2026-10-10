import type { EnvelopeV1 } from "../crypto/encrypt";
import { fetchTxJson, GatewayUnavailableError, graphqlQuery } from "./gateways";

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

/** Compatibility alias for ordinary Vault-Id discovery. */
export const listRecoverableVaultVersions = listVaultVersions;

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
