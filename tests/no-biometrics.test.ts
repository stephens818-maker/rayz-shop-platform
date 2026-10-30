import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** ST-I17: the CI check that keeps face, fingerprint, voice and ID-verification SDKs out of the web and both apps. */
const SCRIPT = join(__dirname, "..", "scripts", "check-no-biometrics.mjs");
const dirs: string[] = [];

function run(...paths: string[]): { code: number; found: { file: string; line: number; match: string; why: string }[] } {
  try {
    return { code: 0, found: JSON.parse(execFileSync("node", [SCRIPT, "--json", ...paths], { encoding: "utf8" })) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, found: JSON.parse(err.stdout) };
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "no-bio-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("no biometrics CI check (ST-I17)", () => {
  it("passes this repo", () => {
    expect(run(join(__dirname, "..")).found).toEqual([]);
  });

  it("fails an app that pulls in face, fingerprint, voice or ID-verification SDKs, wherever they show up", () => {
    const dir = fixture({
      "package.json": JSON.stringify({ dependencies: { "expo-face-detector": "^12.0.0", "@aws-sdk/client-rekognition": "^3.0.0", "@picovoice/eagle-react-native": "^1.0.0" } }),
      "app.json": JSON.stringify({ expo: { plugins: ["@react-native-ml-kit/face-detection"] } }),
      "ios/Podfile": "pod 'GoogleMLKit/FaceDetection'\npod 'iProov'\n",
      "android/app/build.gradle": "implementation 'com.google.mlkit:face-detection:16.1.5'\nimplementation 'com.stripe:identity-android:20.0.0'\n",
      "ios/Clock/Punch.swift": "let req = VNDetectFaceRectanglesRequest()\n",
      "android/app/src/main/java/Punch.kt": "import com.google.mlkit.vision.face.FaceDetection\n",
      "src/punch.ts": 'import * as faceapi from "face-api.js";\nimport { CompareFacesCommand } from "x";\n',
      "node_modules/face-api.js/package.json": '{"name":"face-api.js"}',
    });
    const r = run(dir);
    expect(r.code).toBe(1);
    const at = r.found.map((f) => `${f.file.split(/[\\/]/).slice(-1)[0]}:${f.line}`);
    for (const want of ["package.json:1", "app.json:1", "Podfile:1", "Podfile:2", "build.gradle:1", "build.gradle:2", "Punch.swift:1", "Punch.kt:1", "punch.ts:1", "punch.ts:2"]) expect(at, want).toContain(want);
    expect(r.found.some((f) => f.file.includes("node_modules"))).toBe(false);
    expect(r.found.map((f) => f.why).join(" ")).toMatch(/voiceprint/);
  });

  it("allows the phone's own unlock (Face ID or a fingerprint through the OS, which only answers yes or no) and lookalike names", () => {
    const dir = fixture({
      "package.json": JSON.stringify({ dependencies: { "expo-local-authentication": "^14.0.0", "react-native-biometrics": "^3.0.1", "react-native-keychain": "^8.0.0", "react-native-camera-kit": "^14.0.0", "expo-camera": "^15.0.0" } }),
      "src/lock.ts": 'import * as LocalAuthentication from "expo-local-authentication";\nexport const unlock = () => LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Ray\'z Staff" });\n// A facial is a service; the shop sells face wash.\n',
      "ios/Podfile": "pod 'RNKeychain'\n",
    });
    expect(run(dir)).toEqual({ code: 0, found: [] });
  });
});
