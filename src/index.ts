/**
 * CLI エントリポイント。
 *
 *   node dist/index.js --demo      APIキー・ネットワーク不要。fixtures を使って一連の流れを見せる
 *   node dist/index.js --dry-run   本番のメールを分類するが、書き込みは一切しない
 *   node dist/index.js             本番実行
 *
 * 標準出力は1行1JSONのログ、標準エラーは人間向けのサマリ。
 * 標準出力をそのまま jq に流せるようにするための分離。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, loadDotEnv, ConfigError, type Config, type RunMode } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { runPipeline, type PipelineDeps, type PipelineSummary } from "./core/pipeline.js";
import { FileProcessedStore, MemoryProcessedStore } from "./core/store.js";
import { CATEGORY_LABELS } from "./core/types.js";
import { ClaudeClassifier, isRetryableApiError } from "./adapters/claude.js";
import { StubClassifier } from "./adapters/stub.js";
import {
  ConsoleDraftWriter,
  ConsoleNotifier,
  ConsoleRecordSink,
  FixtureMailSource,
} from "./adapters/memory.js";
import { GmailDraftWriter, GmailMailSource } from "./adapters/gmail.js";
import { SheetsRecordSink } from "./adapters/sheets.js";
import { SlackNotifier } from "./adapters/slack.js";

interface CliArgs {
  mode: RunMode;
  dryRun: boolean;
  help: boolean;
  verbose: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  return {
    mode: argv.includes("--demo") ? "demo" : "live",
    // デモは外部に書き込む先が無いので dry-run 扱いにはしない（流れを最後まで見せる）
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
    verbose: argv.includes("--verbose"),
  };
}

const USAGE = `
ai-mail-triage - 受信メールを生成AIで分類し、記録・通知・返信下書きまでを自動化する

使い方:
  node dist/index.js [オプション]

オプション:
  --demo       サンプルメール(fixtures/emails.json)とルールベース分類器で動かす。
               APIキーもネットワークも不要。
  --dry-run    分類までは本番と同じに行い、記録・通知・下書き作成は行わない。
  --verbose    デバッグログも出力する。
  -h, --help   このヘルプを表示する。

設定:
  .env.example をコピーして .env を作成してください。
  詳しい手順は docs/operations.md にあります。
`.trim();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stderr.write(USAGE + "\n");
    return;
  }

  loadDotEnv();

  const logger = createLogger({
    minLevel: args.verbose ? "debug" : "info",
    base: { runId: new Date().toISOString(), mode: args.mode },
  });

  const config = loadConfig({ mode: args.mode, dryRun: args.dryRun });
  const deps = args.mode === "demo" ? buildDemoDeps(logger) : buildLiveDeps(config, logger);

  const summary = await runPipeline(deps, {
    maxMessages: config.maxMessages,
    confidenceThreshold: config.confidenceThreshold,
    dryRun: config.dryRun,
    retry: {
      attempts: 3,
      baseDelayMs: 1_000,
      isRetryable: isRetryableApiError,
    },
  });

  printSummary(summary, config);

  // 1通でも失敗していたら異常終了。CI やスケジュール実行が「緑」のまま
  // 失敗を見逃すことを防ぐ
  if (summary.failed > 0) process.exitCode = 1;
}

/** デモ用の依存。外部通信は一切しない。 */
function buildDemoDeps(logger: Logger): PipelineDeps {
  // ESM では __dirname が使えないので import.meta.url から解決する。
  // dist/ から実行されるため、fixtures はひとつ上の階層にある
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(here, "..", "fixtures", "emails.json");

  return {
    source: new FixtureMailSource(fixturePath),
    classifier: new StubClassifier(),
    sink: new ConsoleRecordSink(logger),
    notifier: new ConsoleNotifier(logger),
    draftWriter: new ConsoleDraftWriter(logger),
    // デモでは毎回まっさらな状態から動かす（冪等性の確認は test で行う）
    store: new MemoryProcessedStore(),
    logger,
  };
}

/** 本番用の依存。設定されていない連携先はコンソール出力にフォールバックする。 */
function buildLiveDeps(config: Config, logger: Logger): PipelineDeps {
  if (!config.anthropicApiKey) {
    throw new ConfigError("ANTHROPIC_API_KEY が設定されていません。");
  }

  const classifier = new ClaudeClassifier({
    apiKey: config.anthropicApiKey,
    model: config.model,
    logger,
  });

  const google = config.google;

  const gmailOptions = google
    ? { credentials: google.credentials, userEmail: google.gmailUser, logger }
    : undefined;

  return {
    source:
      google && gmailOptions
        ? new GmailMailSource(gmailOptions, google.gmailQuery)
        : throwMissing("GMAIL_USER / GOOGLE_SERVICE_ACCOUNT_JSON"),
    classifier,
    sink: google
      ? new SheetsRecordSink({
          credentials: google.credentials,
          spreadsheetId: google.spreadsheetId,
          range: google.sheetsRange,
          logger,
        })
      : new ConsoleRecordSink(logger),
    notifier: config.slackWebhookUrl
      ? new SlackNotifier(config.slackWebhookUrl, logger)
      : new ConsoleNotifier(logger),
    ...(gmailOptions ? { draftWriter: new GmailDraftWriter(gmailOptions) } : {}),
    store: new FileProcessedStore(config.statePath),
    logger,
  };
}

function throwMissing(names: string): never {
  throw new ConfigError(
    `本番実行には ${names} の設定が必要です。設定せずに動作を確認したい場合は --demo を付けてください。`,
  );
}

/** 人間向けのサマリを標準エラーに出す。標準出力はJSONログ専用に保つ。 */
export function printSummary(summary: PipelineSummary, config: Config): void {
  const lines: string[] = [];

  lines.push("");
  lines.push("──────────────────────────────────────────");
  lines.push(`  実行結果 (${config.mode === "demo" ? "デモ" : "本番"}${summary.dryRun ? " / ドライラン" : ""})`);
  lines.push("──────────────────────────────────────────");
  lines.push(`  取得        : ${summary.fetched} 件`);
  lines.push(`  処理        : ${summary.processed} 件`);
  lines.push(`  スキップ    : ${summary.skippedAsProcessed} 件 (処理済み)`);
  // 保留は「分類器が unclassified と答えたもの」と「確信度不足で倒したもの」の合計。
  // 現場が見るのはこの数字なので、内訳を括弧で添える
  const held = summary.byCategory.unclassified ?? 0;
  lines.push(
    `  保留        : ${held} 件 (うち確信度 ${config.confidenceThreshold} 未満による差し戻し ${summary.heldForReview} 件)`,
  );
  lines.push(`  通知        : ${summary.notified} 件`);
  lines.push(`  下書き作成  : ${summary.draftsCreated} 件`);
  lines.push(`  失敗        : ${summary.failed} 件`);
  lines.push("");
  lines.push("  分類の内訳:");

  for (const [category, count] of Object.entries(summary.byCategory)) {
    const label = CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
    lines.push(`    ${label.padEnd(10, "　")} ${count} 件`);
  }

  if (summary.results.some((r) => r.classification.category === "unclassified")) {
    lines.push("");
    lines.push("  保留になったメール (人の確認が必要):");
    for (const result of summary.results) {
      if (result.classification.category !== "unclassified") continue;
      lines.push(`    - ${result.message.subject} (${result.message.from})`);
      lines.push(`      理由: ${result.classification.reason}`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push("");
    lines.push("  失敗したメール (次回の実行で再処理されます):");
    for (const failure of summary.failures) {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      lines.push(`    - ${failure.subject}: ${message}`);
    }
  }

  lines.push("──────────────────────────────────────────");
  lines.push("");

  process.stderr.write(lines.join("\n"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // 設定ミスはスタックトレースを出しても意味がないので、直し方だけ伝える
    process.stderr.write(`\n設定エラー: ${error.message}\n\n`);
    process.exitCode = 2;
    return;
  }

  process.stderr.write(`\n予期しないエラーで停止しました:\n${String(error)}\n\n`);
  process.exitCode = 1;
});
