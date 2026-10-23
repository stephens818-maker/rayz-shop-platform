-- Per-shop kill switch for paying a card tip to the barber's Express account.
-- Default on: that is the launch behavior. Set false to keep that shop's tips in the shop account.
-- Core owns this setting. Mobile reads it and does not keep a separate env flag.
ALTER TABLE "shops" ADD COLUMN "tip_to_barber" boolean DEFAULT true NOT NULL;
