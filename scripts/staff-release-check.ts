/**
 * ST-I10: the release gate for the Ray'z Staff app. Fails until the employee privacy notice's
 * current version is signed off in STAFF_PRIVACY_REVIEW (src/domain/staff-privacy.ts), and while the
 * repo uses anything biometric. Run before each store submission:
 *   pnpm staff:release-check
 */
import { execFileSync } from "node:child_process";
import { PRIVACY_REVIEW_CHECK_LABEL, PRIVACY_REVIEW_CHECKS, STAFF_PRIVACY_REVIEW, privacyReleaseProblems } from "../src/domain/staff-privacy";

const problems = privacyReleaseProblems();
try {
  execFileSync(process.execPath, ["scripts/check-no-biometrics.mjs"], { stdio: "pipe" });
} catch (e) {
  problems.push(`The no-biometrics check failed:\n${String((e as { stdout?: Buffer }).stdout ?? e)}`);
}

if (problems.length) {
  console.error("The staff app isn't ready to release:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nTo sign off, the reviewer fills in STAFF_PRIVACY_REVIEW (version ${STAFF_PRIVACY_REVIEW.version}) with their name, the date, and each of:`);
  for (const c of PRIVACY_REVIEW_CHECKS) console.error(`  ${c}: ${PRIVACY_REVIEW_CHECK_LABEL[c]}`);
  process.exit(1);
}
console.log(`Staff app release check passed: privacy notice ${STAFF_PRIVACY_REVIEW.version} reviewed by ${STAFF_PRIVACY_REVIEW.reviewer} on ${STAFF_PRIVACY_REVIEW.reviewedOn}.`);
