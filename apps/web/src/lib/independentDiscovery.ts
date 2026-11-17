import { GatewayUnavailableError, listVaultVersions, type VaultVersionMeta } from './arweave/fetch';
import { directNode, readDirectNodePreference } from './directArweave/nodePreference';
import { nodeRequest } from './directArweave/network';

const ID = /^[A-Za-z0-9_-]{43}$/;
type Options = { limit?: number; signal?: AbortSignal; node?: string };

/** With an explicit native node, search only that origin's optional GraphQL API.
 * An absent index never falls back to other operators. Known-ID/file recovery
 * remains available. Without a preference the existing discovery is unchanged. */
export async function listIndependentVaultVersions(vaultId: string, options: Options = {}): Promise<VaultVersionMeta[]> {
  const selected = options.node === undefined ? readDirectNodePreference() : directNode(options.node);
  if (!selected) return listVaultVersions(vaultId, options);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const query = `query ($vaultId: String!, $limit: Int!) {
    transactions(first: $limit, tags: [
      { name: "App-Name", values: ["SEJIRE"] },
      { name: "Type", values: ["vault-envelope"] },
      { name: "Vault-Id", values: [$vaultId] }
    ], sort: HEIGHT_DESC) {
      edges { node { id block { timestamp } tags { name value } } }
    }
  }`;
  try {
    const response = await nodeRequest(selected, '/graphql', { signal: options.signal, readOnlyQuery: true,
      body: JSON.stringify({ query, variables: { vaultId, limit } }), maxBytes: 2 * 1024 * 1024 });
    if (response.status !== 200) throw new GatewayUnavailableError();
    const result = JSON.parse(response.text);
    const edges: unknown = result?.data?.transactions?.edges;
    if (result?.errors || !Array.isArray(edges) || edges.length > limit) throw new GatewayUnavailableError();
    return edges.map(edge => {
      const node = edge?.node;
      if (!node || typeof node.id !== 'string' || !ID.test(node.id)) throw new GatewayUnavailableError();
      const tags = Array.isArray(node.tags) && node.tags.length <= 40 ? node.tags : [];
      const tag = (name: string): string | null => {
        const value = tags.find((item: unknown) => item && typeof item === 'object' && 'name' in item && item.name === name)?.value;
        return typeof value === 'string' && value.length <= 128 ? value : null;
      };
      const parent = tag('Parent-Tx'), timestamp = node.block?.timestamp;
      return { txId: node.id, blockTimestamp: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null,
        updatedAt: tag('Updated-At'), parentTxId: parent && ID.test(parent) ? parent : null };
    });
  } catch { throw new GatewayUnavailableError(); }
}
