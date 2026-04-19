export interface Identity {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  password: string;
}

export interface SessionData {
  email: string;
  token: string;
  createdAt: number;
  associatedUrl: string;
}

export interface HistoryEntry {
  email: string;
  url: string;
  date: string;
  otp?: string;
  verificationLink?: string;
}

export interface StorageSchema {
  apiKey: string | null;
  currentSession: SessionData | null;
  history: HistoryEntry[];
}
