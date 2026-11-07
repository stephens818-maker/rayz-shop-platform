-- Marketing is now the Campaign Center. Its permissions are view, create, send and export, and its
-- report is campaign_center. Roles and per-person overrides keep what they could do: "location" and
-- "manage" each become create plus send (create with access to all shops is the brand-level part).
-- An override that sets both old keys differently ends up off, the narrower of the two.
UPDATE "roles" r SET "permissions" = (
  SELECT coalesce(jsonb_agg(d.n ORDER BY d.o, d.n), '[]'::jsonb)
  FROM (
    SELECT coalesce(m.n, e.p) n, min(e.o) o
    FROM jsonb_array_elements_text(r."permissions") WITH ORDINALITY e(p, o)
    LEFT JOIN (VALUES
      ('marketing.view', 'campaign_center.view'),
      ('marketing.location', 'campaign_center.create'),
      ('marketing.location', 'campaign_center.send'),
      ('marketing.manage', 'campaign_center.create'),
      ('marketing.manage', 'campaign_center.send'),
      ('marketing.export', 'campaign_center.export'),
      ('report.marketing.view', 'report.campaign_center.view'),
      ('report.marketing.export', 'report.campaign_center.export')
    ) m(k, n) ON m.k = e.p
    GROUP BY coalesce(m.n, e.p)
  ) d
)
WHERE jsonb_typeof(r."permissions") = 'array'
  AND r."permissions" ?| ARRAY['marketing.view', 'marketing.location', 'marketing.manage', 'marketing.export', 'report.marketing.view', 'report.marketing.export'];--> statement-breakpoint
UPDATE "staff" s SET "permission_overrides" = (
  SELECT coalesce(jsonb_object_agg(d.n, d.v), '{}'::jsonb)
  FROM (
    SELECT coalesce(m.n, e.key) n, bool_and(e.value = 'true'::jsonb) v
    FROM jsonb_each(s."permission_overrides") e
    LEFT JOIN (VALUES
      ('marketing.view', 'campaign_center.view'),
      ('marketing.location', 'campaign_center.create'),
      ('marketing.location', 'campaign_center.send'),
      ('marketing.manage', 'campaign_center.create'),
      ('marketing.manage', 'campaign_center.send'),
      ('marketing.export', 'campaign_center.export'),
      ('report.marketing.view', 'report.campaign_center.view'),
      ('report.marketing.export', 'report.campaign_center.export')
    ) m(k, n) ON m.k = e.key
    GROUP BY coalesce(m.n, e.key)
  ) d
)
WHERE jsonb_typeof(s."permission_overrides") = 'object'
  AND s."permission_overrides" ?| ARRAY['marketing.view', 'marketing.location', 'marketing.manage', 'marketing.export', 'report.marketing.view', 'report.marketing.export'];
