-- ============================================================
-- 035_contact_source_url.sql — Click-to-WhatsApp referral source
--
-- When a customer messages via a click-to-WhatsApp ad or a website
-- "Chat on WhatsApp" button, Meta's inbound webhook carries a `referral`
-- object with the originating URL (referral.source_url) and its type
-- (ad / post). We persist that on the contact so agents can see where a
-- lead came from — surfaced in the inbox conversation list.
--
-- First-touch: the webhook only writes these when they're still empty,
-- so the original source is preserved across later messages.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT;
