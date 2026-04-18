import type { Identity } from './types';

export type ContentToWorkerMessage =
  | { type: 'FORM_SUBMITTED'; payload: { url: string; email: string } }
  | { type: 'OTP_URL_DETECTED'; payload: { url: string } };

export type WorkerToContentMessage =
  | { type: 'OTP_FOUND'; payload: { code: string } }
  | { type: 'OTP_TIMEOUT' }
  | { type: 'DOMAIN_REJECTED'; payload: { triedDomain: string } }
  | { type: 'IDENTITY_READY'; payload: { identity: Identity } };
