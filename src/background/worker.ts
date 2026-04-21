/**
 * SERVICE WORKER — FlashFill Background Script
 *
 * This version has been refactored to use modular managers for identity
 * and polling logic, keeping the main worker file clean and focused on
 * message routing and system events.
 */

import { handleRequestIdentity, handleResumeSession } from './identity-manager';
import { handleStartPolling, handleAlarmTimeout } from './polling-manager';
import { ALARM_NAME } from './constants';
import type { ContentToWorkerMessage } from '../shared/messages';

// ─── chrome.alarms hard-stop ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // handleAlarmTimeout snapshots pollingState.tabId before stopping
  // and sends OTP_TIMEOUT to the signup tab.
  void handleAlarmTimeout();
});

// ─── message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ContentToWorkerMessage, sender: chrome.runtime.MessageSender) => {
    const tabId = sender.tab?.id;
    console.log('[FlashFill] Worker received message:', message.type, 'from tab', tabId ?? 'popup');

    // REQUEST_IDENTITY can legitimately come from the popup (↻ New button),
    // in which case sender.tab is undefined. Look up the active tab instead.
    if (message.type === 'REQUEST_IDENTITY' && tabId === undefined) {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id && message.payload?.url) {
          void handleRequestIdentity(message.payload.url, tab.id);
        }
      });
      return;
    }

    // All other messages MUST originate from a content script (have a tab).
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

console.log('[FlashFill] Background service worker initialized.');
