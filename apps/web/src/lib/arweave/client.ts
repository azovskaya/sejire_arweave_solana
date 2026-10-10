import ArweaveImport from "arweave";
import type Arweave from "arweave";
import { ARWEAVE_HOSTS } from "./gateways";

type ArweaveStatic = {
  init: (config: {
    host: string;
    port: number;
    protocol: string;
    timeout?: number;
  }) => Arweave;
};

/**
 * Vite can double-wrap the CJS `arweave` default export so `.init` is not on
 * the value that `import Arweave from "arweave"` yields. Resolve the real API.
 */
export function resolveArweaveStatic(): ArweaveStatic {
  const root = ArweaveImport as unknown as ArweaveStatic & {
    default?: ArweaveStatic & { default?: ArweaveStatic };
  };
  if (typeof root?.init === "function") return root;
  if (typeof root?.default?.init === "function") return root.default;
  if (typeof root?.default?.default?.init === "function") return root.default.default;
  throw new Error("Не удалось загрузить Arweave-клиент (Arweave.init недоступен).");
}

const ArweaveApi = resolveArweaveStatic();

/** Shared gateway client for publish / address helpers. */
export function createArweaveClient(host: string = ARWEAVE_HOSTS[0]): Arweave {
  return ArweaveApi.init({
    host,
    port: 443,
    protocol: "https",
  });
}

/** Run `fn` on each public host until one succeeds. */
export async function withArweaveHost<T>(
  fn: (client: Arweave, host: string) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (const host of ARWEAVE_HOSTS) {
    try {
      return await fn(createArweaveClient(host), host);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Arweave недоступен"));
}
