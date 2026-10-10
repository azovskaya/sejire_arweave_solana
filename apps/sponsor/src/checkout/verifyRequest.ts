import { assertBase58 } from '../../../../packages/checkout/order';
import type { AtomicOrderStore } from './store';
import { reconcilePayment, type TrustedTransactionReader } from './reconciliation';
/** Future authenticated route boundary. Only orderId/signature may arrive from the client.
 * Route auth, ownership, rate limiting and HTTP exposure are NOT implemented in A2.1.
 */
export function parseVerificationRequest(value: unknown): Readonly<{ orderId: string; signature: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_verification_request');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 2 || Object.keys(request).some(k => k !== 'orderId' && k !== 'signature') ||
      typeof request.orderId !== 'string' || !/^[a-f0-9]{32}$/.test(request.orderId) || typeof request.signature !== 'string') throw new Error('invalid_verification_request');
  assertBase58(request.signature, 64);
  return Object.freeze({ orderId: request.orderId, signature: request.signature });
}
export function verifyRequest(store: AtomicOrderStore, serverReader: TrustedTransactionReader, value: unknown) {
  const request = parseVerificationRequest(value);
  return reconcilePayment(store, serverReader, request.orderId, request.signature);
}
