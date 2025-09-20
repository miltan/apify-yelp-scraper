/**
 * main.js
 *
 * Orchestration entrypoint. Creates PlaywrightCrawler with handlers wired to the modules above.
 *
 * IMPORTANT:
 * - Make sure you set "Use Apify Proxy" and choose RESIDENTIAL in the Apify Actor settings for production
 *   (Yelp blocks aggressive scrapers).
 * - This script aims for readability; in production you may want to add advanced error metrics, retries,
 *   request prioritization, and resume-from-cursor functionality.
 */

import { Actor, log } from '@apify/actor';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { createProxyConfiguration } from '@crawlee/proxy';
import { handleSearchPage } from './crawler/search-handler.js';
import { handleDetailPage } from './crawler/detail-handler.js';

await Actor.init();

try {
  // Read input (input schema defined at the root)
  const input = (await Actor.getInput()) || {};

  const {
    search,
    location,
    yelpSearchUrl,
    maxResults = 200,
    fetchContactsFromWebsite = true,
    contactPagePaths = ['/contact', '/contact-us', '/about', '/about-us'],
    useResidentialProxy = true,
    proxyCountryCode = 'US',
    maxConcurrency = 5,
    debugScreenshots = true,
  } = input;

  // Build start URL from search+location if yelpSearchUrl not provided
  const buildYelpSearchUrl = (searchTerm, loc) => {
    const params = new URLSearchParams({
      find_desc: searchTerm || '',
      find_loc: loc || '',
    });
    return `https://www.yelp.com/search?${params.toString()}`;
  };

  const startUrl = yelpSearchUrl?.trim() ? yelpSearchUrl.trim() : buildYelpSearchUrl(search, location);
  log.info(`Start URL: ${startUrl}`);

  // Proxy configuration for Apify Proxy (residential recommended)
  const proxyConfiguration = await createProxyConfiguration(
    useResidentialProxy ? { groups: ['RESIDENTIAL'], countryCode: proxyCountryCode } : {}
  );

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: Math.max(1000, maxResults * 3),
    maxConcurrency,
    proxyConfiguration,
    // lightweight anti-bot mitigations + resource blocking to speed up crawls
    preNavigationHooks: [
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.route('**/*', (route) => {
          const url = route.request().url();
          // block images/fonts/analytics for speed and stealth
          if (/\.(png|jpg|jpeg|gif|svg|woff2?|ttf)$/.test(url)) return route.abort();
          if (/doubleclick|google-analytics|googletag|facebook\.net/.test(url)) return route.abort();
          return route.continue();
        });
      },
    ],
    navigationTimeoutSecs: 45,
    requestHandler: async (context) => {
      const { page, request, enqueueLinks, log: ctxLog } = context;
      const label = request.userData?.label ?? 'SEARCH';

      // Simple cookie modal handling
      try {
        const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("I agree")');
        if (await cookieBtn.first().isVisible({ timeout: 1000 })) {
          await cookieBtn.first().click({ delay: 100 });
        }
      } catch {}

      if (label === 'SEARCH') {
        await handleSearchPage({ page, request, enqueueLinks, log: ctxLog });
      } else if (label === 'DETAIL') {
        // Pass the whole input so detail-handler can use contactPagePaths & fetchContactsFromWebsite flag
        await handleDetailPage({ page, request, log: ctxLog, input });
      } else {
        ctxLog.info(`Unknown label ${label} for ${request.url}`);
      }
    },
    failedRequestHandler: async ({ request, err, page }) => {
      log.warning(`Request failed: ${request.url} — ${err?.message}`);
      if (debugScreenshots && page) {
        try {
          const path = `./storage/${Date.now()}_fail.png`;
          await page.screenshot({ path, fullPage: true });
          log.info(`Saved screenshot ${path}`);
        } catch (e) {
          log.warning('Screenshot save failed', { error: e.message });
        }
      }
    },
  });

  // seed crawler
  await crawler.addRequests([{ url: startUrl, userData: { label: 'SEARCH' } }]);
  await crawler.run();

  log.info('Crawl finished — check Dataset for results.');
} finally {
  await Actor.exit();
}