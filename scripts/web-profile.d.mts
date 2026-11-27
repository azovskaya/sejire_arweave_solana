export type WebProfile = 'decentralized-direct-arweave' | 'legacy';
export function webProfile(mode: string | undefined): WebProfile;
export const DIRECT_BROWSER_ENV: Readonly<Record<string, string>>;
export function webDefines(mode: string | undefined): Record<string, string>;
