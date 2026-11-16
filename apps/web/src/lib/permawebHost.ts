/** Static Arweave / ArNS hosts never serve the Fund/Checkout Worker API. */
export function isStaticPermawebHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return host === 'ar.io'
    || host.endsWith('.ar.io')
    || host === 'arweave.net'
    || host.endsWith('.arweave.net')
    || host === 'arweave.io'
    || host.endsWith('.arweave.io')
    || host === 'arweave.dev'
    || host.endsWith('.arweave.dev');
}
