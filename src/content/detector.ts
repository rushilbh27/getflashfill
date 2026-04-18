/*
 * FORM DETECTOR — Content Script
 *
 * Responsibilities:
 * - Run on DOMContentLoaded
 * - Scan DOM for email input fields by checking:
 *     name, id, placeholder, aria-label attributes
 *     for keywords: email, mail, user_email, username
 * - Check parent form for password or signup signals to avoid false positives
 * - Ignore: search bars, contact forms, newsletter footers
 * - On detection: trigger injector.ts with the found field reference
 * - Silent fail if no form found — show no errors to user
 */

export {};
