/**
 * 振り分け処理のオーケストレーション。
 *
 * 「メールを取ってきて、分類して、記録して、必要なら通知して、下書きを作る」
 * という流れだけをここに書く。外部サービスの詳細は adapters が持つ。
 *
 * 設計上の約束:
 *   - 1通の失敗で全体を止めない（残りは処理し、失敗は errors に積む）
 *   - 失敗した通は「処理済み」にしない。次回の実行で拾い直せるようにする
 *   - dry-run では外部への書き込みを一切行わない
 */

import type { Logger } from "../logger.js";
import { withRetry, type RetryOptions } from "../retry.js";
import { buildTriageResult } from "./classify.js";
import { CATEGORY_LABELS, type Category, type Classifier, type DraftWriter, type EmailMessage, type MailSource, type Notifier, type ProcessedStore, type RecordSink, type TriageResult } from "./types.js";

export interface PipelineDeps {
  source: MailSource;
  classifier: Classifier;
  sink: RecordSink;
  notifier: Notifier;
  /** 下書き作成先。未設定なら下書きを作らない */
  draftWriter?: DraftWriter;
  store: ProcessedStore;
  logger: Logger;
}

export interface PipelineOptions {
  /** 1回の実行で処理する上限 */
  maxMessages: number;
  /** これを下回る確信度は保留に倒す */
  confidenceThreshold: number;
  /** true なら外部への書き込みを一切しない */
  dryRun: boolean;
  /**
   * ログにメールの内容（件名など）を含めるか。
   * 公開リポジトリの GitHub Actions 実行ログは誰でも読めるため、本番では false にする。
   */
  logContent: boolean;
  /** 分類APIのリトライ設定 */
  retry?: RetryOptions;
}

export interface PipelineFailure {
  messageId: string;
  subject: string;
  error: unknown;
}

export interface PipelineSummary {
  fetched: number;
  skippedAsProcessed: number;
  processed: number;
  heldForReview: number;
  /** 分類器への指示らしき記述が見つかり、分類結果を採用しなかった件数 */
  injectionSuspected: number;
  notified: number;
  draftsCreated: number;
  failed: number;
  /** カテゴリ別の件数 */
  byCategory: Partial<Record<Category, number>>;
  results: TriageResult[];
  failures: PipelineFailure[];
  dryRun: boolean;
}

export async function runPipeline(
  deps: PipelineDeps,
  options: PipelineOptions,
): Promise<PipelineSummary> {
  const { logger } = deps;

  const summary: PipelineSummary = {
    fetched: 0,
    skippedAsProcessed: 0,
    processed: 0,
    heldForReview: 0,
    injectionSuspected: 0,
    notified: 0,
    draftsCreated: 0,
    failed: 0,
    byCategory: {},
    results: [],
    failures: [],
    dryRun: options.dryRun,
  };

  logger.info("pipeline.start", {
    source: deps.source.name,
    classifier: deps.classifier.name,
    sink: deps.sink.name,
    notifier: deps.notifier.name,
    store: deps.store.name,
    dryRun: options.dryRun,
    maxMessages: options.maxMessages,
    confidenceThreshold: options.confidenceThreshold,
  });

  const messages = await deps.source.fetch(options.maxMessages);
  summary.fetched = messages.length;
  logger.info("pipeline.fetched", { count: messages.length });

  for (const message of messages) {
    try {
      const handled = await handleMessage(message, deps, options, summary);
      if (!handled) summary.skippedAsProcessed++;
    } catch (error) {
      // 1通のエラーで実行全体を落とさない。
      // 処理済みにも記録しないので、次回の実行で自動的に拾い直される。
      summary.failed++;
      summary.failures.push({ messageId: message.id, subject: message.subject, error });
      logger.error("message.failed", {
        messageId: message.id,
        ...(options.logContent ? { subject: message.subject } : {}),
        error,
      });
    }
  }

  logger.info("pipeline.done", {
    fetched: summary.fetched,
    processed: summary.processed,
    skippedAsProcessed: summary.skippedAsProcessed,
    heldForReview: summary.heldForReview,
    injectionSuspected: summary.injectionSuspected,
    notified: summary.notified,
    draftsCreated: summary.draftsCreated,
    failed: summary.failed,
    byCategory: summary.byCategory,
  });

  return summary;
}

/** 1通を処理する。処理済みでスキップした場合は false を返す。 */
async function handleMessage(
  message: EmailMessage,
  deps: PipelineDeps,
  options: PipelineOptions,
  summary: PipelineSummary,
): Promise<boolean> {
  const { logger } = deps;

  if (await deps.store.has(message.id)) {
    logger.debug("message.skipped", { messageId: message.id, reason: "already_processed" });
    return false;
  }

  // 分類だけは外部API呼び出しなのでリトライを挟む
  const raw = await withRetry(() => deps.classifier.classify(message), {
    ...options.retry,
    logger,
    label: `classify:${message.id}`,
  });

  const result = buildTriageResult(message, raw, options.confidenceThreshold);

  logger.info("message.classified", {
    messageId: message.id,
    // 件名は内容そのもの。既定では出さない（logContent の既定は false）
    ...(options.logContent ? { subject: message.subject } : {}),
    category: result.classification.category,
    categoryLabel: CATEGORY_LABELS[result.classification.category],
    confidence: result.classification.confidence,
    heldForReview: result.heldForReview,
    originalCategory: result.originalCategory,
    actionRequired: result.actionRequired,
    injectionSuspected: result.injectionSuspected,
  });

  summary.results.push(result);
  summary.processed++;
  if (result.heldForReview) summary.heldForReview++;
  if (result.injectionSuspected) summary.injectionSuspected++;
  const category = result.classification.category;
  summary.byCategory[category] = (summary.byCategory[category] ?? 0) + 1;

  // ここから先は外部への書き込み。dry-run では全部飛ばす
  if (options.dryRun) {
    logger.info("message.dry_run", {
      messageId: message.id,
      note: "記録・通知・下書き作成をスキップしました",
    });
    return true;
  }

  await deps.sink.record(result);

  if (result.actionRequired) {
    await deps.notifier.notify(result);
    summary.notified++;
  }

  // 返信下書きは、要対応かつ下書き本文がある場合だけ作る。
  // 保留のものは下書きを持たない（applyConfidenceThreshold で捨てている）
  if (deps.draftWriter && result.actionRequired && result.classification.replyDraft.trim() !== "") {
    await deps.draftWriter.createDraft(result);
    summary.draftsCreated++;
  }

  // すべての書き込みが成功してから処理済みにする。
  // 途中で落ちた場合は未処理のまま残り、次回やり直される。
  await deps.store.add(message.id);
  logger.debug("message.completed", { messageId: message.id });

  return true;
}
