/*
 * MUTATION OBSERVER — Content Script
 *
 * Responsibilities:
 * - Watch for dynamically injected DOM elements using MutationObserver
 * - Specifically watch for signup modals and popups added after page load
 * - On new node detection: pass to detector.ts to check for email fields
 * - Also watch for URL changes (SPA navigation) and re-run detector
 * - Watch for OTP-pattern URLs: if URL contains 'verify', 'otp', or 'code'
 *   send OTP_URL_DETECTED message to service worker as secondary trigger
 */

export {};
