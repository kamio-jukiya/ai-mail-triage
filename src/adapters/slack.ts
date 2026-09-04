/**
 * Slack への通知（Incoming Webhook）。
 *
 * 通知するのは要対応のものだけ。自動通知や営業メールまで流すと
 * 通知そのものが読まれなくなり、仕組み全体が形骸化する。
 * 「保留」は必ず通知する。誰も気づかない保留は、保留ではなく消失なので。
 */

import { CATEGORY_LABELS, type Notifier, type TriageResult } from "../core/types.js";
import type { Logger } from "../logger.js";

export class SlackNotifier implements Notifier {
  readonly name = "slack";

  constructor(
    private readonly webhookUrl: string,
    private readonly logger: Logger,
  ) {}

  async notify(result: TriageResult): Promise<void> {
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildMessageText(result) }),
    });

    if (!response.ok) {
      // 本文にトークンは含まれないのでそのままログに出してよい
      const body = await response.text().catch(() => "");
      throw new Error(`Slack通知に失敗しました (HTTP ${response.status}): ${body}`);
    }

    this.logger.info("slack.notified", {
      messageId: result.message.id,
      category: result.classification.category,
    });
  }
}

/** 通知本文。Slackで見たときに1画面で判断できる情報量に絞る。 */
export function buildMessageText(result: TriageResult): string {
  const label = CATEGORY_LABELS[result.classification.category];
  const head = result.injectionSuspected
    ? ":rotating_light: 【保留】本文に分類器への指示とみられる記述があります。**下書きは作成していません**"
    : result.heldForReview
      ? `:warning: 【保留】確信度不足のため人の確認が必要です（元判定: ${result.originalCategory ?? "不明"}）`
      : `:mailbox_with_mail: 【${label}】要対応のメールが届いています`;

  return [
    head,
    `差出人: ${result.message.from}`,
    `件名: ${result.message.subject}`,
    `要約: ${result.classification.summary}`,
    `確信度: ${result.classification.confidence.toFixed(2)}`,
    `判断根拠: ${result.classification.reason}`,
  ].join("\n");
}
