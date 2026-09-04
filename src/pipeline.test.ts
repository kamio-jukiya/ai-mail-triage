/**
 * パイプライン全体の検証。
 * 「運用に乗るか」を決める挙動 — 冪等性・ドライラン・部分失敗 — を押さえる。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPipeline, type PipelineDeps } from "./core/pipeline.js";
import { MemoryProcessedStore } from "./core/store.js";
import type { Classification, Classifier, EmailMessage } from "./core/types.js";
import { createNullLogger } from "./logger.js";
import { StubClassifier } from "./adapters/stub.js";
import {
  ConsoleDraftWriter,
  ConsoleNotifier,
  ConsoleRecordSink,
  InMemoryMailSource,
} from "./adapters/memory.js";

const logger = createNullLogger();

const messages: EmailMessage[] = [
  {
    id: "m-1",
    from: "a@example.com",
    subject: "見積のお願い",
    body: "お見積りをお願いします。",
    receivedAt: "2026-09-03T00:00:00Z",
  },
  {
    id: "m-2",
    from: "noreply@example.com",
    subject: "請求のお知らせ",
    body: "※このメールは自動送信です。",
    receivedAt: "2026-09-03T01:00:00Z",
  },
  {
    id: "m-3",
    from: "c@example.com",
    subject: "先日の件",
    body: "その後いかがでしょうか。",
    receivedAt: "2026-09-03T02:00:00Z",
  },
];

function buildDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & {
  sink: ConsoleRecordSink;
  notifier: ConsoleNotifier;
  draftWriter: ConsoleDraftWriter;
  store: MemoryProcessedStore;
} {
  const deps = {
    source: new InMemoryMailSource(messages),
    classifier: new StubClassifier(),
    sink: new ConsoleRecordSink(logger),
    notifier: new ConsoleNotifier(logger),
    draftWriter: new ConsoleDraftWriter(logger),
    store: new MemoryProcessedStore(),
    logger,
    ...overrides,
  };
  return deps as PipelineDeps & {
    sink: ConsoleRecordSink;
    notifier: ConsoleNotifier;
    draftWriter: ConsoleDraftWriter;
    store: MemoryProcessedStore;
  };
}

const options = { maxMessages: 20, confidenceThreshold: 0.6, dryRun: false, logContent: false };

describe("runPipeline", () => {
  it("全件を分類し、要対応だけ通知する", async () => {
    const deps = buildDeps();
    const summary = await runPipeline(deps, options);

    assert.equal(summary.fetched, 3);
    assert.equal(summary.processed, 3);
    assert.equal(summary.failed, 0);
    assert.equal(deps.sink.recorded.length, 3, "記録は全件に対して行う");

    // 見積依頼と保留は通知、自動通知は通知しない
    assert.equal(summary.notified, 2);
    assert.deepEqual(
      deps.notifier.notified.map((r) => r.message.id).sort(),
      ["m-1", "m-3"],
    );
  });

  it("下書きは返信文がある要対応のものだけ作る", async () => {
    const deps = buildDeps();
    await runPipeline(deps, options);

    // m-3 は保留なので下書きを持たない
    assert.deepEqual(
      deps.draftWriter.drafts.map((r) => r.message.id),
      ["m-1"],
    );
  });

  it("2回目の実行では処理済みをスキップする（冪等性）", async () => {
    const deps = buildDeps();
    await runPipeline(deps, options);

    const second = await runPipeline(deps, options);

    assert.equal(second.fetched, 3);
    assert.equal(second.processed, 0, "処理済みのメールを再処理してはいけない");
    assert.equal(second.skippedAsProcessed, 3);
    assert.equal(deps.sink.recorded.length, 3, "2回目で記録が増えてはいけない");
    assert.equal(deps.notifier.notified.length, 2, "2回目で通知が増えてはいけない");
  });

  it("--dry-run では外部への書き込みを一切しない", async () => {
    const deps = buildDeps();
    const summary = await runPipeline(deps, { ...options, dryRun: true });

    assert.equal(summary.processed, 3, "分類自体は行う");
    assert.equal(deps.sink.recorded.length, 0);
    assert.equal(deps.notifier.notified.length, 0);
    assert.equal(deps.draftWriter.drafts.length, 0);
    assert.deepEqual(deps.store.snapshot(), [], "処理済みにも記録しない");
  });

  it("1通が失敗しても残りを処理し、失敗分は処理済みにしない", async () => {
    const failing: Classifier = {
      name: "failing",
      classify: async (message: EmailMessage): Promise<Classification> => {
        if (message.id === "m-2") throw new Error("分類APIが落ちた");
        return new StubClassifier().classify(message);
      },
    };

    const deps = buildDeps({ classifier: failing });
    const summary = await runPipeline(deps, options);

    assert.equal(summary.processed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.failures[0]?.messageId, "m-2");
    assert.ok(
      !deps.store.snapshot().includes("m-2"),
      "失敗したメールは次回の実行で拾い直せるよう未処理のままにする",
    );

    // 次の実行で m-2 だけが処理対象になる
    const second = await runPipeline(buildDeps({ store: deps.store }), options);
    assert.equal(second.processed, 1);
    assert.equal(second.results[0]?.message.id, "m-2");
  });

  it("確信度が閾値未満なら保留に倒して通知する", async () => {
    const lowConfidence: Classifier = {
      name: "low-confidence",
      classify: async (): Promise<Classification> => ({
        category: "quote_request",
        confidence: 0.3,
        summary: "見積のようだが自信がない",
        reason: "曖昧",
        replyDraft: "お見積りいたします。",
      }),
    };

    const deps = buildDeps({ classifier: lowConfidence });
    const summary = await runPipeline(deps, options);

    assert.equal(summary.heldForReview, 3);
    assert.equal(summary.notified, 3, "保留は必ず人に通知する");
    assert.equal(deps.draftWriter.drafts.length, 0, "保留のものに下書きを作らない");
    assert.equal(summary.byCategory.unclassified, 3);
  });

  it("maxMessages で1回の処理件数を制限する", async () => {
    const deps = buildDeps();
    const summary = await runPipeline(deps, { ...options, maxMessages: 1 });

    assert.equal(summary.fetched, 1);
    assert.equal(summary.processed, 1);
  });
});
