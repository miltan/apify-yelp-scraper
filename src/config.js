/**
 * config.js
 * Central configuration and small helpers for the actor.
 *
 * Edit values here if you want different default behavior.
 */

export const DEFAULTS = {
  NAVIGATION_TIMEOUT_SECS: 45,
  MAX_CONCURRENCY: 5,
  // How long to wait between website fetch attempts (ms)
  WEBSITE_REQUEST_DELAY: 500,
  // Regexes used in website contact extraction (can be tuned)
  EMAIL_REGEX: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  PHONE_REGEX: /(\+?\d[\d\s().-]{7,}\d)/g,
  SOCIAL_REGEX: /https?:\/\/(www\.)?(facebook|instagram|twitter|x\.com|linkedin|youtube|tiktok)\.com\/[^\s"'<>]+/gi,
};