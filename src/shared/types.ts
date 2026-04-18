export interface Identity {
  email: string;
  firstName: string;
  lastName: string;
  username: string;
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
}

export interface StorageSchema {
  apiKey: string | null;
  currentSession: SessionData | null;
  history: HistoryEntry[];
}
