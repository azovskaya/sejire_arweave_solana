export type PaymentState = 'awaiting-payment' | 'requires-reconciliation' | 'verified';
export type PreservationState = 'not-applicable' | 'awaiting-payment' | 'ready' | 'running' | 'requires-reconciliation' | 'completed';
export type ContributionState = 'not-requested' | 'awaiting-payment' | 'requires-reconciliation' | 'received';
/** Payment, contribution and storage are independent. A payment is never proof of upload completion. */
export type OrderStates = Readonly<{ payment: PaymentState; preservation: PreservationState; contribution: ContributionState }>;
