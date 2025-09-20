/**
 * misc.js
 * Small helper utilities used across handlers.
 */

import { DEFAULTS } from '../config.js';

/**
 * unique - returns array with unique, non-empty values
 * @param {Array} arr
 * @returns {Array}
 */
export const unique = (arr = []) => [...new Set((arr || []).filter(Boolean))];

/**
 * extractContactsFromHtml - extract emails, phones, social links from a raw HTML string
 * NOTE: naive extraction — good for initial enrichment, but will produce false positives sometimes.
 *
 * @param {string} html
 * @returns {{emails: string[], phones: string[], socialLinks: string[]}}
 */
export const extractContactsFromHtml = (html = '') => {
  const emails = unique([...((html.match(DEFAULTS.EMAIL_REGEX) || []))])
    // filter some obvious junk addresses (example)
    .filter(e => !/example\./i.test(e));
  const phones = unique([...((html.match(DEFAULTS.PHONE_REGEX) || []))]);
  const socialLinks = unique([...((html.match(DEFAULTS.SOCIAL_REGEX) || []))]);
  return { emails, phones, socialLinks };
};

/**
 * normalizeSiteOrigin - given a URL string, return origin (scheme + host) or null
 */
export const normalizeSiteOrigin = (url) => {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
};