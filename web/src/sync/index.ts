// Public entry point of the session layer. The UI imports only from here.
// Stub until M4 lands (owner: C).

import type { OpenSession } from './types';

export * from './types';

export const openSession: OpenSession = async () => {
  throw new Error('src/sync not implemented yet; use ?mock');
};
