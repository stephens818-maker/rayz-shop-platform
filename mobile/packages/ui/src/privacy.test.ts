import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobile = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function manifest(app: "customer" | "staff") {
  const file = readFileSync(join(mobile, "apps", app, "ios", "PrivacyInfo.xcprivacy"), "utf8");
  const config = JSON.parse(readFileSync(join(mobile, "apps", app, "app.json"), "utf8")) as {
    expo: { ios: { privacyManifests: { NSPrivacyTracking: boolean; NSPrivacyCollectedDataTypes: { NSPrivacyCollectedDataType: string }[]; NSPrivacyAccessedAPITypes: { NSPrivacyAccessedAPITypeReasons: string[] }[] } } };
  };
  return { file, config: config.expo.ios.privacyManifests };
}

describe("privacy manifests", () => {
  it("declares the required-reason APIs and does not track or collect location or photos", () => {
    for (const app of ["customer", "staff"] as const) {
      const { file, config } = manifest(app);
      expect(file).toContain("<key>NSPrivacyTracking</key>\n\t<false/>");
      expect(config.NSPrivacyTracking).toBe(false);
      for (const reason of ["CA92.1", "C617.1", "E174.1", "35F9.1"]) {
        expect(file).toContain(reason);
        expect(config.NSPrivacyAccessedAPITypes.some((row) => row.NSPrivacyAccessedAPITypeReasons.includes(reason))).toBe(true);
      }
      const blob = `${file} ${JSON.stringify(config)}`;
      expect(blob).not.toContain("PreciseLocation");
      expect(blob).not.toContain("NSPrivacyCollectedDataTypePhotos");
      expect(blob).not.toContain("NSPrivacyCollectedDataTypeCoarseLocation");
    }
  });

  it("lists customer contact and payment data, and staff financial data", () => {
    const customer = manifest("customer");
    for (const type of ["PhoneNumber", "Name", "EmailAddress", "PaymentInfo", "UserID", "PurchaseHistory"]) {
      expect(customer.file).toContain(`NSPrivacyCollectedDataType${type}`);
      expect(customer.config.NSPrivacyCollectedDataTypes.some((row) => row.NSPrivacyCollectedDataType.endsWith(type))).toBe(true);
    }
    const staff = manifest("staff");
    for (const type of ["PhoneNumber", "Name", "UserID", "OtherFinancialInfo"]) {
      expect(staff.file).toContain(`NSPrivacyCollectedDataType${type}`);
      expect(staff.config.NSPrivacyCollectedDataTypes.some((row) => row.NSPrivacyCollectedDataType.endsWith(type))).toBe(true);
    }
    expect(staff.file).not.toContain("PaymentInfo");
    expect(staff.file).not.toContain("PurchaseHistory");
  });
});