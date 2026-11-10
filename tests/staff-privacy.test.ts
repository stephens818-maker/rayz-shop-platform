/**
 * ST-I10: the employee privacy notice's data map, retention and pay question path, and the review
 * that gates the staff app's release.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STAFF_LEGAL_VERSIONS } from "@/domain/legal";
import {
  PAY_AGENCIES,
  PAY_QUESTION_MANAGER_DAYS,
  PAY_QUESTION_STEPS,
  PRIVACY_REVIEW_CHECKS,
  PUNCH_PHOTO_DAYS,
  SIGNED_OUT_DEVICE_DAYS,
  STAFF_DATA_MAP,
  STAFF_PRIVACY_REVIEW,
  privacyReleaseProblems,
  privacyReviewed,
} from "@/domain/staff-privacy";

vi.mock("server-only", () => ({}));

const signedOff = { version: STAFF_LEGAL_VERSIONS.privacy, reviewer: "Counsel", reviewedOn: "2026-11-02", approved: Object.fromEntries(PRIVACY_REVIEW_CHECKS.map((c) => [c, true])) };

describe("the employee privacy notice (ST-I10)", () => {
  it("maps every kind of employee data with why, who sees it, who holds it and how long it's kept", () => {
    expect(new Set(STAFF_DATA_MAP.map((d) => d.key)).size).toBe(STAFF_DATA_MAP.length);
    for (const d of STAFF_DATA_MAP) for (const f of ["category", "what", "why", "source", "access", "processors", "retention"] as const) expect(d[f].trim(), `${d.key}.${f}`).not.toBe("");
    expect(STAFF_DATA_MAP.map((d) => d.key)).toEqual(expect.arrayContaining(["profile", "security", "time", "location", "photos", "pay", "notifications", "client_access", "pay_questions"]));
    const byKey = Object.fromEntries(STAFF_DATA_MAP.map((d) => [d.key, d.retention]));
    expect(byKey.photos).toContain(`${PUNCH_PHOTO_DAYS} days`);
    expect(byKey.notifications).toContain(`${SIGNED_OUT_DEVICE_DAYS} days`);
  });

  it("gives a pay question path to the owners and outside agencies, with no retaliation", () => {
    expect(PAY_QUESTION_STEPS.map((s) => s.title)).toEqual(["Ask in the app", "Escalate to the owners", "Getting it fixed", "Outside help, any time"]);
    expect(PAY_QUESTION_STEPS[0].body).toContain(`${PAY_QUESTION_MANAGER_DAYS} days`);
    expect(PAY_AGENCIES.map((a) => a.state)).toEqual(["IL", "IA", "US"]);
    for (const a of PAY_AGENCIES) expect(a.url).toMatch(/^https:\/\//);
  });

  it("holds the release until a named reviewer signs off every part of the current version", () => {
    expect(STAFF_PRIVACY_REVIEW.version).toBe(STAFF_LEGAL_VERSIONS.privacy);
    expect(privacyReviewed()).toBe(false);
    expect(privacyReleaseProblems()).toEqual(expect.arrayContaining(["Nobody is named as the reviewer.", "The review date is missing."]));
    expect(privacyReleaseProblems(signedOff)).toEqual([]);
    expect(privacyReleaseProblems({ ...signedOff, approved: { ...signedOff.approved, agencies: false } })).toEqual([expect.stringMatching(/^Not signed off: The outside agency/)]);
    expect(privacyReleaseProblems(signedOff, "2027-01-15")[0]).toMatch(/covers the .* notice, but the notice is now 2027-01-15/);
  });

  it("the page shows the draft banner, every part of the data map and the pay question path", async () => {
    const { default: Page } = await import("@/app/staff-app/privacy/page");
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("Draft for review");
    for (const d of STAFF_DATA_MAP) expect(html).toContain(d.category.replace(/'/g, "&#x27;"));
    for (const a of PAY_AGENCIES) expect(html).toContain(a.url);
    expect(html).toContain("If you think your pay is wrong");
    expect(html).not.toMatch(/push tokens are removed when you sign out/i);
  });
});
