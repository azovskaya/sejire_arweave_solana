/** Static Arweave / ArNS hosts never serve the Fund/Checkout Worker API. */
export function isStaticPermawebHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return host === 'sejire.ar.io'
    || host.endsWith('.ar.io')
    || host.endsWith('.arweave.net')
    || host.endsWith('.arweave.dev');
}
