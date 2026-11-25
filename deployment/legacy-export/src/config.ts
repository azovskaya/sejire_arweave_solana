export const OBJECT_NAME = 'sejire-checkout-ledger-v1';
export const CONFIG_SCHEMA = 'sejire/legacy-export-config/v1';
export const PREFIX = '/__sejire_legacy_export';
export type ExportConfig = {
  schema: typeof CONFIG_SCHEMA; accountId: string; scriptName: string;
  bindingName: 'CHECKOUT_LEDGER'; className: 'CheckoutLedger'; namespaceId: string;
  objectName: typeof OBJECT_NAME; objectId: string; sourceCommit: string;
  sourceVersionId: string; sourceEvidenceSha256: string; maintenanceRequestedAt: number;
  attestation: 'MAINTENANCE_EXPORT_ONLY';
};
const keys = ['schema','accountId','scriptName','bindingName','className','namespaceId','objectName','objectId','sourceCommit','sourceVersionId','sourceEvidenceSha256','maintenanceRequestedAt','attestation'].sort().join(',');
export function checkConfig(input: unknown, now = Date.now()): ExportConfig {
  const value = input as ExportConfig;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys ||
      Object.entries(value).some(([key,item])=>key!=='maintenanceRequestedAt'&&typeof item!=='string') ||
      value.schema !== CONFIG_SCHEMA || !/^[a-f0-9]{32}$/.test(value.accountId) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.scriptName) || value.bindingName !== 'CHECKOUT_LEDGER' ||
      value.className !== 'CheckoutLedger' || !/^[a-f0-9]{32}$/.test(value.namespaceId) ||
      value.objectName !== OBJECT_NAME || !/^[a-f0-9]{64}$/.test(value.objectId) ||
      !/^[a-f0-9]{40}$/.test(value.sourceCommit) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.sourceVersionId) ||
      !/^[a-f0-9]{64}$/.test(value.sourceEvidenceSha256) || !Number.isSafeInteger(value.maintenanceRequestedAt) ||
      value.maintenanceRequestedAt <= 0 || value.maintenanceRequestedAt > now || value.attestation !== 'MAINTENANCE_EXPORT_ONLY') {
    throw Error('export_configuration_invalid');
  }
  return value;
}
export function checkAcknowledgement(value: unknown, config: ExportConfig): void {
  const body = value as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'attestation,namespaceId,objectId,sourceCommit' ||
      body.namespaceId !== config.namespaceId || body.objectId !== config.objectId ||
      body.sourceCommit !== config.sourceCommit || body.attestation !== config.attestation) {
    throw Error('export_target_acknowledgement_required');
  }
}
