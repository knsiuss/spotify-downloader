// Unit test: provider configs (YouTube, SoundCloud, Qobuz).
// Test client args, config loading, provider properties.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YouTubeProvider } from "../providers/youtube.js";
import { SoundCloudProvider } from "../providers/soundcloud.js";
import { QobuzProvider, loadQobuzConfig, generateFileUrlRequestSignature, md5hex } from "../providers/qobuz.js";

describe("YouTubeProvider", () => {
  it("priority = 100", () => {
    const p = new YouTubeProvider();
    assert.equal(p.priority, 100);
    assert.equal(p.name, "youtube");
  });

  it("includes cookies when provided", () => {
    const p = new YouTubeProvider({ cookiesFile: "/path/to/cookies.txt" });
    // Just verify it doesn't throw on construction
    assert.ok(p);
  });
});

describe("SoundCloudProvider", () => {
  it("priority = 110 (after YouTube)", () => {
    const p = new SoundCloudProvider();
    assert.equal(p.priority, 110);
    assert.equal(p.name, "soundcloud");
  });
});

describe("generateFileUrlRequestSignature", () => {
  it("md5/rsa tidak — hanya md5 hex standar", () => {
    assert.equal(md5hex("test_pass"), "4ac1b63dca561d274c6055ebf3ed97db");
  });

  it("sesuai algoritma QobuzApiSharp (data = trackgetFileUrlformat_id.. + track_id.. + ts + secret)", () => {
    // Vektor diverifikasi terhadap Python hashlib (md5 standar).
    const sig = generateFileUrlRequestSignature("27", "7398", "1234567890", "testsecret");
    assert.equal(sig, "71075d66d16fad07d450ced81423bbc1");
  });

  it("signature berubah kalau salah satu komponen berubah", () => {
    const a = generateFileUrlRequestSignature("27", "7398", "1234567890", "testsecret");
    assert.notEqual(generateFileUrlRequestSignature("7", "7398", "1234567890", "testsecret"), a);
    assert.notEqual(generateFileUrlRequestSignature("27", "7399", "1234567890", "testsecret"), a);
    assert.notEqual(generateFileUrlRequestSignature("27", "7398", "1234567890", "other"), a);
    assert.notEqual(generateFileUrlRequestSignature("27", "7398", "999", "testsecret"), a);
  });

  it("return hex 32 karakter lowercase", () => {
    const sig = generateFileUrlRequestSignature("27", "1", "1", "x");
    assert.match(sig, /^[0-9a-f]{32}$/);
  });
});

describe("loadQobuzConfig", () => {
  it("returns null when env vars missing", () => {
    const config = loadQobuzConfig({});
    assert.equal(config, null);
  });

  it("returns null when partial env vars", () => {
    const config = loadQobuzConfig({
      QOBUZ_APP_ID: "test",
      // missing others
    });
    assert.equal(config, null);
  });

  it("returns config when all env vars present", () => {
    const config = loadQobuzConfig({
      QOBUZ_APP_ID: "test_id",
      QOBUZ_APP_SECRET: "test_secret",
      QOBUZ_EMAIL: "test@example.com",
      QOBUZ_PASSWORD: "test_pass",
    });
    assert.ok(config);
    assert.equal(config!.appId, "test_id");
    assert.equal(config!.appSecret, "test_secret");
    assert.equal(config!.email, "test@example.com");
    assert.equal(config!.password, "test_pass");
  });

  it("trims whitespace from env vars", () => {
    const config = loadQobuzConfig({
      QOBUZ_APP_ID: "  test_id  ",
      QOBUZ_APP_SECRET: "  test_secret  ",
      QOBUZ_EMAIL: "  test@example.com  ",
      QOBUZ_PASSWORD: "  test_pass  ",
    });
    assert.ok(config);
    assert.equal(config!.appId, "test_id");
    assert.equal(config!.appSecret, "test_secret");
  });
});
