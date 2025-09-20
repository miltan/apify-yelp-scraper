/**
 * search-handler.js
 *
 * Handles Yelp search pages: extracts business detail links and next page links.
 *
 * Exported function: handleSearchPage({ page, request, enqueueLinks, log })
 *
 * This module uses Playwright page locators and returns enqueued requests with label 'DETAIL' or 'SEARCH'.
 *
 * Note: Selector strategies are intentionally broad because Yelp changes layout often.
 */

export async function handleSearchPage({ page, request, enqueueLinks, log }) {
  // Wait for the main content that usually contains business cards
  await page.waitForLoadState('domcontentloaded');

  // Business links typically begin with /biz/
  const bizAnchors = await page.locator('a[href^="/biz/"]').all();

  const requests = [];
  for (const a of bizAnchors) {
    try {
      const href = await a.getAttribute('href');
      if (!href) continue;
      // Avoid links that are just anchors or duplicates
      const full = new URL(href, 'https://www.yelp.com').toString();
      requests.push({ url: full, userData: { label: 'DETAIL' } });
    } catch (e) {
      // ignore bad anchors
    }
  }

  // Pagination: try common selectors for "Next"
  const nextLocator = page.locator('a.next-link, a[aria-label="Next"], a[rel="next"]').first();
  if (await nextLocator.count()) {
    const nextHref = await nextLocator.getAttribute('href');
    if (nextHref) {
      requests.push({ url: new URL(nextHref, 'https://www.yelp.com').toString(), userData: { label: 'SEARCH' } });
    }
  }

  if (requests.length) await enqueueLinks({ requests });

  log.info(`Search page processed: enqueued ${requests.length} requests from ${request.url}`);
}