/**
 * 指数バックオフ付きのリトライ。
 *
 * 方針: 再試行して意味があるものだけ再試行する。
 *   - レート制限（429）と 5xx、ネットワーク断 → 待てば直る可能性がある → 再試行
 *   - 400系（リクエスト不正・認証エラー） → 何度投げても同じ → 即座に失敗させる
 *
 * 400系を再試行すると、壊れたリクエストを3回投げて3回課金され、
 * ログには同じエラーが3行並ぶだけで原因は1ミリも分からない。
 * 「再試行しない」判断を明示的に書くことがリトライ実装の本体だと考えている。
 */

import type { Logger } from "./logger.js";

export interface RetryOptions {
  /** 最大試行回数（初回を含む）。既定は3 */
  attempts?: number;
  /** 初回の待ち時間(ms)。以降 2倍ずつ伸ばす */
  baseDelayMs?: number;
  /** 待ち時間の上限(ms) */
  maxDelayMs?: number;
  /** 再試行すべきエラーかを判定する。既定はすべて再試行しない */
  isRetryable?: (error: unknown) => boolean;
  /** 待機処理。テストから差し替えて即時実行する */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** ログに出す処理名 */
  label?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fn を実行し、再試行可能なエラーなら指数バックオフで再実行する。
 * 再試行不能なエラー、または試行回数を使い切った場合は最後のエラーをそのまま投げる。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const isRetryable = options.isRetryable ?? (() => false);
  const sleep = options.sleep ?? defaultSleep;
  const label = options.label ?? "operation";

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 再試行しても結果が変わらないエラーはここで打ち切る
      if (!isRetryable(error)) {
        options.logger?.warn("retry.aborted", {
          label,
          attempt,
          reason: "not_retryable",
          error,
        });
        throw error;
      }

      // 最後の試行で失敗したらそのまま投げる
      if (attempt === attempts) {
        options.logger?.error("retry.exhausted", { label, attempts, error });
        throw error;
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      options.logger?.warn("retry.scheduled", {
        label,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }

  // ループは必ず return か throw で抜けるのでここには来ない
  throw lastError;
}
