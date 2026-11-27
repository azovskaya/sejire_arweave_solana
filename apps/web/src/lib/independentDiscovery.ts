import { GatewayUnavailableError } from './arweave/gateways';
import type { VaultVersionMeta } from './arweave/fetch';
import { directNode } from './directArweave/nodePreference';
import { active, directNodes, nodeRequest } from './directArweave/network';
import type { DirectOptions } from './directArweave/types';
import type { HeadCandidate, SafeRecoveryDiagnostics } from './recovery/types';

const ID = /^[A-Za-z0-9_-]{43}$/;
type Options = { limit?: number; signal?: AbortSignal; node?: string };

async function page(vaultId: string, node: string, limit: number, after: string | null, signal?: AbortSignal) {
  if (!/^[a-f0-9]{32}$/.test(vaultId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GatewayUnavailableError();
  const query = `query ($vaultId: String!, $limit: Int!, $after: String) {
    transactions(first: $limit, after: $after, tags: [
      { name: "App-Name", values: ["SEJIRE"] },
      { name: "Type", values: ["vault-envelope"] },
      { name: "Vault-Id", values: [$vaultId] }
    ], sort: HEIGHT_DESC) {
      pageInfo { hasNextPage }
      edges { cursor node { id block { timestamp } tags { name value } } }
    }
  }`;
  const response = await nodeRequest(node, '/graphql', { signal, readOnlyQuery: true,
    body: JSON.stringify({ query, variables: { vaultId, limit, after } }), maxBytes: 2 * 1024 * 1024 });
  if (response.status !== 200) throw new GatewayUnavailableError();
  const result = JSON.parse(response.text);
  const connection = result?.data?.transactions;
  const edges: unknown = connection?.edges;
  if (result?.errors || !Array.isArray(edges) || edges.length > limit) throw new GatewayUnavailableError();
  const versions: VaultVersionMeta[] = edges.map(edge => {
    const record = edge?.node;
    if (!record || typeof record.id !== 'string' || !ID.test(record.id)) throw new GatewayUnavailableError();
    const tags = Array.isArray(record.tags) && record.tags.length <= 40 ? record.tags : [];
    const tag = (name: string): string | null => {
      const value = tags.find((item: unknown) => item && typeof item === 'object' && 'name' in item && item.name === name)?.value;
      return typeof value === 'string' && value.length <= 128 ? value : null;
    };
    const parent = tag('Parent-Tx'), timestamp = record.block?.timestamp;
    return { txId: record.id, blockTimestamp: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null,
      updatedAt: tag('Updated-At'), parentTxId: parent && ID.test(parent) ? parent : null };
  });
  const cursor = edges.at(-1)?.cursor;
  return { versions, hasNext: connection.pageInfo?.hasNextPage,
    cursor: typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096 ? cursor : null };
}

/** Only native Arweave gateway origins are defaults. Explicit/stored node
 * selection remains exclusive. Neither path imports an external index registry,
 * hosted search service or peer discovery; an index never authenticates a vault. */
export async function listIndependentVaultVersions(vaultId: string, options: Options = {}): Promise<VaultVersionMeta[]> {
  const nodes = directNodes(options.node === undefined ? {} : { nodes: [directNode(options.node)] });
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  active(options.signal);
  const results = await Promise.allSettled(nodes.map(node => page(vaultId, node, limit, null, options.signal)));
  active(options.signal);
  const usable = results.filter(result => result.status === 'fulfilled');
  if (!usable.length) throw new GatewayUnavailableError();
  // An empty/stale response from the first gateway cannot hide a version that
  // another selected gateway already indexes. These remain discovery hints.
  const unique = new Map<string, VaultVersionMeta>();
  for (const result of usable) for (const version of result.value.versions) {
    if (!unique.has(version.txId)) unique.set(version.txId, version);
  }
  return [...unique.values()].sort((a, b) => (b.blockTimestamp ?? -1) - (a.blockTimestamp ?? -1) || a.txId.localeCompare(b.txId)).slice(0, limit);
}

/** Search a bounded set of pages on the same replaceable native gateways used
 * by direct transport. Returned IDs/times are untrusted discovery hints only.
 * A missing/truncated index does not prevent known-ID or file recovery. */
export async function discoverIndependentVaultVersions(vaultId: string, options: DirectOptions = {}) {
  const nodes = directNodes(options);
  const outcomes = await Promise.all(nodes.map(async node => {
    const candidates: HeadCandidate[] = [];
    const source = `graphql:${new URL(node).host}`;
    let after: string | null = null;
    try {
      for (let count = 0; count < 3; count++) {
        active(options.signal);
        const result = await page(vaultId, node, 100, after, options.signal);
        for (const version of result.versions) candidates.push({ txId: version.txId, source,
          ...(version.blockTimestamp === null ? {} : { blockTimestamp: version.blockTimestamp }) });
        if (result.hasNext === false) return { id: source, status: 'responded' as const, candidates };
        if (result.hasNext !== true || !result.cursor || result.cursor === after || !result.versions.length) break;
        after = result.cursor;
      }
    } catch { active(options.signal); }
    return { id: source, status: 'unavailable' as const, candidates };
  }));
  active(options.signal);
  const unique = new Map<string, HeadCandidate>();
  for (const result of outcomes) for (const candidate of result.candidates) {
    const previous = unique.get(candidate.txId);
    unique.set(candidate.txId, previous ? { ...previous, source: `${previous.source},${candidate.source}` } : candidate);
  }
  const providers: SafeRecoveryDiagnostics['providers'] = outcomes.map(result => ({
    id: result.id, status: result.status, count: result.candidates.length,
  }));
  return { candidates: [...unique.values()].slice(0, 300), providers,
    responded: outcomes.some(result => result.status === 'responded'),
    incomplete: unique.size > 300 || outcomes.some(result => result.status === 'unavailable') };
}
