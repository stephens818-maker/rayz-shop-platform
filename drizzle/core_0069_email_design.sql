-- Campaign Center email design, matching Squire Engage's editor: a header image (uploaded and refined in the editor, or replaced), a headline and a booking button in the brand's color sit around the email's text. The wording itself lives in each campaign's templates jsonb (new optional keys: emailHeadline, emailCta, emailImage, emailImageAlt). Uploaded images are kept here and served at /mi/<id>; a refined or replaced image is a new row, so a sent email keeps its picture. Additive only.
CREATE TABLE IF NOT EXISTS "marketing_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_url" text NOT NULL,
	"alt" text,
	"width" integer,
	"height" integer,
	"source_id" uuid REFERENCES "marketing_images"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_images_data_chk" CHECK ("data_url" ~ '^data:image/(jpeg|png|webp);base64,' AND length("data_url") <= 2000000)
);
