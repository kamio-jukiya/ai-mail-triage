/**
 * 設定の検証。
 * 「デモはキー無しで動く」「本番は不足があれば起動時に落ちる」の2点が要。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseServiceAccount } from "./config.js";

const emptyEnv: NodeJS.ProcessEnv = {};

describe("loadConfig - デモモード", () => {
  it("環境変数が何も無くても動く", () => {
    const config = loadConfig({ mode: "demo", dryRun: false, env: emptyEnv });

    assert.equal(config.mode, "demo");
    assert.equal(config.model, "claude-opus-5");
    assert.equal(config.maxMessages, 20);
    assert.equal(config.confidenceThreshold, 0.6);
    assert.equal(config.anthropicApiKey, undefined);
  });
});

describe("loadConfig - 本番モード", () => {
  it("APIキーが無ければ ConfigError で止める", () => {
    assert.throws(
      () => loadConfig({ mode: "live", dryRun: false, env: emptyEnv }),
      (error: unknown) => error instanceof ConfigError && /ANTHROPIC_API_KEY/.test(error.message),
    );
  });

  it("APIキーだけあれば起動できる（連携先はコンソール出力になる）", () => {
    const config = loadConfig({
      mode: "live",
      dryRun: true,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    });

    assert.equal(config.anthropicApiKey, "sk-ant-test");
    assert.equal(config.google, undefined);
  });

  it("Google連携の設定が中途半端なら起動時に落とす", () => {
    assert.throws(
      () =>
        loadConfig({
          mode: "live",
          dryRun: false,
          env: {
            ANTHROPIC_API_KEY: "sk-ant-test",
            GMAIL_USER: "you@example.com",
            // GOOGLE_SERVICE_ACCOUNT_JSON と SHEETS_SPREADSHEET_ID が無い
          },
        }),
      (error: unknown) => error instanceof ConfigError && /Google連携/.test(error.message),
    );
  });

  it("Google連携が揃っていれば読み込む", () => {
    const config = loadConfig({
      mode: "live",
      dryRun: false,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "svc@example.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        }),
        GMAIL_USER: "you@example.com",
        SHEETS_SPREADSHEET_ID: "sheet-id",
      },
    });

    assert.equal(config.google?.gmailUser, "you@example.com");
    assert.equal(config.google?.sheetsRange, "triage!A:H", "未設定なら既定値を使う");
    assert.match(config.google?.credentials.private_key ?? "", /\n/, "改行を復元すること");
  });
});

describe("loadConfig - 数値の検証", () => {
  it("閾値が範囲外なら起動時に落とす", () => {
    assert.throws(
      () =>
        loadConfig({
          mode: "demo",
          dryRun: false,
          env: { TRIAGE_CONFIDENCE_THRESHOLD: "1.5" },
        }),
      ConfigError,
    );
  });

  it("数値でない値を渡されたら落とす", () => {
    assert.throws(
      () => loadConfig({ mode: "demo", dryRun: false, env: { TRIAGE_MAX_MESSAGES: "たくさん" } }),
      ConfigError,
    );
  });

  it("正しい値なら上書きされる", () => {
    const config = loadConfig({
      mode: "demo",
      dryRun: false,
      env: { TRIAGE_MAX_MESSAGES: "5", TRIAGE_CONFIDENCE_THRESHOLD: "0.8" },
    });

    assert.equal(config.maxMessages, 5);
    assert.equal(config.confidenceThreshold, 0.8);
  });
});

describe("parseServiceAccount", () => {
  it("JSONとして読めなければ ConfigError", () => {
    assert.throws(() => parseServiceAccount("not json"), ConfigError);
  });

  it("必要なキーが無ければ ConfigError", () => {
    assert.throws(() => parseServiceAccount(JSON.stringify({ foo: "bar" })), ConfigError);
  });
});
