/**
 * デモ用のインメモリ実装。
 *
 * fixtures/emails.json をメールの取得元にし、記録・通知・下書き作成は
 * 標準出力へのログだけにする。外部への通信は一切しない。
 * これにより `npm run demo` がAPIキーもネットワークも無しで完走する。
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  DraftWriter,
  EmailMessage,
  MailSource,
  Notifier,
  RecordSink,
  TriageResult,
} from "../core/types.js";
import { CATEGORY_LABELS } from "../core/types.js";
import type { Logger } from "../logger.js";

/** fixtures の形式。壊れたJSONを黙って読み飛ばさないよう検証する。 */
const FixtureEmailSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  from: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.string(),
});

const FixtureFileSchema = z.array(FixtureEmailSchema);

/** JSONファイルからメールを読み込む取得元。 */
export class FixtureMailSource implements MailSource {
  readonly name = "fixture";

  constructor(private readonly filePath: string) {}

  async fetch(limit: number): Promise<EmailMessage[]> {
    const raw = await readFile(this.filePath, "utf-8");
    const parsed = FixtureFileSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) {
      throw new Error(
        `fixtures の形式が不正です (${this.filePath}): ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join(", ")}`,
      );
    }

    return parsed.data.slice(0, limit);
  }
}

/** 配列を直接渡す取得元。テスト用。 */
export class InMemoryMailSource implements MailSource {
  readonly name = "memory";

  constructor(private readonly messages: EmailMessage[]) {}

  async fetch(limit: number): Promise<EmailMessage[]> {
    return this.messages.slice(0, limit);
  }
}

/** 記録先。実際には書き込まず、ログに残して保持する。 */
export class ConsoleRecordSink implements RecordSink {
  readonly name = "console";

  readonly recorded: TriageResult[] = [];

  constructor(private readonly logger: Logger) {}

  async record(result: TriageResult): Promise<void> {
    this.recorded.push(result);
    this.logger.info("sink.recorded", {
      sink: this.name,
      messageId: result.message.id,
      category: result.classification.category,
      categoryLabel: CATEGORY_LABELS[result.classification.category],
      summary: result.classification.summary,
    });
  }
}

/** 通知先。実際には送らず、ログに残して保持する。 */
export class ConsoleNotifier implements Notifier {
  readonly name = "console";

  readonly notified: TriageResult[] = [];

  constructor(private readonly logger: Logger) {}

  async notify(result: TriageResult): Promise<void> {
    this.notified.push(result);
    this.logger.info("notifier.sent", {
      notifier: this.name,
      messageId: result.message.id,
      category: result.classification.category,
      heldForReview: result.heldForReview,
      subject: result.message.subject,
    });
  }
}

/** 下書き作成先。実際には作らず、ログに残して保持する。 */
export class ConsoleDraftWriter implements DraftWriter {
  readonly name = "console";

  readonly drafts: TriageResult[] = [];

  constructor(private readonly logger: Logger) {}

  async createDraft(result: TriageResult): Promise<void> {
    this.drafts.push(result);
    this.logger.info("draft.created", {
      writer: this.name,
      messageId: result.message.id,
      to: result.message.from,
      chars: result.classification.replyDraft.length,
    });
  }
}
