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

  // Remove URLs to avoid falsely extracting tokens or IDs embedded within them.
  const textWithoutUrls = text.replace(/https?:\/\/[^\s"'<>]+/g, '');

  // Strip HTML tags so <h1>123456</h1> just becomes 123456
  const cleanText = textWithoutUrls.replace(/<[^>]+>/g, ' ');

  // 1. Prioritize codes following explicit keywords.
  //    Collect ALL matches, then prefer the longest (6-digit beats 4-digit).
  const contextPatterns = [
    /(?:code|verify|verification|otp|pin|password|pw|identifier|ref|id)[\s\S]{1,60}?\b(\d{4,8})\b/gi,
    /\b(\d{4,8})[\s\S]{1,60}?(?:is your|code|otp)/gi,
    // Alphanumeric support for 6-to-8 char codes (e.g. 29457F12) if near keywords. Require at least one digit to avoid normal words.
    /(?:code|verify|verification|otp|pin|password)[\s\S]{1,60}?\b(?=[a-z0-9]*[0-9])([a-z0-9]{6,8})\b/gi
  ];

  const contextMatches: string[] = [];
  for (const pattern of contextPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleanText)) !== null) {
      if (match[1]) contextMatches.push(match[1]);
    }
  }
  if (contextMatches.length > 0) {
    // Return the longest match — prefer the FIRST match of the longest length since earlier patterns are higher confidence.
    return contextMatches.reduce((best, cur) => cur.length > best.length ? cur : best).toUpperCase();
  }

  // 2. High-confidence numeric patterns — check 6/8 digits BEFORE 4 to prefer longer codes.
  const purePatterns = [
    /\b\d{6}\b/,
    /\b\d{8}\b/,
    /\b(?!(?:19|20)\d{2})\d{4}\b/, // 4 digits, but not 1900-2099
    // Pure alphanumeric 6-to-8 char code (must contain both letters and numbers to avoid matching words like "VERIFY")
    /\b(?=[a-zA-Z0-9]*[0-9])(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{6,8}\b/
  ];

  for (const pattern of purePatterns) {
    const match = pattern.exec(cleanText);
    if (match) return match[0].toUpperCase();
  }

  // 3. Last resort: 5 or 7 digits.
  const fallback = /\b(?:\d{5}|\d{7})\b/.exec(cleanText);
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
    { word: 'auth', score: 5 },
    { word: 'token', score: 5 },
    { word: 'session', score: 5 },
    { word: 'click', score: 3 },
    { word: 'continue', score: 3 },
  ];

  const ignoreList = [
    'unsubscribe', 'policy', 'terms', 'privacy', 'help', 'support', 'contact', 
    '.png', '.jpg', '.jpeg', '.gif', 'w3.org', 'schema.org'
  ];

  let bestLink: string | null = null;
  let highestScore = 0;
  
  // Keep track of valid links in case we need a fallback
  const validLinks: string[] = [];

  for (const url of matches) {
    let score = 0;
    const lowerUrl = url.toLowerCase();

    // Skip obviously wrong or static asset links.
    if (ignoreList.some(ignore => lowerUrl.includes(ignore))) continue;
    
    validLinks.push(url);

    for (const { word, score: points } of keywords) {
      if (lowerUrl.includes(word)) score += points;
    }

    if (score > highestScore) {
      highestScore = score;
      bestLink = url;
    }
  }

  // If no keywords matched, but we have valid links, 
  // return the longest one (verification links with tokens are typically very long).
  if (highestScore === 0 && validLinks.length > 0) {
    return validLinks.reduce((longest, current) => 
      current.length > longest.length ? current : longest
    );
  }

  return bestLink;
}
