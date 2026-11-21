-- Flag leftover demo open tickets. Rows stay; the checkout queue hides a sample visit's ticket.
UPDATE "appointments" AS a
SET "sample" = true
FROM "sales" AS s
LEFT JOIN "customers" AS c ON c.id = s.customer_id
WHERE s.status = 'open'
  AND a.sample = false
  AND (c.last_name IS DISTINCT FROM 'Zzcanary')
  AND (
    s.appointment_id = a.id
    OR EXISTS (SELECT 1 FROM sale_appointments sa WHERE sa.sale_id = s.id AND sa.appointment_id = a.id)
    OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.appointment_id = a.id)
  )
  AND (
    c.email ILIKE '%@example.test'
    OR (c.email IS NULL AND c.phone LIKE '%555%')
    OR a.notes = 'Walk-in'
    OR a.code LIKE 'DEMO%'
  );--> statement-breakpoint
-- Dubuque's booking page had no barbers. Add two only while the shop has none. Does not replace staff already there.
INSERT INTO "staff" ("staff_code", "first_name", "display_label", "public_slug", "color", "role_id", "shop_scope", "is_bookable", "active")
SELECT v.code, v.first_name, v.label, v.slug, v.color, r.id, 'selected', true, true
FROM "roles" r
JOIN (
  VALUES
    ('S-DUB-ROWAN', 'Rowan', 'Rowan', 'rowan', '#14b8a6'),
    ('S-DUB-HARPER', 'Harper', 'Harper', 'harper', '#8b5cf6')
) AS v(code, first_name, label, slug, color) ON true
WHERE r.key = 'barber'
  AND EXISTS (SELECT 1 FROM "shops" WHERE slug = 'dubuque')
  AND NOT EXISTS (
    SELECT 1
    FROM "staff_shops" ss
    JOIN "staff" st ON st.id = ss.staff_id
    JOIN "shops" s ON s.id = ss.shop_id
    WHERE s.slug = 'dubuque' AND st.is_bookable AND st.active AND st.kind = 'person'
  )
  AND NOT EXISTS (SELECT 1 FROM "staff" WHERE public_slug = v.slug);--> statement-breakpoint
INSERT INTO "staff_shops" ("staff_id", "shop_id", "visible_online", "is_primary")
SELECT st.id, s.id, true, true
FROM "staff" st
JOIN "shops" s ON s.slug = 'dubuque'
WHERE st.public_slug IN ('rowan', 'harper')
  AND NOT EXISTS (SELECT 1 FROM "staff_shops" ss WHERE ss.staff_id = st.id AND ss.shop_id = s.id);--> statement-breakpoint
INSERT INTO "staff_schedules" ("staff_id", "shop_id", "weekday", "start_min", "end_min")
SELECT st.id, s.id, d.weekday, 9 * 60, 18 * 60
FROM "staff" st
JOIN "shops" s ON s.slug = 'dubuque'
JOIN (VALUES (1), (2), (3), (4), (5), (6)) AS d(weekday) ON true
WHERE st.public_slug IN ('rowan', 'harper')
  AND NOT EXISTS (
    SELECT 1 FROM "staff_schedules" sch WHERE sch.staff_id = st.id AND sch.shop_id = s.id AND sch.weekday = d.weekday
  );
