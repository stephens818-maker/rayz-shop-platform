-- Copy the apps show for a shop that is still on Squire.
-- CLOSED_SHOP_COPY in the environment overrides this. Null uses the built-in sentence.
ALTER TABLE "brand_settings" ADD COLUMN "closed_shop_copy" text;
