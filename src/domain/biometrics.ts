/**
 * ST-I17: Ray'z never collects biometric identifiers (Illinois BIPA, 740 ILCS 14). CI enforces it with
 * scripts/check-no-biometrics.mjs in this repo and both app repos.
 */
export const NO_BIOMETRICS_POLICY = {
  title: "No biometrics",
  summary: "Ray'z never collects fingerprints, face scans, hand geometry, voiceprints or any other biometric identifier, from staff or clients.",
  points: [
    "The time clock takes a PIN at the front desk, or a phone proves it's at the shop by the front-desk QR code, the shop's NFC tag, its Wi-Fi or location. There's no fingerprint, face or hand reader.",
    "A punch photo, where a shop asks for one, is kept only so a manager can look at it. It's never scanned, matched or turned into a face template.",
    "Face ID, Touch ID or a fingerprint can unlock the Ray'z Staff app on your own phone. That check happens inside your phone: the app only hears yes or no, and nothing about your face or finger reaches Ray'z.",
    "Employee fields can't be set up to hold biometric data.",
  ],
} as const;

/** Same words as the staff_custom_fields_not_biometric check in core_0120_no_biometrics.sql; keep the two in step. */
export const BIOMETRIC_LABEL =
  /(^|[^a-z])(biometrics?|finger ?prints?|thumb ?prints?|face ?(scan|print|template|geometry|id|match)s?|facial (recognition|scan|geometry|template)s?|retina(l)?( scan)?s?|iris (scan|print)s?|voice ?prints?|hand ?(geometry|scan)s?|palm ?(print|vein)s?)([^a-z]|$)/i;
