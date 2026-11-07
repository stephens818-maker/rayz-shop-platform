-- State paid leave (ST-I16): the Illinois paid leave report is a payroll report, for the brand admin and the Bookkeeper.
UPDATE "roles" SET "permissions" = "permissions" || '["report.payroll_paid_leave.view","report.payroll_paid_leave.export"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper') AND NOT ("permissions" ? 'report.payroll_paid_leave.view');
