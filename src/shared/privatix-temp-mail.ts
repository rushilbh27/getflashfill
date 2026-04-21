/**
 * PRIVATIX TEMP MAIL CLIENT — Shared Module
 *
 * Thin wrapper around the Privatix Temp Mail RapidAPI that both the popup
 * and (optionally) the service worker can use.
 *
 * Mailbox addressing:
 *   The Privatix API identifies a mailbox by the MD5 hash of the lowercase
 *   email address. There is no "create mailbox" call — the mailbox exists
 *   implicitly once you poll for it.
 *
 * This module is intentionally side-effect-free and never touches
 * chrome.storage — it only does HTTP.
 */

import md5 from 'md5';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TempMailMessage {
  id: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  receivedAt: string;
}

// ─── Raw API shapes ───────────────────────────────────────────────────────────

interface RawMessage {
  _id?:          { $oid?: string } | string;
  mail_id?:      string;
  mail_from?:    string;
  mail_subject?: string;
  mail_text?:    string;
  mail_html?:    string;
  mail_date?:    string;
  createdAt?:    { $date?: string } | string;
  error?:        string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

const API_HOST = 'privatix-temp-mail-v1.p.rapidapi.com';
const API_BASE = `https://${API_HOST}`;

export class TempMailClient {
  private readonly headers: Record<string, string>;

  constructor(apiKey: string) {
    this.headers = {
      'Content-Type':    'application/json',
      'x-rapidapi-key':  apiKey,
      'x-rapidapi-host': API_HOST,
    };
  }

  /**
   * Fetch all messages for the given email address.
   * Returns an empty array when no messages exist yet.
   */
  async getMessages(email: string): Promise<TempMailMessage[]> {
    const hash = md5(email.toLowerCase());
    const res = await fetch(`${API_BASE}/request/mail/id/${encodeURIComponent(hash)}/`, {
      method:  'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      throw new Error(`Privatix API error: ${res.status}`);
    }

    const data: unknown = await res.json();

    let rawMessages: RawMessage[] = [];

    if (Array.isArray(data)) {
      rawMessages = data;
    } else if (data && typeof data === 'object' && 'mail' in data) {
      rawMessages = (data as { mail: RawMessage[] }).mail ?? [];
    }

    // Filter out Privatix "no messages" error objects.
    rawMessages = rawMessages.filter(
      (m) => m && !m.error && (m.mail_text || m.mail_html || m.mail_subject),
    );

    return rawMessages.map((m) => this.normalise(m));
  }

  /**
   * Fetch a single message by its mail ID.
   * Falls back to scanning the full inbox if no direct endpoint is available.
   */
  async getMessage(email: string, mailId: string): Promise<TempMailMessage | null> {
    const all = await this.getMessages(email);
    return all.find((m) => m.id === mailId) ?? null;
  }

  // ── internal ──

  private normalise(raw: RawMessage): TempMailMessage {
    let id = '';
    if (raw._id) {
      id = typeof raw._id === 'string' ? raw._id : raw._id.$oid ?? '';
    }
    if (!id && raw.mail_id) {
      id = raw.mail_id;
    }

    let receivedAt = '';
    if (raw.mail_date) {
      receivedAt = raw.mail_date;
    } else if (raw.createdAt) {
      receivedAt =
        typeof raw.createdAt === 'string'
          ? raw.createdAt
          : raw.createdAt.$date ?? '';
    }

    return {
      id,
      from:       raw.mail_from ?? '(Unknown)',
      subject:    raw.mail_subject ?? '(No Subject)',
      bodyText:   raw.mail_text ?? '',
      bodyHtml:   raw.mail_html ?? '',
      receivedAt,
    };
  }
}
