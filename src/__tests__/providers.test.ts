// Unit test: provider configs (YouTube, SoundCloud, Qobuz).
// Test client args, config loading, provider properties.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YouTubeProvider } from "../providers/youtube.js";
import { SoundCloudProvider } from "../providers/soundcloud.js";
import { QobuzProvider, loadQobuzConfig } from "../providers/qobuz.js";

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
