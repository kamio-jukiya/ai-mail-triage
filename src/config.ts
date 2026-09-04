/**
 * 環境変数の読み込みと検証。
 *
 * 方針: 起動直後に全部検証して、足りなければその場で止める。
 * メールを5通処理したあとで「SLACK_WEBHOOK_URL が無い」と落ちるのが一番たちが悪い。
 *
 * デモモードでは何も必須にしない。APIキーを取らないと動かないツールは
 * 受け取った人に触ってもらえない。
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { GoogleAuthConfig } from "./adapters/google-auth.js";

export type RunMode = "demo" | "live";

export interface Config {
  mode: RunMode;
  dryRun: boolean;
  maxMessages: number;
  confidenceThreshold: number;
  model: string;
  anthropicApiKey?: string;
  google?: {
    /** 認証方式。個人の @gmail.com では oauth しか使えない */
    auth: GoogleAuthConfig;
    gmailQuery: string;
    spreadsheetId: string;
    sheetsRange: string;
  };
  slackWebhookUrl?: string;
  /** 処理済みIDの保存先 */
  statePath: string;
  /**
   * ログと画面表示にメールの内容（件名・差出人・要約）を含めるか。
   * 公開リポジトリの GitHub Actions 実行ログは誰でも読めるため、既定は false。
   * デモは fixtures の作り話なので既定で true にしている。
   */
  logContent: boolean;
}

/** 数値の環境変数。未設定なら既定値、不正な値なら起動時に落とす。 */
const numberFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? fallback : Number(value)))
    .pipe(z.number().min(min).max(max));

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  TRIAGE_MODEL: z.string().optional(),
  TRIAGE_MAX_MESSAGES: numberFromEnv(20, 1, 500),
  TRIAGE_CONFIDENCE_THRESHOLD: numberFromEnv(0.6, 0, 1),
  TRIAGE_STATE_PATH: z.string().optional(),
  GOOGLE_AUTH_MODE: z.enum(["service_account", "oauth"]).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER: z.string().optional(),
  GMAIL_QUERY: z.string().optional(),
  SHEETS_SPREADSHEET_ID: z.string().optional(),
  SHEETS_RANGE: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  TRIAGE_LOG_CONTENT: z.enum(["true", "false"]).optional(),
});

export interface LoadConfigInput {
  mode: RunMode;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 設定不備を表すエラー。CLI 側で使い方を出すために型で区別する。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(input: LoadConfigInput): Config {
  const env = input.env ?? process.env;
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`環境変数の値が不正です:\n${details}`);
  }

  const e = parsed.data;

  const config: Config = {
    mode: input.mode,
    dryRun: input.dryRun,
    maxMessages: e.TRIAGE_MAX_MESSAGES,
    confidenceThreshold: e.TRIAGE_CONFIDENCE_THRESHOLD,
    model: e.TRIAGE_MODEL ?? "claude-opus-5",
    statePath: e.TRIAGE_STATE_PATH ?? "state/processed.json",
    logContent: e.TRIAGE_LOG_CONTENT
      ? e.TRIAGE_LOG_CONTENT === "true"
      : input.mode === "demo",
  };

  // デモは外部サービスを一切使わないので、ここで検証は終わり
  if (input.mode === "demo") return config;

  if (!e.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY が設定されていません。.env.example をコピーして .env を作成してください。" +
        "（APIキー無しで動作を確認したい場合は --demo を付けてください）",
    );
  }
  config.anthropicApiKey = e.ANTHROPIC_API_KEY;

  // Google 連携。設定されていなければコンソール出力にフォールバックする。
  // 中途半端な設定は事故のもとなので、揃っていなければ起動時に落とす
  const auth = resolveGoogleAuth(e);

  if (auth) {
    if (!has(e.SHEETS_SPREADSHEET_ID)) {
      throw new ConfigError(
        "Google連携の設定が不足しています。SHEETS_SPREADSHEET_ID を設定してください。",
      );
    }

    config.google = {
      auth,
      gmailQuery: e.GMAIL_QUERY ?? "is:unread -category:promotions",
      spreadsheetId: e.SHEETS_SPREADSHEET_ID as string,
      sheetsRange: e.SHEETS_RANGE ?? "triage!A:H",
    };
  }

  if (e.SLACK_WEBHOOK_URL) config.slackWebhookUrl = e.SLACK_WEBHOOK_URL;

  return config;
}

const has = (value: string | undefined): boolean => value !== undefined && value !== "";

/**
 * どちらの認証方式を使うかを決める。
 *
 *   - OAuth の変数が設定されていれば OAuth
 *   - サービスアカウントJSONが設定されていればサービスアカウント
 *   - 両方あれば GOOGLE_AUTH_MODE で明示させる（黙ってどちらかを選ぶと事故る）
 *   - どちらも無ければ null（Google連携なしで動く）
 */
export function resolveGoogleAuth(env: {
  GOOGLE_AUTH_MODE?: "service_account" | "oauth" | undefined;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string | undefined;
  GOOGLE_OAUTH_CLIENT_ID?: string | undefined;
  GOOGLE_OAUTH_CLIENT_SECRET?: string | undefined;
  GOOGLE_OAUTH_REFRESH_TOKEN?: string | undefined;
  GMAIL_USER?: string | undefined;
}): GoogleAuthConfig | null {
  const oauthValues = [
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REFRESH_TOKEN,
  ];
  const oauthCount = oauthValues.filter(has).length;
  const hasServiceAccount = has(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const mode =
    env.GOOGLE_AUTH_MODE ??
    (oauthCount > 0 && hasServiceAccount
      ? null
      : oauthCount > 0
        ? "oauth"
        : hasServiceAccount
          ? "service_account"
          : undefined);

  if (mode === null) {
    throw new ConfigError(
      "OAuth とサービスアカウントの設定が両方あります。GOOGLE_AUTH_MODE に oauth か service_account を指定してください。",
    );
  }

  if (mode === undefined) return null;

  if (mode === "oauth") {
    if (oauthCount < oauthValues.length) {
      throw new ConfigError(
        "OAuth の設定が不足しています。GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / " +
          "GOOGLE_OAUTH_REFRESH_TOKEN をすべて設定してください。" +
          "（リフレッシュトークンは npm run auth:google で取得できます）",
      );
    }

    return {
      mode: "oauth",
      clientId: env.GOOGLE_OAUTH_CLIENT_ID as string,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET as string,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN as string,
    };
  }

  if (!hasServiceAccount) {
    throw new ConfigError(
      "GOOGLE_AUTH_MODE=service_account ですが GOOGLE_SERVICE_ACCOUNT_JSON がありません。",
    );
  }

  if (!has(env.GMAIL_USER)) {
    // 委任先を指定しないとサービスアカウント自身の空のメールボックスを見にいく
    throw new ConfigError(
      "サービスアカウント方式には GMAIL_USER（委任先のメールアドレス）が必要です。" +
        "個人の @gmail.com はドメイン全体の委任を設定できないため、OAuth方式を使ってください。",
    );
  }

  return {
    mode: "service_account",
    credentials: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON as string),
    subject: env.GMAIL_USER as string,
  };
}

/** サービスアカウントJSONを読む。改行がエスケープされている場合に対応する。 */
export function parseServiceAccount(raw: string): { client_email: string; private_key: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      "GOOGLE_SERVICE_ACCOUNT_JSON をJSONとして読めませんでした。1行に圧縮した状態で設定してください。",
    );
  }

  const schema = z.object({
    client_email: z.string().min(1),
    private_key: z.string().min(1),
  });
  const parsed = schema.safeParse(json);

  if (!parsed.success) {
    throw new ConfigError(
      "GOOGLE_SERVICE_ACCOUNT_JSON に client_email または private_key が含まれていません。",
    );
  }

  return {
    client_email: parsed.data.client_email,
    // GitHub Secrets 経由だと改行が \n の2文字になって届くことがある
    private_key: parsed.data.private_key.replace(/\\n/g, "\n"),
  };
}

/**
 * .env を読み込んで process.env に反映する。
 *
 * dotenv を入れてもよいが、この程度の処理のために依存を増やしたくない。
 * 既に設定済みの環境変数は上書きしない（CI の Secrets を .env が壊さないように）。
 */
export function loadDotEnv(path = ".env"): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // .env が無いのは正常。CI では Secrets から環境変数が渡る
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    // 値全体がクォートで囲まれている場合は外す
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
