/*
 * SERVICE WORKER — FlashFill Background Script
 *
 * Tempmail API (Privatix on RapidAPI) — correct flow:
 *   1. GET  /request/domains/                  → string[] of available domains
 *   2. Build email: {random_local}@{domain}
 *   3. MD5-hash the lowercase email            → this is the mailbox ID
 *   4. GET  /request/mail/id/{md5_hash}        → TempmailMessage[] (or empty)
 *
 * There is NO POST "create mailbox" endpoint. The mailbox is implied by the
 * email address; the MD5 hash is the stable key for polling.
 *
 * Polling strategy:
 *   - chrome.alarms for the 90-second hard-stop (reliable across restarts).
 *   - Recursive setTimeout for the 3-second poll ticks (chrome.alarms minimum
 *     period is 1 minute, making it unusable for short intervals).
 *
 * TODO V1.1 — domain rotation: on DOMAIN_REJECTED, cycle through
 *   getAvailableDomains() and retry with a fresh email on each domain until
 *   all are exhausted.
 */

import md5 from 'md5';
import { generateIdentity } from '../shared/identity';
import { extractOTP, extractLink } from '../shared/otp-extractor';
import { getApiKey, getSession, setSession, addToHistory } from '../shared/storage';
import type { ContentToWorkerMessage, WorkerToContentMessage } from '../shared/messages';

// ─── constants ────────────────────────────────────────────────────────────────

const ALARM_NAME       = 'flashfill-otp-timeout';
const POLL_INTERVAL_MS = 3_000;   // 3 seconds between inbox polls
const POLL_TIMEOUT_MS  = 90_000;  // 90-second hard stop (PRD spec)
const ALARM_DELAY_MIN  = 1.5;     // 90 s in minutes for chrome.alarms

const API_HOST = 'privatix-temp-mail-v1.p.rapidapi.com';
const API_BASE = `https://${API_HOST}`;

// ─── API types ────────────────────────────────────────────────────────────────

interface TempmailMessage {
  subject: string;
  body:    string;
}

class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── polling state ────────────────────────────────────────────────────────────

interface PollingState {
  emailHash:  string;
  tabId:      number;
  startedAt:  number;
  tickHandle: ReturnType<typeof setTimeout> | null;
}

let pollingState: PollingState | null = null;

// Guard against concurrent handleRequestIdentity calls (detector + injector
// can both fire REQUEST_IDENTITY before the first call finishes saving).
let identityInFlight = false;

// ─── messaging ────────────────────────────────────────────────────────────────

async function sendToTab(tabId: number, message: WorkerToContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab closed or navigated — silent failure.
  }
}

// ─── OTP extraction ───────────────────────────────────────────────────────────

function findOTPInMessages(messages: TempmailMessage[]): string | null {
  for (const msg of messages) {
    const otp = extractOTP(msg.subject) ?? extractOTP(msg.body);
    if (otp) return otp;
  }
  return null;
}

function findLinkInMessages(messages: TempmailMessage[]): string | null {
  for (const msg of messages) {
    const link = extractLink(msg.body);
    if (link) return link;
  }
  return null;
}

// ─── Tempmail API ─────────────────────────────────────────────────────────────

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type':    'application/json',
    'x-rapidapi-key':  apiKey,
    'x-rapidapi-host': API_HOST,
  };
}

async function getAvailableDomains(apiKey: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/request/domains/`, {
    method:  'GET',
    headers: apiHeaders(apiKey),
  });
  if (res.status === 429) throw new ApiError(429, 'Rate limit');
  if (!res.ok)            throw new ApiError(res.status, `Domains fetch failed: ${res.status}`);
  return res.json() as Promise<string[]>;
}

async function fetchMessages(
  emailHash: string,
  apiKey:    string,
): Promise<TempmailMessage[]> {
  const res = await fetch(
    `${API_BASE}/request/mail/id/${encodeURIComponent(emailHash)}`,
    { method: 'GET', headers: apiHeaders(apiKey) },
  );
  if (res.status === 429) throw new ApiError(429, 'Rate limit');
  if (!res.ok)            throw new ApiError(res.status, `Poll failed: ${res.status}`);

  // API returns an object with a "mail" array, or an empty array, depending
  // on whether any messages have arrived yet.
  const data: unknown = await res.json();
  if (Array.isArray(data)) return data as TempmailMessage[];
  // Some API versions wrap messages in { mail: [...] }
  if (data && typeof data === 'object' && 'mail' in data) {
    return (data as { mail: TempmailMessage[] }).mail ?? [];
  }
  return [];
}

/**
 * Generate a random alphanumeric local part that looks plausibly like a real
 * username without pulling in Faker (keeping the worker lean).
 */
function randomLocalPart(): string {
  return Math.random().toString(36).slice(2, 12); // e.g. "k3h9x2m7p1"
}

// ─── polling loop ─────────────────────────────────────────────────────────────

function stopPolling(): void {
  if (!pollingState) return;
  if (pollingState.tickHandle !== null) clearTimeout(pollingState.tickHandle);
  void chrome.alarms.clear(ALARM_NAME);
  pollingState = null;
}

async function pollOnce(): Promise<void> {
  if (!pollingState) return;

  // Belt-and-suspenders timeout guard.
  if (Date.now() - pollingState.startedAt >= POLL_TIMEOUT_MS) {
    const tabId = pollingState.tabId;
    stopPolling();
    await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey || !pollingState) return;

  try {
    const messages = await fetchMessages(pollingState.emailHash, apiKey);
    const otp = findOTPInMessages(messages);

    if (otp) {
      const tabId = pollingState.tabId;
      stopPolling();
      await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: otp } });
      return;
    }

    const link = findLinkInMessages(messages);
    if (link) {
      const tabId = pollingState.tabId;
      stopPolling();
      // Auto-open magic link in a new foreground tab.
      await chrome.tabs.create({ url: link, active: true });
      // Notify the original tab.
      await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: 'Magic Link' } });
      return;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) {
        const tabId = pollingState.tabId;
        stopPolling();
        await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
        return;
      }
      if (err.status === 401 || err.status === 403) {
        console.error('[FlashFill] API key invalid during poll — stopping.');
        stopPolling();
        return;
      }
    }
    console.error('[FlashFill] Poll error (will retry):', err);
  }

  // No OTP yet — touch storage to help keep the worker alive, then reschedule.
  if (pollingState) {
    await getApiKey();
    pollingState.tickHandle = setTimeout(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  }
}

export function startOTPPolling(emailHash: string, tabId: number): void {
  if (pollingState) return; // one loop at a time

  pollingState = {
    emailHash,
    tabId,
    startedAt:  Date.now(),
    tickHandle: null,
  };

  chrome.alarms.create(ALARM_NAME, { delayInMinutes: ALARM_DELAY_MIN });
  void pollOnce();
}

// ─── REQUEST_IDENTITY ─────────────────────────────────────────────────────────

async function handleRequestIdentity(url: string, tabId: number): Promise<void> {
  console.log('[FlashFill] handleRequestIdentity called', { url, tabId });
  if (identityInFlight) {
    console.log('[FlashFill] Identity request already in-flight, skipping.');
    return;
  }
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[FlashFill] No API key stored — skipping.');
    return;
  }

  // Quota protection — reuse session if the URL hasn't changed.
  const existing = await getSession();
  if (existing && existing.associatedUrl === url) {
    console.log('[FlashFill] Reusing existing session for', url);
    const identity = generateIdentity(existing.email);
    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity } });
    return;
  }

  identityInFlight = true;
  try {
    const domains = await getAvailableDomains(apiKey);
    if (!domains.length) throw new Error('No domains returned from Tempmail');

    // API returns domains with leading '@' (e.g. '@cpav3.com') — strip it.
    const rawDomain = domains[Math.floor(Math.random() * domains.length)]!;
    const domain    = rawDomain.replace(/^@/, '');
    const local     = randomLocalPart();
    const email     = `${local}@${domain}`.toLowerCase();
    const emailHash = md5(email);

    console.log('[FlashFill] Generated email:', email);
    const identity = generateIdentity(email);
    console.log('[FlashFill] Identity ready, sending to tab', tabId, identity);

    await setSession({
      email,
      token:         emailHash, // repurposing token field to store the hash
      createdAt:     Date.now(),
      associatedUrl: url,
    });

    await addToHistory({
      email,
      url,
      date: new Date().toISOString(),
    });

    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity } });

  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        console.error('[FlashFill] Invalid RapidAPI key — prompt user to re-enter.');
      } else if (err.status === 429) {
        console.error('[FlashFill] API quota exhausted.');
      } else {
        console.error('[FlashFill] Mailbox setup failed:', err.message);
      }
    } else {
      console.error('[FlashFill] Unexpected error:', err);
    }
  } finally {
    identityInFlight = false;
  }
}

// ─── FORM_SUBMITTED / OTP_URL_DETECTED ───────────────────────────────────────

async function handleStartPolling(tabId: number): Promise<void> {
  if (pollingState) return;

  const session = await getSession();
  if (!session) return;

  // session.token holds the MD5 email hash (set in handleRequestIdentity).
  startOTPPolling(session.token, tabId);
}

// ─── chrome.alarms hard-stop ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME || !pollingState) return;
  const tabId = pollingState.tabId;
  stopPolling();
  await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
});

// ─── message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ContentToWorkerMessage, sender: chrome.runtime.MessageSender) => {
    const tabId = sender.tab?.id;
    console.log('[FlashFill] Worker received message:', message.type, 'from tab', tabId);
    if (tabId === undefined) return;

    switch (message.type) {
      case 'REQUEST_IDENTITY':
        void handleRequestIdentity(message.payload.url, tabId);
        break;
      case 'FORM_SUBMITTED':
      case 'OTP_URL_DETECTED':
        void handleStartPolling(tabId);
        break;
    }
  },
);
