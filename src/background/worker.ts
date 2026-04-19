/*
 * SERVICE WORKER — FlashFill Background Script
 *
 * Responsibilities:
 * - REQUEST_IDENTITY  → create Tempmail mailbox, build Identity, store session,
 *                       reply IDENTITY_READY to the requesting tab.
 * - FORM_SUBMITTED    → begin OTP polling (primary trigger).
 * - OTP_URL_DETECTED  → begin OTP polling if not already active (secondary trigger).
 * - Poll Tempmail inbox every 3s using a recursive setTimeout chain.
 * - chrome.alarms used for the 90-second hard-stop only (alarm name:
 *   'flashfill-otp-timeout'). Repeating alarms cannot fire every 3s in Chrome
 *   (minimum period is 1 minute), hence setTimeout for poll ticks.
 * - On OTP found: send OTP_FOUND to the content tab, stop polling.
 * - On 90s timeout: send OTP_TIMEOUT to the content tab, stop polling.
 * - Domain rotation: TODO V1.1 — auto-rotate Tempmail domains on rejection.
 *   For V1.0 we use whatever domain Tempmail assigns on mailbox creation.
 */

import { generateIdentity } from '../shared/identity';
import { getApiKey, getSession, setSession } from '../shared/storage';
import type { ContentToWorkerMessage, WorkerToContentMessage } from '../shared/messages';

// ─── constants ────────────────────────────────────────────────────────────────

const ALARM_NAME = 'flashfill-otp-timeout';
const POLL_INTERVAL_MS = 3_000;       // 3 seconds between polls
const POLL_TIMEOUT_MS  = 90_000;      // 90-second hard stop (matches PRD)
const ALARM_DELAY_MIN  = 1.5;         // 90s expressed in minutes for chrome.alarms

const API_HOST = 'tempmail.p.rapidapi.com';
const API_BASE = `https://${API_HOST}`;

// ─── API shape types ──────────────────────────────────────────────────────────

interface TempmailMailboxResponse {
  email: string;
  token: string;
}

interface TempmailMessage {
  subject: string;
  body: string;
}

class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── polling state ────────────────────────────────────────────────────────────

interface PollingState {
  mailId: string;
  token:  string;
  tabId:  number;
  startedAt: number;
  tickHandle: ReturnType<typeof setTimeout> | null;
}

let pollingState: PollingState | null = null;

// Stores the mailId produced during mailbox creation so FORM_SUBMITTED can
// start polling without needing to re-create the mailbox.
let lastMailId = '';

// ─── messaging helpers ────────────────────────────────────────────────────────

async function sendToTab(tabId: number, message: WorkerToContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab may have closed or navigated away — fail silently.
  }
}

// ─── OTP extraction ───────────────────────────────────────────────────────────

/**
 * Search a string for the most common OTP lengths.
 * Tries 6-digit first (most common), then 4-digit, then 8-digit.
 */
function extractOTP(text: string): string | null {
  const patterns: RegExp[] = [/\b(\d{6})\b/, /\b(\d{4})\b/, /\b(\d{8})\b/];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

function findOTPInMessages(messages: TempmailMessage[]): string | null {
  for (const msg of messages) {
    const otp = extractOTP(msg.subject) ?? extractOTP(msg.body);
    if (otp) return otp;
  }
  return null;
}

// ─── Tempmail API ─────────────────────────────────────────────────────────────

function rapidApiHeaders(apiKey: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-rapidapi-key':  apiKey,
    'x-rapidapi-host': API_HOST,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function createMailbox(
  mailId: string,
  apiKey: string,
): Promise<TempmailMailboxResponse> {
  const res = await fetch(
    `${API_BASE}/request/mail/id/${encodeURIComponent(mailId)}`,
    {
      method:  'POST',
      headers: rapidApiHeaders(apiKey),
    },
  );

  if (!res.ok) {
    throw new ApiError(res.status, `Tempmail create-mailbox failed: ${res.status}`);
  }

  return res.json() as Promise<TempmailMailboxResponse>;
}

async function fetchMessages(
  mailId: string,
  token:  string,
  apiKey: string,
): Promise<TempmailMessage[]> {
  const res = await fetch(
    `${API_BASE}/request/mail/id/${encodeURIComponent(mailId)}`,
    {
      method:  'GET',
      headers: rapidApiHeaders(apiKey, token),
    },
  );

  if (res.status === 429) throw new ApiError(429, 'Tempmail rate limit exceeded');
  if (!res.ok)           throw new ApiError(res.status, `Tempmail poll failed: ${res.status}`);

  return res.json() as Promise<TempmailMessage[]>;
}

// ─── polling loop ─────────────────────────────────────────────────────────────

function stopPolling(): void {
  if (!pollingState) return;
  if (pollingState.tickHandle !== null) clearTimeout(pollingState.tickHandle);
  chrome.alarms.clear(ALARM_NAME);
  pollingState = null;
}

async function pollOnce(): Promise<void> {
  if (!pollingState) return;

  // Belt-and-suspenders: if somehow the alarm hasn't fired yet but we're past
  // the window, stop ourselves.
  if (Date.now() - pollingState.startedAt >= POLL_TIMEOUT_MS) {
    const tabId = pollingState.tabId;
    stopPolling();
    await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
    return;
  }

  const apiKey = await getApiKey();  // re-read each tick (user could revoke key)
  if (!apiKey || !pollingState) return;

  try {
    const messages = await fetchMessages(
      pollingState.mailId,
      pollingState.token,
      apiKey,
    );

    const otp = findOTPInMessages(messages);
    if (otp) {
      const tabId = pollingState.tabId;
      stopPolling();
      await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: otp } });
      return;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) {
        // Rate-limited — abort immediately, don't timeout spam.
        const tabId = pollingState.tabId;
        stopPolling();
        await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
        return;
      }
      if (err.status === 401 || err.status === 403) {
        console.error('[FlashFill] API key invalid or expired');
        stopPolling();
        return;
      }
    }
    // Non-fatal — log and keep polling until timeout.
    console.error('[FlashFill] Poll error (will retry):', err);
  }

  // No OTP yet — schedule next tick. Touch storage to help keep worker alive.
  if (pollingState) {
    await getApiKey(); // lightweight storage touch = signals activity to Chrome
    pollingState.tickHandle = setTimeout(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  }
}

export function startOTPPolling(email: string, token: string, tabId: number): void {
  if (pollingState) return; // one loop at a time

  // Derive mailId from the email local part (Tempmail uses the mailId we sent
  // as the local part, so this is a safe reverse operation).
  const mailId = email.split('@')[0] ?? lastMailId;

  pollingState = {
    mailId,
    token,
    tabId,
    startedAt:  Date.now(),
    tickHandle: null,
  };

  // 90-second hard stop via alarm — survives worker restarts.
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: ALARM_DELAY_MIN });

  // First poll fires immediately.
  void pollOnce();
}

// ─── REQUEST_IDENTITY handler ─────────────────────────────────────────────────

async function handleRequestIdentity(
  url:   string,
  tabId: number,
): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) return; // User hasn't entered their RapidAPI key yet.

  // Quota protection: reuse the existing session if the URL matches.
  const existing = await getSession();
  if (existing && existing.associatedUrl === url) {
    const identity = generateIdentity(existing.email);
    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity } });
    return;
  }

  try {
    // Use a clean alphanumeric mailId (UUID without hyphens, 16 chars).
    const mailId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    lastMailId = mailId;

    const mailbox = await createMailbox(mailId, apiKey);
    const identity = generateIdentity(mailbox.email);

    await setSession({
      email:         mailbox.email,
      token:         mailbox.token,
      createdAt:     Date.now(),
      associatedUrl: url,
    });

    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity } });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        console.error('[FlashFill] Invalid RapidAPI key — prompt user to re-enter.');
      } else if (err.status === 429) {
        console.error('[FlashFill] API quota exhausted.');
      } else {
        console.error('[FlashFill] Mailbox creation failed:', err.message);
      }
    } else {
      console.error('[FlashFill] Unexpected error creating mailbox:', err);
    }
    // Do nothing else — injector will receive no IDENTITY_READY and form stays unfilled.
  }
}

// ─── FORM_SUBMITTED / OTP_URL_DETECTED handler ────────────────────────────────

async function handleStartPolling(tabId: number): Promise<void> {
  if (pollingState) return; // already polling

  const session = await getSession();
  if (!session) return;

  startOTPPolling(session.email, session.token, tabId);
}

// ─── chrome.alarms: 90-second hard stop ──────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (!pollingState) return;

  const tabId = pollingState.tabId;
  stopPolling();
  await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
});

// ─── message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: ContentToWorkerMessage,
    sender:  chrome.runtime.MessageSender,
  ) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;

    switch (message.type) {
      case 'REQUEST_IDENTITY':
        void handleRequestIdentity(message.payload.url, tabId);
        break;

      case 'FORM_SUBMITTED':
        void handleStartPolling(tabId);
        break;

      case 'OTP_URL_DETECTED':
        void handleStartPolling(tabId);
        break;
    }
  },
);
