import type { Identity } from './types';

export type ContentToWorkerMessage =
  | { type: 'FORM_SUBMITTED'; payload: { url: string; email: string } }
  | { type: 'OTP_URL_DETECTED'; payload: { url: string } }
  | { type: 'REQUEST_IDENTITY'; payload: { url: string } }
  | { type: 'RESUME_SESSION'; payload: { url: string } }
  | { type: 'OPEN_TAB'; payload: { url: string } };

export type WorkerToContentMessage =
  | { type: 'OTP_FOUND'; payload: { code: string; link?: string | null } }
  | { type: 'LINK_FOUND'; payload: { url: string } }
  | { type: 'POLLING_STARTED' }
  | { type: 'OTP_TIMEOUT' }
  | { type: 'DOMAIN_REJECTED'; payload: { triedDomain: string } }
  | { type: 'IDENTITY_READY'; payload: { identity: Identity; isResumed?: boolean } };
