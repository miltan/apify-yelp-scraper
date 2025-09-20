/**
 * website-scraper.js
 *
 * Responsible for fetching a site's homepage and a list of candidate contact pages
 * and extracting contacts (emails/phones/social links).
 *
 * Uses @apify/got-scraping for HTTP requests — faster than headless browser for simple HTML extraction.
 *
 * Exported function:
 *   fetchWebsiteAndContacts(baseUrl, contactPaths, gotScrapingInstance)
 *
 * The function returns { emails, phones, socialLinks }.
 */

import { gotScraping } from '@apify/got-scraping';
import { extractContactsFromHtml } from '../helpers/misc.js';
import { DEFAULTS } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetchWebsiteAndContacts
 * @param {string} baseUrl - homepage origin e.g. 'https://example.com'
 * @param {string[]} contactPaths - ['/contact', '/about']
 * @param {object} options - { timeoutMs, maxRetries }
 * @returns {Promise<{emails: string[], phones: string[], socialLinks: string[]}>}
 */
export const fetchWebsiteAndContacts = async (baseUrl, contactPaths = [], options = {}) => {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRetries = options.maxRetries ?? 1;

  if (!baseUrl) return { emails: [], phones: [], socialLinks: [] };

  const tried = new Set();
  const results = { emails: [], phones: [], socialLinks: [] };

  const urlsToTry = [baseUrl, ...(contactPaths || []).map((p) => new URL(p, baseUrl).toString())];

  for (const url of urlsToTry) {
    const cleaned = url.replace(/#.*$/, '');
    if (tried.has(cleaned)) continue;
    tried.add(cleaned);

    try {
      const res = await gotScraping({
        url: cleaned,
        timeout: { request: timeoutMs },
        retry: { limit: maxRetries },
        headers: {
          // appear more like a real browser
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      const { emails, phones, socialLinks } = extractContactsFromHtml(res.body || '');
      results.emails.push(...emails);
      results.phones.push(...phones);
      results.socialLinks.push(...socialLinks);

      // stop early if we found an email (common requirement)
      if (results.emails.length) break;
    } catch (err) {
      // silent fail — caller only wants best-effort enrichment
      // optionally you can log the error to Dataset or KeyValue store
    }

    // polite delay
    await sleep(DEFAULTS.WEBSITE_REQUEST_DELAY);
  }

  // dedupe results
  return {
    emails: unique(results.emails || []),
    phones: unique(results.phones || []),
    socialLinks: unique(results.socialLinks || []),
  };
};