-- ============================================================
-- 036_contact_ctwa_clid.sql — Click-to-WhatsApp click identifier
--
-- Meta's inbound `referral` object carries a `ctwa_clid` — the unique
-- click id for the ad/link that brought the lead in. We already persist
-- `source_url` / `source_type` (migration 035); this adds the click id
-- alongside them so it can be surfaced in the inbox contact panel and
-- used for ad attribution / Meta conversions API matching.
--
-- First-touch: the webhook only writes this when it's still empty, so
-- the original click id is preserved across later messages (same policy
-- as source_url).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
