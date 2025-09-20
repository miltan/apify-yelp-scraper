/**
 * detail-handler.js
 *
 * Handles a Yelp business detail page: extracts name, address, rating, phone,
 * website (if present) and then optionally calls website-scraper to enrich contacts.
 *
 * Exported function: handleDetailPage({ page, request, Dataset, log, input })
 *
 * NOTE: This file is intentionally modular — small and testable.
 */

import { extractContactsFromHtml, unique, normalizeSiteOrigin } from '../helpers/misc.js';
import { fetchWebsiteAndContacts } from './website-scraper.js';
import { Dataset } from '@crawlee/playwright';

/**
 * extractJsonLd - find JSON-LD and parse LocalBusiness blocks
 */
async function extractJsonLd(page) {
  const handles = await page.locator('script[type="application/ld+json"]').all();
  for (const h of handles) {
    try {
      const txt = await h.textContent();
      if (!txt) continue;
      const parsed = JSON.parse(txt);
      const blocks = Array.isArray(parsed) ? parsed : [parsed];
      for (const b of blocks) {
        if (b['@type'] && (b['@type'] === 'LocalBusiness' || b['@type'] === 'Organization')) {
          return b;
        }
      }
    } catch {
      // ignore broken JSON-LD blocks
    }
  }
  return null;
}

export async function handleDetailPage({ page, request, log, input }) {
  await page.waitForLoadState('domcontentloaded');

  // Try structured data first
  const ld = await extractJsonLd(page);

  const name = ld?.name || (await page.locator('h1').first().textContent())?.trim() || null;

  // phone from JSON-LD or tel: link
  let phone = ld?.telephone || null;
  if (!phone) {
    try {
      const tel = await page.locator('a[href^="tel:"]').first().getAttribute('href');
      phone = tel ? tel.replace('tel:', '') : null;
    } catch {}
  }

  // Address
  const address = ld?.address
    ? (typeof ld.address === 'string'
        ? ld.address
        : [ld.address.streetAddress, ld.address.addressLocality, ld.address.addressRegion, ld.address.postalCode]
            .filter(Boolean)
            .join(', '))
    : (await page.locator('address').first().textContent())?.trim() || null;

  // Categories - fallback scanner
  let categories = [];
  try {
    categories = (await page.locator('a[href^="/search?cflt="]').allTextContents()).map((t) => t.trim()).filter(Boolean);
  } catch {}

  // Rating
  const rating =
    ld?.aggregateRating?.ratingValue ??
    (await page.locator('[aria-label$="star rating"], div[role="img"][aria-label*="star"]').first().getAttribute('aria-label'))
      ?.match(/([\d.]+)\s*star/i)?.[1] ??
    null;

  // Website extraction (Yelp sometimes uses redirect link or direct link)
  let website = null;
  try {
    const websiteLink = await page.locator('a[href^="http"]:has-text("website"), a:has-text("Business website"), a:has-text("Website")').first();
    if (await websiteLink.isVisible()) website = await websiteLink.getAttribute('href');
  } catch {}
  if (!website) {
    // try outbound redirect pattern (biz_redir)
    try {
      const outbound = await page.locator('a[href*="biz_redir?url="]').first().getAttribute('href').catch(() => null);
      if (outbound) {
        const u = new URL(outbound, 'https://www.yelp.com');
        const real = u.searchParams.get('url');
        if (real) website = decodeURIComponent(real);
      }
    } catch {}
  }

  // Prepare enrichment via business website
  let websiteOrigin = null;
  if (website) websiteOrigin = normalizeSiteOrigin(website);

  let contacts = { emails: [], phones: [], socialLinks: [] };
  if (input.fetchContactsFromWebsite && websiteOrigin) {
    try {
      contacts = await fetchWebsiteAndContacts(websiteOrigin, input.contactPagePaths || []);
    } catch (err) {
      log.warning('Website enrichment failed', { url: websiteOrigin, error: err.message });
    }
  }

  // Build item and store to Dataset
  const item = {
    scrapedAt: new Date().toISOString(),
    name,
    categories: unique(categories),
    rating: rating ? Number(rating) : null,
    phone,
    address,
    yelpUrl: request.url,
    website: websiteOrigin,
    emails: contacts.emails,
    phonesFromWebsite: contacts.phones,
    socialLinks: contacts.socialLinks,
  };

  await Dataset.pushData(item);
  log.info(`Saved business: ${name || '(no name)'} — ${request.url}`);
}