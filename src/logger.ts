/**
 * 構造化ログ。1行1JSONで標準出力に書く。
 *
 * なぜJSONか: 定期実行が止まったとき、GitHub Actions のログを人が目で追うことになる。
 * 「どのメールで」「どの段階で」「何が起きたか」が機械的に拾える形にしておかないと、
 * 原因追跡に時間がかかる。jq でそのまま絞り込める形にしてある。
 *
 *   node dist/index.js --demo | jq 'select(.level == "error")'
 *
 * 人間向けのサマリだけは stderr に出す。標準出力をJSONだけに保つため。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** ログに乗せる追加フィールド。APIキーなどの秘密情報は絶対に入れない。 */
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** 実行単位で共通のフィールド（runId など）を持つ子ロガーを作る */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** この水準未満は出力しない。既定は info */
  minLevel?: LogLevel;
  /** 出力先。テストから差し替える */
  write?: (line: string) => void;
  /** 全ログに付与する共通フィールド */
  base?: LogFields;
  /** 時刻の取得。テストから固定する */
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = options.minLevel ?? "info";
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = options.base ?? {};
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      ts: now().toISOString(),
      level,
      event,
      ...base,
      ...fields,
    };
    write(JSON.stringify(record, replaceUnserializable));
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) =>
      createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/**
 * Error はそのままだと JSON.stringify で {} になるので展開する。
 * スタックトレースは長いので先頭3行だけ。
 */
function replaceUnserializable(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split("\n").slice(0, 3).join(" / "),
    };
  }
  return value;
}

/** 何も出力しないロガー。テスト用。 */
export function createNullLogger(): Logger {
  return createLogger({ write: () => {}, minLevel: "error" });
}
