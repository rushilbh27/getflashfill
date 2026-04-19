/**
 * Extracts a numeric OTP / verification code from an email subject or body.
 *
 * Patterns are tried in priority order:
 *   1. 6-digit codes (most common)
 *   2. 4-digit codes
 *   3. 8-digit codes
 *
 * Word boundaries (\b) ensure that longer digit sequences such as phone
 * numbers (10+ digits) are never matched.
 *
 * @param text - Plain-text email subject or body.
 * @returns The first matching code as a string, or null if none is found.
 */
export function extractOTP(text: string): string | null {
  const patterns = [
    /\b\d{6}\b/,
    /\b\d{4}\b/,
    /\b\d{8}\b/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }

  return null;
}
