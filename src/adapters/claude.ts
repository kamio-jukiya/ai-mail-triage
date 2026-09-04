/**
 * Claude API を使う分類器（本番用）。
 *
 * 実装の要点:
 *   - 構造化出力は `client.messages.parse()` + `output_config.format: zodOutputFormat(...)`。
 *     非推奨の `output_format` は使わない。
 *   - `parsed_output` はスキーマに合わない応答が返ったとき null になる。
 *     null を握りつぶすと「分類できなかったメール」が静かに消えるので、
 *     必ずガードして保留（unclassified）に落とす。
 *   - エラーは具体的なクラスから順に判定する。メッセージ文字列でのマッチはしない
 *     （SDKの文言が変われば黙って壊れるため）。
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildClassificationPrompt,
  ClassificationSchema,
  CLASSIFIER_SYSTEM_PROMPT,
} from "../core/classify.js";
import type { Classification, Classifier, EmailMessage } from "../core/types.js";
import type { Logger } from "../logger.js";

export interface ClaudeClassifierOptions {
  apiKey: string;
  model: string;
  /**
   * 応答の上限トークン。
   * 分類自体は短いが、Claude Opus 5 は既定で思考が有効で、思考トークンもこの枠を消費する。
   * 枠が小さすぎると出力が途中で切れて parsed_output が null になるため、
   * effort を low に落としたうえで余裕を持たせている。
   */
  maxTokens?: number;
  logger: Logger;
}

export class ClaudeClassifier implements Classifier {
  readonly name = "claude";

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly logger: Logger;

  constructor(options: ClaudeClassifierOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 2_048;
    this.logger = options.logger;
  }

  async classify(message: EmailMessage): Promise<Classification> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: CLASSIFIER_SYSTEM_PROMPT,
      output_config: {
        // 分類は難しい推論ではないので effort は low で足りる。費用と待ち時間を抑える
        effort: "low",
        format: zodOutputFormat(ClassificationSchema),
      },
      messages: [{ role: "user", content: buildClassificationPrompt(message) }],
    });

    this.logger.debug("claude.usage", {
      messageId: message.id,
      model: response.model,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    // 安全側で応答が拒否された場合。分類対象のメール本文に何かあった可能性が高い
    if (response.stop_reason === "refusal") {
      this.logger.warn("claude.refusal", {
        messageId: message.id,
        category: response.stop_details?.category,
      });
      return heldForReview(message, "モデルが応答を拒否したため保留にしました");
    }

    // スキーマ通りに解析できなかった場合。ここを握りつぶすとメールが消える
    if (!response.parsed_output) {
      this.logger.warn("claude.parse_failed", {
        messageId: message.id,
        stopReason: response.stop_reason,
        note: "構造化出力の解析に失敗しました。max_tokens 不足の可能性があります",
      });
      return heldForReview(message, "分類結果を構造化出力として解析できなかったため保留にしました");
    }

    return response.parsed_output;
  }
}

/** 分類できなかったときに返す保留の結果。 */
function heldForReview(message: EmailMessage, reason: string): Classification {
  return {
    category: "unclassified",
    confidence: 0,
    summary: `${message.subject}（要約を生成できませんでした）`,
    reason,
    replyDraft: "",
  };
}

/**
 * 再試行してよいエラーかを判定する。
 *
 * 再試行する: レート制限(429) / サーバ側エラー(5xx) / 接続エラー
 * 再試行しない: 400系（リクエスト不正・APIキー誤り・権限不足）。何度投げても同じ結果になる
 */
export function isRetryableApiError(error: unknown): boolean {
  // 具体的なクラスから順に判定する
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.BadRequestError) return false;
  if (error instanceof Anthropic.AuthenticationError) return false;
  if (error instanceof Anthropic.PermissionDeniedError) return false;
  if (error instanceof Anthropic.NotFoundError) return false;

  if (error instanceof Anthropic.APIError) {
    // 上記以外は HTTP ステータスで判断する。5xx はサーバ側の問題なので待てば直る
    return typeof error.status === "number" && error.status >= 500;
  }

  // SDK 由来でないエラー（自前のバグなど）は再試行しない
  return false;
}
