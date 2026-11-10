-- Public booking can tell two Taylors or two Olivias apart without a last name, and a demo
-- visit left in the chair is cancelled. Archived clients stay archived. Safe to run again.
-- Does not touch punches or tip payout schedules.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS public_specialty text;
--> statement-breakpoint

UPDATE staff SET public_specialty = 'Skin fades' WHERE display_label = 'Taylor A.' AND public_specialty IS NULL;
--> statement-breakpoint
UPDATE staff SET public_specialty = 'Scissor cuts' WHERE display_label = 'Taylor B.' AND public_specialty IS NULL;
--> statement-breakpoint
UPDATE staff SET public_specialty = 'Kids cuts' WHERE display_label = 'Olivia A.' AND public_specialty IS NULL;
--> statement-breakpoint
UPDATE staff SET public_specialty = 'Beard trims' WHERE display_label = 'Olivia B.' AND public_specialty IS NULL;
--> statement-breakpoint

UPDATE appointments
SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), cancelled_by = coalesce(cancelled_by, 'staff'), cancel_reason = coalesce(cancel_reason, 'Demo cleanup')
WHERE code = 'A5TDPQTQ87'
  AND status IN ('booked', 'confirmed', 'checked_in', 'in_service');
