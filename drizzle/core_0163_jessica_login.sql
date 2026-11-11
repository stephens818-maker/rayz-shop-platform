-- Demo sign-in for the Coralville barber named Jessica, only when she has no email and no password and that address is free.
-- Does not change anyone who already has an email or a password. Does not change punches or tip payout timing.
UPDATE "staff" AS s
SET "email" = 'jessica@rayz.test',
    "password_hash" = '$2b$10$G25GrQtrQ3j4j6/8POQDFeZ573ssDuA0VAygmfkODFcu.fS4kTOhy'
WHERE s."id" IN (
  SELECT st."id"
  FROM "staff" st
  JOIN "staff_shops" ss ON ss."staff_id" = st."id"
  JOIN "shops" sh ON sh."id" = ss."shop_id" AND sh."slug" = 'coralville'
  WHERE st."display_label" = 'Jessica'
    AND st."first_name" = 'Jessica'
    AND st."active"
    AND st."kind" = 'person'
    AND st."email" IS NULL
    AND st."password_hash" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "staff" other WHERE other."email" = 'jessica@rayz.test')
)
AND (
  SELECT count(*) FROM (
    SELECT st."id"
    FROM "staff" st
    JOIN "staff_shops" ss ON ss."staff_id" = st."id"
    JOIN "shops" sh ON sh."id" = ss."shop_id" AND sh."slug" = 'coralville'
    WHERE st."display_label" = 'Jessica'
      AND st."first_name" = 'Jessica'
      AND st."active"
      AND st."kind" = 'person'
      AND st."email" IS NULL
      AND st."password_hash" IS NULL
  ) matches
) = 1;
