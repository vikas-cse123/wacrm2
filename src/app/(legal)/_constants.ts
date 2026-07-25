// Brand identity is sourced from the site-wide single source of truth
// (`@/lib/site`) so the homepage, legal pages, robots and sitemap stay
// in lockstep. Re-exported here so existing imports from this module
// keep working unchanged.
export {
  PRODUCT_NAME,
  COMPANY_NAME,
  WEBSITE_DOMAIN,
  SUPPORT_EMAIL,
} from "@/lib/site";

// Human-readable effective date shown at the top of each document.
// Update this whenever the policies materially change.
export const EFFECTIVE_DATE = "July 25, 2026";
