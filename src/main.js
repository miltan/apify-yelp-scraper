// main.js
import { Actor, log } from '@apify/actor';
import { PlaywrightCrawler, Dataset } from '@crawlee/playwright';
import { gotScraping } from '@apify/got-scraping';

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------
   Helper utilities
   ------------------------------ */

const unique = (arr) => [...new Set((arr || []).filter(Boolean))];

const safeText = async (locator) => {
  try {
    if (!locator) return null;
    const count = await locator.count();
    if (!count) return null;
    return (await locator.first().textContent())?.trim() || null;
  } catch {
    return null;
  }
};

const extractJsonLd = async (page) => {
  try {
    const scripts = await page.locator('script[type="application/ld+json"]').all();
    for (const s of scripts) {
      try {
        const txt = await s.textContent();
        if (!txt) continue;
        const parsed = JSON.parse(txt);
        const blocks = Array.isArray(parsed) ? parsed : [parsed];
        for (const b of blocks) {
          if (!b) continue;
          const t = b['@type'];
          if (!t) continue;
          // Yelp uses LocalBusiness / Organization / ProfessionalService etc.
          if (['LocalBusiness', 'Organization', 'ProfessionalService', 'MedicalBusiness'].includes(t)) {
            return b;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const extractContactsFromHtml = (html) => {
  if (!html) return { emails: [], phones: [], socialLinks: [] };

  // Email regex - avoid data:image and javascript: etc.
  const emailMatches = Array.from(html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)).map(m => m[0]);
  const emails = unique(emailMatches).filter(e => !/example|test/.test(e.toLowerCase()));

  // Phone regex — permissive but filtered
  const phoneMatches = Array.from(html.matchAll(/(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]?\d{3,4}/g)).map(m => m[0]);
  const phones = unique(phoneMatches).filter(p => p.replace(/[^\d]/g, '').length >= 7);

  // Social links - common platforms
  const socialMatches = Array.from(html.matchAll(/https?:\/\/(?:www\.)?(facebook|fb|instagram|twitter|x\.com|linkedin|youtube|tiktok)\.com\/[^\s"'<>)]+/gi)).map(m => m[0]);
  const socialLinks = unique(socialMatches);

  return { emails, phones, socialLinks };
};

const fetchWebsiteAndContacts = async (baseUrl, contactPaths, gotOptions = {}) => {
  const results = { emails: [], phones: [], socialLinks: [] };
  if (!baseUrl) return results;

  const tried = new Set();
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const urlsToTry = [normalizedBase, ...contactPaths.map(p => new URL(p, normalizedBase).toString())];

  for (const url of urlsToTry) {
    try {
      const clean = url.replace(/#.*$/, '');
      if (tried.has(clean)) continue;
      tried.add(clean);

      const res = await gotScraping({ url: clean, timeout: 15000, retry: { limit: 1 }, ...gotOptions });
      if (!res || !res.body) continue;

      const { emails, phones, socialLinks } = extractContactsFromHtml(res.body);
      results.emails.push(...emails);
      results.phones.push(...phones);
      results.socialLinks.push(...socialLinks);

      // stop early if we found at least one email and one phone
      if (results.emails.length > 0 && results.phones.length > 0) break;

      // small polite delay
      await SLEEP(300 + Math.random() * 400);
    } catch (err) {
      // log but continue trying other pages
      log.debug(`Error fetching website ${url}: ${err.message}`);
    }
  }

  results.emails = unique(results.emails);
  results.phones = unique(results.phones);
  results.socialLinks = unique(results.socialLinks);
  return results;
};

/* ------------------------------
   Main
   ------------------------------ */

await Actor.init();

try {
  // Read input once, use throughout
  const input = await Actor.getInput() || {};
  const {
    search = 'plumber',
    location = 'San Francisco, CA',
    yelpSearchUrl = '',
    maxResults = 200,
    fetchContactsFromWebsite = true,
    contactPagePaths = ['/contact', '/contact-us', '/about', '/about-us'],
    useResidentialProxy = true,
    proxyCountryCode = 'US',
    maxConcurrency = 5,
    debugScreenshots = true,
    websiteFetchLimit = 1, // per business: number of pages to fetch from external website before giving up
  } = input;

  const buildYelpSearchUrl = (s, loc) => {
    const params = new URLSearchParams({ find_desc: s || '', find_loc: loc || '' });
    return `https://www.yelp.com/search?${params.toString()}`;
  };

  const startUrl = (yelpSearchUrl && yelpSearchUrl.trim()) ? yelpSearchUrl.trim() : buildYelpSearchUrl(search, location);
  log.info(`Start URL: ${startUrl}`);

  // Create proxy configuration using Actor helper (Apify environment) if requested
  const proxyConfiguration = await Actor.createProxyConfiguration(
    useResidentialProxy ? { groups: ['RESIDENTIAL'], countryCode: proxyCountryCode } : {}
  );

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: Math.max(500, maxResults * 3),
    maxConcurrency,
    proxyConfiguration,
    // Use lightweight fingerprints
    browserPoolOptions: {
      useFingerprints: true,
      fingerprintOptions: { devices: ['desktop'], locales: ['en-US'] },
    },
    preNavigationHooks: [
      async ({ page }) => {
        // small anti-bot mitigations
        try {
          await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          });
        } catch {}
        // block heavy static assets
        try {
          await page.route('**/*', (route) => {
            const url = route.request().url();
            if (/\.(png|jpg|jpeg|gif|svg|woff2?|ttf|ico)$/.test(url)) return route.abort();
            if (/doubleclick|google-analytics|googletag|facebook\.net|analytics/.test(url)) return route.abort();
            return route.continue();
          });
        } catch {}
      },
    ],
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    requestHandler: async ({ page, request, enqueueLinks, log }) => {
      const label = request.userData?.label || 'SEARCH';

      // Try to close any cookie banners politely
      try {
        const acceptBtns = page.locator('button:has-text("Accept"), button:has-text("AGREE"), button:has-text("I Accept")');
        if (await acceptBtns.count()) {
          const visible = acceptBtns.filter({ hasText: /accept|agree/i });
          if (await visible.count()) {
            await visible.first().click({ timeout: 2000 }).catch(() => {});
          }
        }
      } catch {}

      if (label === 'SEARCH') {
        await page.waitForLoadState('domcontentloaded');
        // Find business links from search results (hrefs starting with /biz/)
        try {
          const linkHandles = await page.locator('a[href^="/biz/"]').elementHandles();
          const reqs = [];
          for (const h of linkHandles) {
            try {
              const href = await h.getAttribute('href');
              if (!href) continue;
              // ignore review links with anchors etc.
              const full = new URL(href, 'https://www.yelp.com').toString();
              reqs.push({ url: full, userData: { label: 'DETAIL' } });
            } catch {}
          }

          // Pagination: 'Next' link or rel=next
          try {
            const next = page.locator('a[rel="next"], a.next-link, a[aria-label="Next"]');
            if (await next.count()) {
              const nhref = await next.first().getAttribute('href');
              if (nhref) {
                reqs.push({ url: new URL(nhref, 'https://www.yelp.com').toString(), userData: { label: 'SEARCH' } });
              }
            }
          } catch {}

          if (reqs.length) await enqueueLinks({ requests: reqs });
          log.info(`SEARCH page: enqueued ${reqs.length} items from ${request.url}`);
        } catch (err) {
          log.warning(`Failed to process SEARCH page ${request.url}: ${err.message}`);
        }
      } else if (label === 'DETAIL') {
        await page.waitForLoadState('domcontentloaded');

        try {
          // JSON-LD attempt
          const ld = await extractJsonLd(page);

          const name = ld?.name ?? (await safeText(page.locator('h1'))) ?? null;

          // phone from JSON-LD or tel: link
          let phone = ld?.telephone ?? null;
          if (!phone) {
            try {
              const tel = page.locator('a[href^="tel:"]');
              if (await tel.count()) {
                const href = await tel.first().getAttribute('href');
                if (href) phone = href.replace(/^tel:/, '').trim();
              }
            } catch {}
          }

          // Address
          let address = null;
          try {
            if (ld?.address) {
              if (typeof ld.address === 'string') address = ld.address;
              else {
                const parts = [
                  ld.address.streetAddress,
                  ld.address.addressLocality,
                  ld.address.addressRegion,
                  ld.address.postalCode,
                ].filter(Boolean);
                address = parts.join(', ');
              }
            } else {
              address = (await safeText(page.locator('address'))) ?? null;
            }
          } catch {}

          // Categories - fallback to category links
          let categories = [];
          if (ld?.@type && ld?.category) {
            categories = Array.isArray(ld.category) ? ld.category : [ld.category];
          } else {
            try {
              const catHandles = await page.locator('a[href*="/search?cflt="], span[class*="category"] a').allTextContents();
              categories = catHandles.map(t => t.trim()).filter(Boolean);
            } catch {}
          }
          categories = unique(categories);

          // Rating
          let rating = null;
          if (ld?.aggregateRating?.ratingValue) rating = Number(ld.aggregateRating.ratingValue);
          else {
            try {
              const r = await page.locator('[aria-label$="star rating"], div[role="img"][aria-label*="star"]').first().getAttribute('aria-label');
              if (r) {
                const m = r.match(/([\d.]+)\s*star/i);
                if (m) rating = Number(m[1]);
              }
            } catch {}
          }

          // Review count
          let reviewCount = null;
          try {
            const rcText = await safeText(page.locator('p:has-text("reviews"), a[href$="#reviews"], span:has-text("reviews")'));
            if (rcText) {
              const num = rcText.replace(/[^\d]/g, '');
              if (num) reviewCount = Number(num);
            }
          } catch {}

          // Website detection - direct link text patterns, or yelp redirect
          let website = null;
          try {
            const siteSelectors = [
              'a[href^="http"]:has-text("Website")',
              'a:has-text("Business website")',
              'a:has-text("Visit website")',
              'a[href*="biz_redir?url="]',
            ];
            for (const sel of siteSelectors) {
              try {
                const loc = page.locator(sel);
                if (await loc.count()) {
                  const href = await loc.first().getAttribute('href');
                  if (!href) continue;
                  // If it's a redirect via query param
                  if (href.includes('biz_redir') || href.includes('redirect')) {
                    try {
                      const u = new URL(href, 'https://www.yelp.com');
                      const real = u.searchParams.get('url') || u.searchParams.get('u');
                      if (real) {
                        website = decodeURIComponent(real);
                        break;
                      }
                    } catch {}
                  } else {
                    // absolute URL usually
                    try {
                      website = new URL(href, 'https://www.yelp.com').toString();
                      break;
                    } catch {}
                  }
                }
              } catch {}
            }
          } catch {}

          // Price level
          let priceLevel = null;
          try {
            const pl = await safeText(page.locator('span:has-text("$"), span.price-range'));
            if (pl) priceLevel = pl.trim();
          } catch {}

          // Build item & optionally fetch contacts from external website
          let contacts = { emails: [], phones: [], socialLinks: [] };
          if (website) {
            // canonicalize to origin when possible (so we try homepage + contact paths)
            try {
              const u = new URL(website);
              const origin = `${u.protocol}//${u.hostname}`;
              // fetch only if enabled
              if (fetchContactsFromWebsite) {
                contacts = await fetchWebsiteAndContacts(origin, contactPagePaths);
              }
              website = origin;
            } catch {
              // keep website as-is if URL parsing fails
            }
          }

          const item = {
            scrapedAt: new Date().toISOString(),
            name,
            categories,
            rating: rating ?? null,
            reviewCount: reviewCount ?? null,
            priceLevel,
            phone,
            address,
            yelpUrl: request.url,
            website,
            emails: contacts.emails,
            phonesFromWebsite: contacts.phones,
            socialLinks: contacts.socialLinks,
          };

          await Dataset.pushData(item);
          log.info(`Saved: ${name ?? '(no-name)'} | ${request.url}`);
        } catch (err) {
          log.warning(`ERROR processing DETAIL ${request.url}: ${err.message}`);
        }
      }
    },
    failedRequestHandler: async ({ request, error, page }) => {
      log.warning(`Request failed: ${request.url} - ${error?.message ?? 'no error obj'}`);
      if (debugScreenshots && page) {
        try {
          const path = `storage/${Date.now()}_fail.png`;
          await page.screenshot({ path, fullPage: true }).catch(() => {});
          log.info(`Saved failure screenshot to ${path}`);
        } catch {}
      }
    },
  });

  // Seed the crawler
  await crawler.addRequests([{ url: startUrl, userData: { label: 'SEARCH' } }]);

  // Run
  await crawler.run();
  log.info('Crawl finished. Check Dataset tab for results.');

} finally {
  await Actor.exit();
}
