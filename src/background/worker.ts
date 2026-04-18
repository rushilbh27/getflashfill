/*
 * SERVICE WORKER — FlashFill Background Script
 *
 * Responsibilities:
 * - Receive FORM_SUBMITTED message from content script → begin OTP polling
 * - Receive OTP_URL_DETECTED message → begin OTP polling if not already active
 * - Poll Tempmail RapidAPI every 3 seconds for new emails
 * - Hard stop polling after 90 seconds
 * - Extract OTP from email body using regex (4, 6, or 8 digit codes)
 * - Send OTP_FOUND message back to content script
 * - Send OTP_TIMEOUT if 90 seconds pass with no OTP
 * - Handle domain rotation if DOMAIN_REJECTED is triggered
 * - Read API key from chrome.storage.local before making any API calls
 */

export {};
