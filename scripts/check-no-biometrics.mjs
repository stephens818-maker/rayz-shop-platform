#!/usr/bin/env node
/**
 * ST-I17: fails CI when a repo pulls in face, fingerprint, voice or ID-verification biometrics
 * (Illinois BIPA). Dependency-free so the web repo and both app repos can run the same file:
 *
 *   node scripts/check-no-biometrics.mjs [path ...]   (default: the current directory)
 *
 * Scans package manifests and lockfiles, Expo config, Podfiles, Gradle files and source. The phone's
 * own unlock (Face ID, Touch ID, Android BiometricPrompt through expo-local-authentication,
 * react-native-biometrics or react-native-keychain) is allowed: the app only ever gets yes or no,
 * and no template leaves the phone's secure hardware.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".expo", ".turbo", "dist", "build", "out", "coverage", "Pods", "DerivedData", ".gradle"]);
const SELF = /^(check-no-biometrics\.mjs|no-biometrics\.test\.[cm]?[jt]sx?)$/;
const SOURCE = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".swift", ".m", ".mm", ".h", ".kt", ".kts", ".java", ".gradle", ".py", ".json", ".yaml", ".yml", ".toml", ".plist", ".xml"]);
const MANIFESTS = /^(Podfile|Podfile\.lock|Gemfile|Gemfile\.lock|Cartfile|Package\.resolved|requirements.*\.txt|yarn\.lock|gradle\.properties)$/;
const MAX_BYTES = 8 * 1024 * 1024;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A package name on its own, not inside a longer name (react-native-camera, not react-native-camera-kit). */
const pkg = (name, why) => ({ re: new RegExp(`(?<![\\w@.-])${esc(name)}(?![\\w.-])`, "i"), why });
/** Any package starting with this prefix. */
const prefix = (start, why) => ({ re: new RegExp(`(?<![\\w@.-])${esc(start)}[\\w.-]*`, "i"), why });
const code = (re, why) => ({ re, why });

const FACE = "face detection or recognition";
const ID = "ID verification with a face match";
export const RULES = [
  pkg("face-api.js", FACE),
  pkg("@vladmandic/face-api", FACE),
  pkg("@vladmandic/human", FACE),
  prefix("@tensorflow-models/face-", FACE),
  pkg("@tensorflow-models/blazeface", FACE),
  pkg("@mediapipe/face_mesh", FACE),
  pkg("@mediapipe/face_detection", FACE),
  pkg("expo-face-detector", FACE),
  prefix("react-native-vision-camera-face-detector", FACE),
  pkg("@react-native-ml-kit/face-detection", FACE),
  pkg("@infinitered/react-native-mlkit-face-detection", FACE),
  pkg("react-native-camera", "react-native-camera (ships face detection)"),
  pkg("@react-native-firebase/ml-vision", FACE),
  pkg("face_recognition", FACE),
  pkg("deepface", FACE),
  pkg("@aws-sdk/client-rekognition", "AWS Rekognition (face matching)"),
  pkg("@azure/cognitiveservices-face", "Azure Face"),
  pkg("@azure-rest/ai-vision-face", "Azure Face"),
  pkg("faceio", FACE),
  prefix("@facetec/", ID),
  code(/(?<![\w])FaceTec/i, ID),
  code(/(?<![\w])iProov/i, ID),
  code(/(?<![\w])onfido/i, ID),
  code(/(?<![\w])veriff/i, ID),
  code(/(?<![\w])jumio/i, ID),
  pkg("@stripe/stripe-identity-react-native", "Stripe Identity (selfie match)"),
  code(/(?<![\w])StripeIdentity(?![\w])/, "Stripe Identity (selfie match)"),
  prefix("com.stripe:identity", "Stripe Identity (selfie match)"),
  code(/(?<![\w])regula[\w.-]*face/i, ID),
  code(/(?<![\w])paravision/i, FACE),
  code(/(?<![\w])digitalpersona/i, "fingerprint reader SDK"),
  code(/(?<![\w])secugen/i, "fingerprint reader SDK"),
  code(/(?<![\w])@picovoice\/eagle/i, "voiceprint"),
  code(/GoogleMLKit\/FaceDetection|MLKitFaceDetection/, FACE),
  code(/com\.google\.mlkit:face-detection|play-services-mlkit-face-detection|firebase-ml-vision/, FACE),
  code(/com\.google\.mlkit\.vision\.face|com\.google\.android\.gms\.vision\.face|android\.media\.FaceDetector/, FACE),
  code(/(?<![\w])VNDetectFace\w*|VNFaceObservation|CIDetectorTypeFace/, "Apple Vision face detection"),
  code(/ARFaceTrackingConfiguration|ARFaceAnchor/, "ARKit face tracking"),
  code(/(?<![\w])(IndexFaces|SearchFacesByImage|SearchFaces|CompareFaces|DetectFaces|CreateFaceLiveness\w*)Command(?![\w])/, "AWS Rekognition (face matching)"),
];

function* files(root) {
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield root;
    return;
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* files(join(root, e.name));
    } else if (e.isFile()) yield join(root, e.name);
  }
}

const wanted = (f) => {
  const name = basename(f);
  if (SELF.test(name)) return false;
  return SOURCE.has(extname(name).toLowerCase()) || MANIFESTS.test(name);
};

/** Every banned SDK or API found under the given paths, with where it is. */
export function scan(paths) {
  const found = [];
  for (const root of paths) {
    for (const f of files(root)) {
      if (!wanted(f) || statSync(f).size > MAX_BYTES) continue;
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const r of RULES) {
          const m = line.match(r.re);
          if (m) found.push({ file: relative(process.cwd(), f) || f, line: i + 1, match: m[0], why: r.why });
        }
      });
    }
  }
  return found;
}

if (process.argv[1] && basename(process.argv[1]) === "check-no-biometrics.mjs") {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const found = scan(paths.length ? paths : ["."]);
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(found) + "\n");
  else if (!found.length) console.log("No biometrics: no face, fingerprint, voice or ID-verification SDKs found.");
  else {
    console.error(`Biometric SDKs or APIs found (not allowed, Illinois BIPA; see src/domain/biometrics.ts):`);
    for (const f of found) console.error(`  ${f.file}:${f.line}  ${f.match}  (${f.why})`);
  }
  process.exit(found.length ? 1 : 0);
}
