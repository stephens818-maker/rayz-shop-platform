import { describe, expect, it } from "vitest";
import { REFINE_MAX, normalizeRefined, refinePrompt, stubAltText, stubRefine } from "@/domain/campaign-refine";
import { BRAND_COLOR, marketingEmailHtml } from "@/domain/marketing-email";
import { SAMPLE_VALUES, STOP_LINE, TemplatesSchema, render, smsAppends, smsSegments, smsText, templatesProblem, type Templates } from "@/domain/marketing";

const base: Templates = { sms: "", emailSubject: "s", emailBody: "b", pushTitle: "", pushBody: "" };
const footer = { brand: "Ray'z Barber Shop", address: "1 Main St", unsubscribeUrl: "https://x/m/T/unsubscribe" };
const IMG = "/mi/6f1c2b9e-1d2a-4c3b-9f00-123456789abc";

describe("texts: link and opt-out added, counted in segments", () => {
  it("adds the booking link and the opt-out line unless the wording already has them", () => {
    const v = { first_name: "Sam", book_link: "https://r.x/m/T" };
    expect(smsText("Hi {first_name}.", v)).toBe(`Hi Sam. https://r.x/m/T ${STOP_LINE}`);
    expect(smsText("Hi {first_name}, book: {book_link} now. Reply STOP to end.", v)).toBe("Hi Sam, book: https://r.x/m/T now. Reply STOP to end.");
    expect(smsText("Hi.", { first_name: "Sam" })).toBe(`Hi. ${STOP_LINE}`);
    expect(smsAppends("Hi")).toEqual({ link: true, stop: true });
    expect(smsAppends("Hi {book_link|} STOP")).toEqual({ link: false, stop: false });
  });

  it("counts GSM-7 and unicode segments", () => {
    expect(smsSegments("")).toMatchObject({ chars: 0, segments: 0 });
    expect(smsSegments("a".repeat(160))).toEqual({ chars: 160, segments: 1, unicode: false, perSegment: 160 });
    expect(smsSegments("a".repeat(161))).toEqual({ chars: 161, segments: 2, unicode: false, perSegment: 153 });
    expect(smsSegments("€".repeat(80)).chars).toBe(160);
    expect(smsSegments("Hi 💈")).toMatchObject({ unicode: true, perSegment: 70, segments: 1 });
    expect(smsSegments("’".repeat(71))).toMatchObject({ unicode: true, segments: 2, perSegment: 67 });
  });
});

describe("email design: headline, image, booking button", () => {
  it("renders the parts, with the uploaded image made absolute and the button on the booking link", () => {
    const t: Templates = { ...base, emailHeadline: "Fresh cuts, {first_name}", emailCta: "Book now", emailImage: IMG, emailImageAlt: "A barber at work", emailBody: "Hi {first_name|friend}," };
    const r = render(t, SAMPLE_VALUES, footer, { base: "https://rayz.example" });
    expect(r.email.headline).toBe("Fresh cuts, Jordan");
    expect(r.email.image).toEqual({ src: `https://rayz.example${IMG}`, alt: "A barber at work" });
    expect(r.email.cta).toEqual({ label: "Book now", url: SAMPLE_VALUES.book_link });
    expect(r.email.text).toMatch(/^Fresh cuts, Jordan\n\nHi Jordan,\n\nBook now: https:\/\/rayz\.example\/m\/Xy12abCD\n\n--\n/);
    expect(render({ ...t, emailCta: "", emailImage: "" }, SAMPLE_VALUES, footer).email).toMatchObject({ cta: null, image: null });
  });

  it("the HTML has the image, the headline and a button in the brand's color with readable text", () => {
    const html = marketingEmailHtml({ subject: "s", body: "Hi\n\n--\nfoot", headline: "Big <news>", image: { src: "https://x/i.jpg", alt: 'A "cut"' }, cta: { label: "Book", url: "https://x/m/T" } });
    expect(html).toContain('<img src="https://x/i.jpg" alt="A &quot;cut&quot;"');
    expect(html).toContain("Big &lt;news&gt;</h1>");
    expect(html).toContain(`class="cta" href="https://x/m/T" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff`);
    expect(marketingEmailHtml({ subject: "s", body: "b", cta: { label: "Book", url: "u" }, color: "#fde047" })).toContain("background:#fde047;color:#18181b");
    expect(marketingEmailHtml({ subject: "s", body: "b", cta: { label: "Book", url: "u" }, color: "red;x" })).toContain(`background:${BRAND_COLOR}`);
    expect(marketingEmailHtml({ subject: "s", body: "b" })).not.toMatch(/class="cta"|<h1/);
  });

  it("an image needs an uploaded or https address and a description", () => {
    expect(templatesProblem({ ...base, emailImage: IMG }, ["email"], { hasCoupon: false })).toMatch(/alt text/);
    expect(templatesProblem({ ...base, emailImage: IMG, emailImageAlt: "x" }, ["email"], { hasCoupon: false })).toBeNull();
    expect(templatesProblem({ ...base, emailImage: "http://x/i.jpg", emailImageAlt: "x" }, ["email"], { hasCoupon: false })).toMatch(/https/);
    expect(TemplatesSchema.safeParse({ ...base, emailImage: "javascript:alert(1)" }).success).toBe(false);
    expect(templatesProblem({ ...base, emailHeadline: "Hi {nick}" }, ["email"], { hasCoupon: false })).toMatch(/Email headline: \{nick\}/);
  });
});

describe("refine text", () => {
  it("the prompt keeps merge fields and tells the model what's automatic", () => {
    const p = refinePrompt({ brand: "Ray'z", part: "sms", style: "shorter", extraFields: ["day"] });
    expect(p).toMatch(/\{first_name\}.*\{day\}/);
    expect(p).toMatch(/booking link and the opt-out line are added automatically/);
    expect(refinePrompt({ brand: "R", part: "emailBody", style: "custom", instruction: "Mention Saturdays" })).toContain("Mention Saturdays");
  });

  it("without a model, shorter drops filler and clearer tidies", () => {
    expect(stubRefine("we just really  miss you (seriously) .see you", "shorter")).toBe("We miss you. See you");
    expect(stubRefine("hi {first_name}.book now", "clearer")).toBe("Hi {first_name}. Book now");
  });

  it("a rewrite keeps the fields it dropped, loses invented ones, and fits the part", () => {
    const known = ["first_name", "coupon_code", "shop"];
    expect(normalizeRefined("Use {coupon_code}, {first_name}", '"Hey, grab your deal {ssn}"', "sms", known)).toBe("Hey, grab your deal {coupon_code}");
    expect(normalizeRefined("x", "y".repeat(100), "pushTitle", known)).toHaveLength(REFINE_MAX.pushTitle);
  });

  it("alt text comes from the email's wording", () => {
    expect(stubAltText({ emailSubject: "s", emailHeadline: "Fall cuts for {first_name}", emailBody: "" })).toBe("Ray'z Barber Shop: Fall cuts for");
    expect(stubAltText({ emailSubject: "", emailHeadline: "", emailBody: "Hi {first_name},\n\nNew hours this week" })).toBe("Ray'z Barber Shop: New hours this week");
  });
});
