/**
 * Session time-to-live: ~6 days (in milliseconds).
 * After this the identity auto-expires and a fresh one is generated.
 */
export const SESSION_TTL_MS = 518_400_000;

export interface Identity {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  password: string;
  phone: string;
}

export interface SessionData {
  email: string;
  token: string;
  createdAt: number;
  associatedUrl: string;
  identity?: Identity;
}

export interface HistoryEntry {
  email: string;
  url: string;
  date: string;
  otp?: string;
  verificationLink?: string;
  identity?: Identity;
}

export interface StorageSchema {
  apiKey: string | null;
  currentSession: SessionData | null;
  history: HistoryEntry[];
}
