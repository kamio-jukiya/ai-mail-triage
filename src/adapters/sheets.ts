/**
 * Google スプレッドシートへの追記。
 *
 * なぜスプレッドシートか: 記録先が業務側で開けることが重要だから。
 * DBに入れると結局こちらに問い合わせが来る。シートなら現場が自分で
 * フィルタし、並べ替え、目視確認の欄を足せる。
 */

import { google, type sheets_v4 } from "googleapis";
import type { GoogleAuthClient } from "./google-auth.js";
import { CATEGORY_LABELS, type RecordSink, type TriageResult } from "../core/types.js";
import type { Logger } from "../logger.js";

export interface SheetsOptions {
  spreadsheetId: string;
  /** 追記先の範囲。例: triage!A:H */
  range: string;
  logger: Logger;
}

/** シートの列順。ここを変えたら docs/operations.md の説明も直すこと。 */
export const SHEET_HEADERS = [
  "処理日時",
  "受信日時",
  "メッセージID",
  "差出人",
  "件名",
  "分類",
  "確信度",
  "要約",
] as const;

export class SheetsRecordSink implements RecordSink {
  readonly name = "sheets";

  private readonly sheets: sheets_v4.Sheets;

  constructor(
    auth: GoogleAuthClient,
    private readonly options: SheetsOptions,
  ) {
    this.sheets = google.sheets({ version: "v4", auth });
  }

  async record(result: TriageResult): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.options.spreadsheetId,
      range: this.options.range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [toRow(result)] },
    });

    // シートIDと件名はログに出さない。記録の事実だけ残す
    this.options.logger.info("sheets.appended", { messageId: result.message.id });
  }
}

/** TriageResult を1行に変換する。SHEET_HEADERS と順番を必ず揃える。 */
export function toRow(result: TriageResult): string[] {
  const label = CATEGORY_LABELS[result.classification.category];
  const category = result.heldForReview
    ? `${label}（元判定: ${result.originalCategory ?? "不明"}）`
    : label;

  return [
    new Date().toISOString(),
    result.message.receivedAt,
    result.message.id,
    result.message.from,
    result.message.subject,
    category,
    result.classification.confidence.toFixed(2),
    result.classification.summary,
  ];
}
