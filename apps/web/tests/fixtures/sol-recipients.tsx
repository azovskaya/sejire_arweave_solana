import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SolanaRecipientsAdmin } from '../../src/components/SolanaRecipientsAdmin';
createRoot(document.getElementById('root')!).render(createElement(SolanaRecipientsAdmin, { credential: 'synthetic-browser-admin-not-production' }));
