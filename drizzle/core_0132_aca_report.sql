-- ACA hours (N6): a payroll report, for the brand admin and the Bookkeeper.
UPDATE "roles" SET "permissions" = "permissions" || '["report.payroll_aca.view","report.payroll_aca.export"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper') AND NOT ("permissions" ? 'report.payroll_aca.view');
