import { afterEach, describe, expect, it } from "vitest";
import { androidAssetLinks, appleAppSiteAssociation, parseVersion, versionLessThan } from "@/server/app-config";

const KEYS = ["APPLE_TEAM_ID", "IOS_BUNDLE_ID", "ANDROID_PACKAGE", "ANDROID_CERT_SHA256"];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

describe("app versions", () => {
  it("compares dotted versions numerically and ignores build suffixes", () => {
    expect(parseVersion("1.10.2-beta+44")).toEqual([1, 10, 2]);
    expect(parseVersion("2")).toEqual([2, 0, 0]);
    expect(parseVersion("banana")).toBeNull();
    expect(versionLessThan("1.9.9", "1.10.0")).toBe(true);
    expect(versionLessThan("1.10.0", "1.10")).toBe(false);
    expect(versionLessThan("garbage", "9.0.0")).toBe(false);
  });
});

describe("app link files", () => {
  it("stay unpublished until the app's identifiers are set", () => {
    expect(appleAppSiteAssociation()).toBeNull();
    expect(androidAssetLinks()).toBeNull();
  });

  it("claim the client pages for the app, never staff or checkout pages", () => {
    process.env.APPLE_TEAM_ID = "ABCDE12345";
    process.env.IOS_BUNDLE_ID = "com.rayz.customer";
    process.env.ANDROID_PACKAGE = "com.rayz.customer";
    process.env.ANDROID_CERT_SHA256 = "aa:bb:cc, DD:EE:FF";
    const aasa = appleAppSiteAssociation()!;
    expect(aasa.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.rayz.customer"]);
    const paths = aasa.applinks.details[0].components.map((c) => c["/"]);
    expect(paths).toContain("/a/*");
    expect(paths).toContain("/book/*");
    expect(paths.some((p) => p.startsWith("/admin") || p.startsWith("/handoff") || p.startsWith("/embed"))).toBe(false);
    expect(androidAssetLinks()![0].target).toEqual({ namespace: "android_app", package_name: "com.rayz.customer", sha256_cert_fingerprints: ["AA:BB:CC", "DD:EE:FF"] });
  });
});
