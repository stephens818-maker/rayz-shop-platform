/**
 * ST-I19: creates or refreshes the staff app's Demo Shop and its app review login.
 *   STAFF_APP_REVIEW_EMAIL=review@… STAFF_APP_REVIEW_PASSWORD=… pnpm staff:demo-shop
 * The login signs in only while FEATURE_STAFF_REVIEW_LOGIN=true; run this again after switching it.
 */
import { ensureDemoShop } from "@/server/demo-shop";

async function main() {
  const email = process.env.STAFF_APP_REVIEW_EMAIL?.trim();
  const password = process.env.STAFF_APP_REVIEW_PASSWORD;
  if (!email || !password) throw new Error("Set STAFF_APP_REVIEW_EMAIL and STAFF_APP_REVIEW_PASSWORD");
  const r = await ensureDemoShop({ email, password }, { staffId: null, label: "script:demo-shop" });
  console.log(`Demo Shop ${r.shopId}; reviewer ${r.reviewerId} ${r.active ? "can sign in" : "can't sign in until FEATURE_STAFF_REVIEW_LOGIN=true"}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
