/**
 * リトライの挙動を検証する。
 * ここで守りたいのは「再試行してはいけないものを再試行しない」こと。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { withRetry } from "./retry.js";
import { isRetryableApiError } from "./adapters/claude.js";

/** 待機を即時に潰す。テストを実時間で待たせない */
const noSleep = async (): Promise<void> => {};

describe("withRetry", () => {
  it("再試行可能なエラーなら成功するまで再実行する", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("一時的な失敗");
        return "ok";
      },
      { attempts: 3, isRetryable: () => true, sleep: noSleep },
    );

    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("再試行不能なエラーは1回で諦める", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("設定ミス");
        },
        { attempts: 5, isRetryable: () => false, sleep: noSleep },
      ),
      /設定ミス/,
    );

    assert.equal(calls, 1, "再試行不能なエラーで再実行してはいけない");
  });

  it("試行回数を使い切ったら最後のエラーを投げる", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`失敗${calls}`);
        },
        { attempts: 3, isRetryable: () => true, sleep: noSleep },
      ),
      /失敗3/,
    );

    assert.equal(calls, 3);
  });

  it("待ち時間が指数的に伸び、上限で頭打ちになる", async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("失敗");
        },
        {
          attempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 300,
          isRetryable: () => true,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    );

    assert.deepEqual(delays, [100, 200, 300, 300]);
  });
});

describe("isRetryableApiError", () => {
  const headers = new Headers();

  it("レート制限は再試行する", () => {
    const error = new Anthropic.RateLimitError(429, undefined, "rate limited", headers);
    assert.equal(isRetryableApiError(error), true);
  });

  it("5xx は再試行する", () => {
    const error = new Anthropic.InternalServerError(503, undefined, "unavailable", headers);
    assert.equal(isRetryableApiError(error), true);
  });

  it("接続エラーは再試行する", () => {
    const error = new Anthropic.APIConnectionError({ message: "connection refused" });
    assert.equal(isRetryableApiError(error), true);
  });

  it("400 は再試行しない", () => {
    const error = new Anthropic.BadRequestError(400, undefined, "bad request", headers);
    assert.equal(isRetryableApiError(error), false);
  });

  it("401 は再試行しない", () => {
    const error = new Anthropic.AuthenticationError(401, undefined, "invalid key", headers);
    assert.equal(isRetryableApiError(error), false);
  });

  it("SDK 由来でないエラーは再試行しない", () => {
    assert.equal(isRetryableApiError(new TypeError("バグ")), false);
  });
});
