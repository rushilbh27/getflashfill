/**
 * Extracts a verification code (OTP) from an email subject or body.
 *
 * It looks for:
 * 1. Sequences of 4-8 digits.
 * 2. Alphanumeric codes (e.g., AB12-45) if they appear near context keywords.
 * 3. Verification URLs (Magic Links).
 */
export function extractOTP(text: string): string | null {
  if (!text) return null;

  // 1. Prioritize codes following explicit "code" keywords.
  const contextPatterns = [
    /(?:code|verification|otp|pin|password|pw|identifier|ref|id)[^\d\n]{1,10}(\d{4,8})\b/i,
    /\b(\d{4,8})[^\d\n]{1,10}(?:is your|code|otp)/i,
  ];

  for (const pattern of contextPatterns) {
    const match = pattern.exec(text);
    if (match && match[1]) return match[1];
  }

  // 2. High-confidence numeric patterns (specifically 6 or 4 digits with boundaries).
  // We ignore 4-digit numbers that look like years (19xx, 20xx) unless they had context above.
  const purePatterns = [
    /\b\d{6}\b/,
    /\b(?!(?:19|20)\d{2})\d{4}\b/, // 4 digits, but not 1900-2099
    /\b\d{8}\b/,
  ];

  for (const pattern of purePatterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }

  // 3. Last resort: any 4-8 digits not surrounded by other digits.
  const fallback = /\b\d{4,8}\b/.exec(text);
  return fallback ? fallback[0] : null;
}

/**
 * Extracts the most likely verification link from an email body.
 */
export function extractLink(text: string): string | null {
  if (!text) return null;

  // Find all URLs in the text.
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  const matches = text.match(urlRegex);
  if (!matches) return null;

  // Scoring system to find the "best" link.
  const keywords = [
    { word: 'verify', score: 10 },
    { word: 'confirm', score: 10 },
    { word: 'activate', score: 10 },
    { word: 'magic', score: 8 },
    { word: 'login', score: 5 },
    { word: 'click', score: 3 },
  ];

  const ignoreList = ['unsubscribe', 'policy', 'terms', 'privacy', 'help', 'support', 'contact'];

  let bestLink: string | null = null;
  let highestScore = -1;

  for (const url of matches) {
    let score = 0;
    const lowerUrl = url.toLowerCase();

    // Skip obviously wrong links.
    if (ignoreList.some(ignore => lowerUrl.includes(ignore))) continue;

    for (const { word, score: points } of keywords) {
      if (lowerUrl.includes(word)) score += points;
    }

    if (score > highestScore) {
      highestScore = score;
      bestLink = url;
    }
  }

  // If no keywords matched, but we only have one link, take it.
  if (highestScore === 0 && matches.length === 1) {
    const singleLink = matches[0]!;
    if (!ignoreList.some(ignore => singleLink.toLowerCase().includes(ignore))) {
      return singleLink;
    }
  }

  return highestScore >= 0 ? bestLink : null;
}
