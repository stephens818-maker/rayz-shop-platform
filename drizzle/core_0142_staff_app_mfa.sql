-- My Earnings needs staff MFA (2026-10-28): on a staff app session's first row, when this session last passed a second factor (an authenticator code at sign-in, at step-up, or setting one up in the app). A password alone never sets it. Additive only.
ALTER TABLE "staff_app_tokens" ADD COLUMN IF NOT EXISTS "mfa_at" timestamp with time zone;
