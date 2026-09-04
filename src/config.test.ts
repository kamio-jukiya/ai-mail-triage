/**
 * 設定の検証。
 * 「デモはキー無しで動く」「本番は不足があれば起動時に落ちる」の2点が要。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseServiceAccount, resolveGoogleAuth } from "./config.js";

const emptyEnv: NodeJS.ProcessEnv = {};

// GitHub Secrets 経由だと改行が「\ + n」の2文字で届く。その状態を再現する
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "svc@example.iam.gserviceaccount.com",
  private_key: String.raw`-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`,
});

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

  it("サービスアカウント方式が揃っていれば読み込む", () => {
    const config = loadConfig({
      mode: "live",
      dryRun: false,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
        GMAIL_USER: "you@example.com",
        SHEETS_SPREADSHEET_ID: "sheet-id",
      },
    });

    assert.equal(config.google?.sheetsRange, "triage!A:H", "未設定なら既定値を使う");
    assert.ok(config.google?.auth.mode === "service_account");
    assert.equal(config.google.auth.subject, "you@example.com");
    assert.ok(
      config.google.auth.credentials.private_key.includes("\n"),
      "GitHub Secrets 経由で 2文字として届いた改行を復元すること",
    );
  });

  it("記録先が指定されていなければ落とす", () => {
    assert.throws(
      () =>
        loadConfig({
          mode: "live",
          dryRun: false,
          env: {
            ANTHROPIC_API_KEY: "sk-ant-test",
            GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
            GMAIL_USER: "you@example.com",
            // SHEETS_SPREADSHEET_ID が無い
          },
        }),
      (error: unknown) =>
        error instanceof ConfigError && /SHEETS_SPREADSHEET_ID/.test(error.message),
    );
  });
});

describe("resolveGoogleAuth - 認証方式の選択", () => {
  it("何も設定が無ければ null（Google連携なしで動く）", () => {
    assert.equal(resolveGoogleAuth({}), null);
  });

  it("OAuth の3つが揃っていれば oauth を選ぶ", () => {
    const auth = resolveGoogleAuth({
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
    });

    assert.ok(auth?.mode === "oauth");
    assert.equal(auth.refreshToken, "refresh");
  });

  it("OAuth の設定が欠けていたら落とす", () => {
    assert.throws(
      () =>
        resolveGoogleAuth({
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          // リフレッシュトークンが無い
        }),
      (error: unknown) =>
        error instanceof ConfigError && /GOOGLE_OAUTH_REFRESH_TOKEN/.test(error.message),
    );
  });

  it("サービスアカウント方式で GMAIL_USER が無ければ落とす", () => {
    // 個人の @gmail.com は委任を設定できないためここに来る。
    // 黙って通すとサービスアカウント自身の空のメールボックスを見にいく
    assert.throws(
      () => resolveGoogleAuth({ GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON }),
      (error: unknown) => error instanceof ConfigError && /OAuth方式/.test(error.message),
    );
  });

  it("両方の設定があれば、どちらを使うかを明示させる", () => {
    assert.throws(
      () =>
        resolveGoogleAuth({
          GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
          GMAIL_USER: "you@example.com",
          GOOGLE_OAUTH_CLIENT_ID: "id",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
        }),
      (error: unknown) => error instanceof ConfigError && /GOOGLE_AUTH_MODE/.test(error.message),
    );
  });

  it("GOOGLE_AUTH_MODE で明示すればその方式を使う", () => {
    const auth = resolveGoogleAuth({
      GOOGLE_AUTH_MODE: "oauth",
      GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
      GMAIL_USER: "you@example.com",
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
    });

    assert.equal(auth?.mode, "oauth");
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
