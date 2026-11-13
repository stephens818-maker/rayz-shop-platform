-- Managers who can already fix timesheets can clock someone in or out from the calendar.
UPDATE "roles" SET "permissions" = "permissions" || '["timeclock.edit_others"]'::jsonb WHERE "permissions" ? 'timesheet.edit' AND NOT ("permissions" ? 'timeclock.edit_others');
