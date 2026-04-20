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
import { getApiKey, getSession, setSession, addToHistory, updateHistoryEntry, getHistory } from '../shared/storage';
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
  mail_subject?: string;
  mail_text?:    string;
  mail_html?:    string;
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
    const textToSearch = `${msg.mail_subject || ''} ${msg.mail_text || ''} ${msg.mail_html || ''}`;
    const otp = extractOTP(textToSearch);
    if (otp) return otp;
  }
  return null;
}

function findLinkInMessages(messages: TempmailMessage[]): string | null {
  for (const msg of messages) {
    const textToSearch = `${msg.mail_text || ''} ${msg.mail_html || ''}`;
    const link = extractLink(textToSearch);
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
    `${API_BASE}/request/mail/id/${encodeURIComponent(emailHash)}/`,
    { method: 'GET', headers: apiHeaders(apiKey) },
  );
  if (res.status === 429) throw new ApiError(429, 'Rate limit');
  if (!res.ok)            throw new ApiError(res.status, `Poll failed: ${res.status}`);

  const data: unknown = await res.json();
  let messages: any[] = [];
  
  if (Array.isArray(data)) {
    messages = data;
  } else if (data && typeof data === 'object' && 'mail' in data) {
    messages = (data as { mail: any[] }).mail ?? [];
  }

  // Privatix temp mail returns {"error": "There are no messages yet"} inside an array or object
  // when the inbox is empty. We must filter these out.
  messages = messages.filter(msg => msg && !msg.error && (msg.mail_text || msg.mail_html || msg.mail_subject));
  
  return messages as TempmailMessage[];
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
    
    // Debug logging to see exactly what we get and what we extract
    if (messages && messages.length > 0) {
      console.log('[FlashFill] Received messages:', messages.length);
      console.log('[FlashFill] Message 0 subject:', messages[0].mail_subject);
      console.log('[FlashFill] Message 0 text snippet:', (messages[0].mail_text || '').substring(0, 150));
    }
    
    const otp = findOTPInMessages(messages);
    const link = findLinkInMessages(messages);
    
    if (messages && messages.length > 0) {
      console.log('[FlashFill] Extraction results -> otp:', otp, 'link:', link);
    }

    if (otp || link) {
      const tabId = pollingState.tabId;
      const session = await getSession();
      if (session) {
        const updates: any = {};
        if (otp) updates.otp = otp;
        if (link) updates.verificationLink = link;
        await updateHistoryEntry(session.email, updates);
      }
      stopPolling();

      if (link) {
        try {
          // Broadcast to popup if it's currently open
          chrome.runtime.sendMessage({ type: 'LINK_FOUND', payload: { url: link } });
        } catch {}
      }

      if (link && !otp) {
        // Auto-open magic link in a new foreground tab.
        await chrome.tabs.create({ url: link, active: true });
        await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: 'Magic Link' } });
      } else {
        // If we found an OTP, we trigger the autofill in the tab.
        // We also send the link (if any) so the content script can optionally fallback if no input field is found.
        await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: otp as string, link: link } });
      }
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
  void sendToTab(tabId, { type: 'POLLING_STARTED' });
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

  // Quota protection — reuse session if the domain matches and it's recent (e.g. 30 mins).
  const existing = await getSession();
  const currentDomain = new URL(url).hostname;
  const existingDomain = existing ? new URL(existing.associatedUrl).hostname : null;

  if (existing && existingDomain === currentDomain && (Date.now() - existing.createdAt < 30 * 60 * 1000)) {
    console.log('[FlashFill] Reusing existing session identity for', url);
    const identity = existing.identity || generateIdentity(existing.email);
    
    // If identity wasn't stored, store it now for consistency.
    if (!existing.identity) {
      existing.identity = identity;
      await setSession(existing);
    }
    
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
      identity,
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

// ─── RESUME_SESSION ──────────────────────────────────────────────────────────

async function handleResumeSession(url: string, tabId: number): Promise<void> {
  const session = await getSession();
  if (!session || !session.identity) return;

  const currentDomain = new URL(url).hostname;
  const sessionDomain = new URL(session.associatedUrl).hostname;

  // Only resume if it's the same domain and fairly recent (30 mins).
  if (currentDomain === sessionDomain && (Date.now() - session.createdAt < 30 * 60 * 1000)) {
    console.log('[FlashFill] Resuming session for multi-step flow on', url);
    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity: session.identity, isResumed: true } });
  }
}

// ─── FORM_SUBMITTED / OTP_URL_DETECTED ───────────────────────────────────────

async function handleStartPolling(tabId: number): Promise<void> {
  // If polling is already running, don't start another loop.
  if (pollingState) {
    console.log('[FlashFill] Polling already running, ignoring FORM_SUBMITTED');
    return;
  }

  const session = await getSession();
  if (!session) return;

  // CRITICAL FIX: To prevent an infinite loop where a newly opened Magic Link tab
  // triggers OTP_URL_DETECTED and restarts polling (which opens another tab, etc),
  // we must check if we already resolved this session.
  const history = await getHistory();
  const entry = history.find(h => h.email === session.email);
  if (entry && (entry.otp || entry.verificationLink)) {
    console.log('[FlashFill] Session already resolved, not re-polling');
    return; // Already resolved, do not re-poll!
  }

  console.log('[FlashFill] Starting OTP polling for', session.email);
  // session.token holds the MD5 email hash.
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
      case 'RESUME_SESSION':
        void handleResumeSession(message.payload.url, tabId);
        break;
      case 'FORM_SUBMITTED':
      case 'OTP_URL_DETECTED':
        void handleStartPolling(tabId);
        break;
      case 'OPEN_TAB':
        chrome.tabs.create({ url: message.payload.url, active: true });
        break;
    }
  },
);
