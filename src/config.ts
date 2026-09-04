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

export type RunMode = "demo" | "live";

export interface Config {
  mode: RunMode;
  dryRun: boolean;
  maxMessages: number;
  confidenceThreshold: number;
  model: string;
  anthropicApiKey?: string;
  google?: {
    credentials: { client_email: string; private_key: string };
    gmailUser: string;
    gmailQuery: string;
    spreadsheetId: string;
    sheetsRange: string;
  };
  slackWebhookUrl?: string;
  /** 処理済みIDの保存先 */
  statePath: string;
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
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GMAIL_USER: z.string().optional(),
  GMAIL_QUERY: z.string().optional(),
  SHEETS_SPREADSHEET_ID: z.string().optional(),
  SHEETS_RANGE: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
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

  // Google 連携は「全部設定するか、全部設定しないか」のどちらか。
  // 中途半端な設定は事故のもとなので、揃っていなければ起動時に落とす
  const googleKeys = [
    e.GOOGLE_SERVICE_ACCOUNT_JSON,
    e.GMAIL_USER,
    e.SHEETS_SPREADSHEET_ID,
  ];
  const configuredCount = googleKeys.filter((v) => v && v !== "").length;

  if (configuredCount > 0 && configuredCount < googleKeys.length) {
    throw new ConfigError(
      "Google連携の設定が不足しています。GOOGLE_SERVICE_ACCOUNT_JSON / GMAIL_USER / SHEETS_SPREADSHEET_ID は" +
        "すべて設定するか、すべて空にしてください。",
    );
  }

  if (configuredCount === googleKeys.length) {
    config.google = {
      credentials: parseServiceAccount(e.GOOGLE_SERVICE_ACCOUNT_JSON as string),
      gmailUser: e.GMAIL_USER as string,
      gmailQuery: e.GMAIL_QUERY ?? "is:unread -category:promotions",
      spreadsheetId: e.SHEETS_SPREADSHEET_ID as string,
      sheetsRange: e.SHEETS_RANGE ?? "triage!A:H",
    };
  }

  if (e.SLACK_WEBHOOK_URL) config.slackWebhookUrl = e.SLACK_WEBHOOK_URL;

  return config;
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
    private_key: parsed.data.private_key.replace(/\n/g, "\n"),
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
