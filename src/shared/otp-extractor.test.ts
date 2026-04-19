// Tests for extractOTP — run with: npx vitest
import { describe, it, expect } from 'vitest';
import { extractOTP } from './otp-extractor';

describe('extractOTP', () => {
  it('extracts a 6-digit code from a sentence', () => {
    expect(extractOTP('Your verification code is 123456')).toBe('123456');
  });

  it('extracts a 4-digit code from a sentence', () => {
    expect(extractOTP('Code: 5544. Do not share this code.')).toBe('5544');
  });

  it('extracts an 8-digit code', () => {
    expect(extractOTP('Your one-time password is 87654321')).toBe('87654321');
  });

  it('prefers a 6-digit code over a 4-digit code in the same text', () => {
    expect(extractOTP('PIN: 1234. Full code: 987654')).toBe('987654');
  });

  it('returns null when there is no numeric code', () => {
    expect(extractOTP('No code in this email')).toBeNull();
  });

  it('returns null for a phone number (10+ digits)', () => {
    expect(extractOTP('Please call us at 5551234567 for support')).toBeNull();
  });

  it('returns null for another long number (11 digits)', () => {
    expect(extractOTP('Reference: 12345678901')).toBeNull();
  });

  it('extracts a code from a multi-line email body', () => {
    const body = `Hello,\n\nWelcome to Acme.\n\nYour code is 294018.\n\nExpires in 10 minutes.`;
    expect(extractOTP(body)).toBe('294018');
  });

  it('extracts a code from a short subject line', () => {
    expect(extractOTP('Your OTP: 7392')).toBe('7392');
  });

  it('returns null for an empty string', () => {
    expect(extractOTP('')).toBeNull();
  });
});
