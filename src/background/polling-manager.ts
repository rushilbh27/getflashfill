import { extractOTP, extractLink } from '../shared/otp-extractor';
import { getApiKey, getSession, updateHistoryEntry, getHistory, getAutoVerify } from '../shared/storage';
import { ALARM_NAME, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, ALARM_DELAY_MIN } from './constants';
import { TempMailClient } from '../shared/privatix-temp-mail';
import type { WorkerToContentMessage } from '../shared/messages';

interface PollingState {
  emailHash:  string;
  tabId:      number;
  startedAt:  number;
  tickHandle: ReturnType<typeof setTimeout> | null;
}

let pollingState: PollingState | null = null;

async function sendToTab(tabId: number, message: WorkerToContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } catch (error) {
    // Tab closed — silent failure.
  }
}

export function stopPolling(): void {
  if (!pollingState) return;
  if (pollingState.tickHandle !== null) clearTimeout(pollingState.tickHandle);
  void chrome.alarms.clear(ALARM_NAME);
  pollingState = null;
}

async function pollOnce(): Promise<void> {
  if (!pollingState) return;

  if (Date.now() - pollingState.startedAt >= POLL_TIMEOUT_MS) {
    const tabId = pollingState.tabId;
    stopPolling();
    await sendToTab(tabId, { type: 'OTP_TIMEOUT' });
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey || !pollingState) return;

  try {
    const client = new TempMailClient(apiKey);
    const session = await getSession();
    if (!session || !pollingState) return;

    const messages = await client.getMessages(session.email);

    const textContext = messages.map(m => `${m.subject} ${m.bodyText} ${m.bodyHtml}`).join(' ');
    const otp = extractOTP(textContext);
    const link = extractLink(textContext);

    if (otp || link) {
      const tabId = pollingState.tabId;
      const updates: any = {};
      if (otp) updates.otp = otp;
      if (link) updates.verificationLink = link;
      await updateHistoryEntry(session.email, updates);
      
      stopPolling();

      if (link) {
        try {
          chrome.runtime.sendMessage({ type: 'LINK_FOUND', payload: { url: link } });
        } catch {}
      }

      if (link && !otp) {
        const autoVerify = await getAutoVerify();
        let bgTabId: number | undefined;

        if (autoVerify) {
          try {
            const bgTab = await chrome.tabs.create({ url: link, active: false });
            bgTabId = bgTab.id;
          } catch (e) {
            console.warn('[FlashFill] Failed to open background tab:', e);
          }
        }

        await sendToTab(tabId, {
          type: 'SHOW_TOAST',
          payload: {
            message: autoVerify
              ? '⚡ Verification link opened! Try refreshing this page.'
              : '✉️ Verification email arrived! Open FlashFill → tap ⚡ Verify.',
          },
        });

        if (autoVerify) {
          setTimeout(async () => {
            if (bgTabId !== undefined) {
              try { await chrome.tabs.remove(bgTabId); } catch {}
            }
            sendToTab(tabId, {
              type: 'SHOW_TOAST',
              payload: { message: '🔗 Still not verified? Open FlashFill → tap ⚡ Verify.' },
            }).catch(() => {});
          }, 6000);
        }
      } else {
        await sendToTab(tabId, { type: 'OTP_FOUND', payload: { code: otp as string, link: link } });
      }
      return;
    }
  } catch (err) {
    console.error('[FlashFill] Poll error:', err);
  }

  if (pollingState) {
    pollingState.tickHandle = setTimeout(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  }
}

export function startOTPPolling(emailHash: string, tabId: number): void {
  if (pollingState) return;

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

export async function handleStartPolling(tabId: number): Promise<void> {
  if (pollingState) return;

  const session = await getSession();
  if (!session) return;

  const history = await getHistory();
  const entry = history.find(h => h.email === session.email);
  if (entry && (entry.otp || entry.verificationLink)) {
    return;
  }

  console.log('[FlashFill] Starting OTP polling for', session.email);
  startOTPPolling(session.token, tabId);
}

/**
 * Called by the chrome.alarms hard-stop handler.
 * Snapshots tabId BEFORE clearing pollingState (stopPolling nullifies it),
 * then notifies the content script that the timeout expired.
 */
export async function handleAlarmTimeout(): Promise<void> {
  if (!pollingState) return;
  const tabId = pollingState.tabId;
  stopPolling();
  // Notify the tab that the 90-second deadline was hit.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'OTP_TIMEOUT' } as WorkerToContentMessage).catch(() => {});
  } catch { /* tab closed */ }
}
