/**
 * 分類まわりの共通ロジック。
 *
 * 分類器そのもの（Claude / ルールベース）は adapters にあり、
 * ここには「どの分類器を使っても必ず通す」処理だけを置く。
 *   - 出力スキーマの定義（Claude の構造化出力とも共有する）
 *   - 確信度の閾値判定 = 保留への切り替え
 *   - 要対応かどうかの判定
 */

import { z } from "zod";
import {
  ACTION_REQUIRED_CATEGORIES,
  CATEGORIES,
  type Category,
  type Classification,
  type EmailMessage,
  type TriageResult,
} from "./types.js";

/**
 * 分類結果のスキーマ。
 * Claude の構造化出力（zodOutputFormat）にそのまま渡すので、
 * description は「モデルへの指示」として機能する。日本語で書いてよい。
 */
export const ClassificationSchema = z.object({
  category: z
    .enum(CATEGORIES)
    .describe("メールの分類。判断できない場合は unclassified を選ぶこと"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("分類の確信度。0.0〜1.0。迷いがあるなら正直に低くつけること"),
  summary: z
    .string()
    .describe("メールの要点を日本語1〜2文で。担当者はこれだけ見て優先度を決める"),
  reason: z.string().describe("そのカテゴリだと判断した根拠を日本語1文で"),
  replyDraft: z
    .string()
    .describe(
      "返信の下書き本文（日本語）。返信が不要な種別（自動通知・営業）の場合は空文字にすること",
    ),
});

export type ClassificationInput = z.infer<typeof ClassificationSchema>;

/** 分類器に渡すシステムプロンプト。ClaudeClassifier から使う。 */
export const CLASSIFIER_SYSTEM_PROMPT = [
  "あなたは日本の中小企業の問い合わせ窓口を担当するアシスタントです。",
  "受信したメールを1通ずつ読み、決められたカテゴリに分類し、要約と返信下書きを作成します。",
  "",
  "分類カテゴリ:",
  "- inquiry: 新規の顧客からの問い合わせ",
  "- quote_request: 見積の依頼",
  "- existing_support: 既存顧客からの不具合報告・サポート依頼",
  "- appointment: 打ち合わせ日程の調整",
  "- vendor_sales: 業者からの営業・売り込み",
  "- notification: システムからの自動通知（配信・請求・監視など）",
  "- unclassified: 上記のどれとも判断できない、または情報が足りない",
  "",
  "重要な指示:",
  "- 迷った場合は無理にカテゴリを選ばず unclassified にし、confidence を低くつけてください。",
  "  誤った分類で処理が進むより、人間が目視する方が安全です。",
  "- confidence は「自分がどれくらい確信しているか」を正直に表してください。",
  "- 返信下書きは日本語のビジネスメールとして、宛名と署名を除いた本文だけを書いてください。",
  "- vendor_sales と notification は返信不要なので replyDraft は空文字にしてください。",
].join("\n");

/** メール1通を分類プロンプト用のテキストに整形する。本文は長すぎると費用が嵩むので切り詰める。 */
export function buildClassificationPrompt(
  message: EmailMessage,
  maxBodyChars = 4_000,
): string {
  const body =
    message.body.length > maxBodyChars
      ? message.body.slice(0, maxBodyChars) + "\n（以下省略）"
      : message.body;

  return [
    "以下のメールを分類してください。",
    "",
    `差出人: ${message.from}`,
    `件名: ${message.subject}`,
    `受信日時: ${message.receivedAt}`,
    "本文:",
    body,
  ].join("\n");
}

/**
 * 確信度が閾値未満なら保留（unclassified）に倒す。
 *
 * ここがこの仕組みの中心。分類器が「たぶん見積依頼、確信度0.4」と言ってきたとき、
 * それを見積依頼として処理してしまうと、間違いは誰にも気づかれないまま流れる。
 * 閾値未満は機械的に保留に落とし、通知して人間に渡す。
 */
export function applyConfidenceThreshold(
  classification: Classification,
  threshold: number,
): { classification: Classification; heldForReview: boolean; originalCategory?: Category } {
  const belowThreshold = classification.confidence < threshold;

  if (!belowThreshold || classification.category === "unclassified") {
    return { classification, heldForReview: false };
  }

  return {
    heldForReview: true,
    originalCategory: classification.category,
    classification: {
      ...classification,
      category: "unclassified",
      reason:
        `確信度 ${classification.confidence.toFixed(2)} が閾値 ${threshold} 未満のため保留。` +
        `（分類器の判断: ${classification.category} / ${classification.reason}）`,
      // 確信が持てない分類に基づく下書きは送信事故のもとなので捨てる
      replyDraft: "",
    },
  };
}

/** 要対応（＝通知対象）かどうか。 */
export function isActionRequired(category: Category): boolean {
  return ACTION_REQUIRED_CATEGORIES.includes(category);
}

/** 分類結果から TriageResult を組み立てる。 */
export function buildTriageResult(
  message: EmailMessage,
  raw: Classification,
  threshold: number,
): TriageResult {
  const { classification, heldForReview, originalCategory } =
    applyConfidenceThreshold(raw, threshold);

  return {
    message,
    classification,
    heldForReview,
    ...(originalCategory ? { originalCategory } : {}),
    actionRequired: isActionRequired(classification.category),
  };
}
