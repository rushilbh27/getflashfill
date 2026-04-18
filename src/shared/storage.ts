import type { HistoryEntry, SessionData } from './types';

export async function getApiKey(): Promise<string | null> {
  const result = await chrome.storage.local.get('apiKey');
  return (result.apiKey as string | undefined) ?? null;
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ apiKey: key });
}

export async function getSession(): Promise<SessionData | null> {
  const result = await chrome.storage.local.get('currentSession');
  return (result.currentSession as SessionData | undefined) ?? null;
}

export async function setSession(session: SessionData): Promise<void> {
  await chrome.storage.local.set({ currentSession: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove('currentSession');
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const result = await chrome.storage.local.get('history');
  return (result.history as HistoryEntry[] | undefined) ?? [];
}

export async function addToHistory(entry: HistoryEntry): Promise<void> {
  const current = await getHistory();
  const next = [entry, ...current].slice(0, 5);
  await chrome.storage.local.set({ history: next });
}
