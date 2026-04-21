import md5 from 'md5';
import { generateIdentity } from '../shared/identity';
import { getApiKey, getSession, setSession, addToHistory } from '../shared/storage';
import { TempMailClient } from '../shared/privatix-temp-mail';
import type { WorkerToContentMessage } from '../shared/messages';

// Guard against concurrent handleRequestIdentity calls
let identityInFlight = false;

async function sendToTab(tabId: number, message: WorkerToContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } catch (error) {
    // Tab closed or navigated — silent failure.
  }
}

/**
 * Generate a random alphanumeric local part.
 */
function randomLocalPart(): string {
  return Math.random().toString(36).slice(2, 12);
}

export async function handleRequestIdentity(url: string, tabId: number): Promise<void> {
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
    
    if (!existing.identity) {
      existing.identity = identity;
      await setSession(existing);
    }
    
    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity } });
    return;
  }

  identityInFlight = true;
  try {
    const client = new TempMailClient(apiKey);
    const domains = await client.getAvailableDomains();
    
    if (!domains.length) throw new Error('No domains returned from Tempmail');

    const rawDomain = domains[Math.floor(Math.random() * domains.length)]!;
    const domain    = rawDomain.replace(/^@/, '');
    const local     = randomLocalPart();
    const email     = `${local}@${domain}`.toLowerCase();

    const identity = generateIdentity(email);
    const emailHash = md5(email);
    console.log('[FlashFill] Identity ready, sending to tab', tabId, identity);

    await setSession({
      email,
      token:         emailHash, 
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429')) {
      console.error('[FlashFill] API quota exhausted (429).');
    } else if (msg.includes('401') || msg.includes('403')) {
      console.error('[FlashFill] Invalid RapidAPI key — please check your settings.');
    } else {
      console.error('[FlashFill] Identity setup failed:', msg);
    }
  } finally {
    identityInFlight = false;
  }
}

export async function handleResumeSession(url: string, tabId: number): Promise<void> {
  const session = await getSession();
  if (!session || !session.identity) return;

  const currentDomain = new URL(url).hostname;
  const sessionDomain = new URL(session.associatedUrl).hostname;

  if (currentDomain === sessionDomain && (Date.now() - session.createdAt < 30 * 60 * 1000)) {
    console.log('[FlashFill] Resuming session for multi-step flow on', url);
    await sendToTab(tabId, { type: 'IDENTITY_READY', payload: { identity: session.identity, isResumed: true } });
  }
}
