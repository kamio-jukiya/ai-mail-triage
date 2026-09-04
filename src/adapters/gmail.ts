/**
 * Gmail の読み取りと下書き作成。
 *
 * 認証方式（サービスアカウント / OAuth）は google-auth.ts が吸収するので、
 * ここでは認証済みのクライアントを受け取るだけにしてある。
 * 個人の @gmail.com は OAuth 方式でしか動かない（理由は google-auth.ts のコメント）。
 */

import { google, type gmail_v1 } from "googleapis";
import { GMAIL_USER_ID, type GoogleAuthClient } from "./google-auth.js";
import type { DraftWriter, EmailMessage, MailSource, TriageResult } from "../core/types.js";
import type { Logger } from "../logger.js";

/** Gmail からメールを取得する。 */
export class GmailMailSource implements MailSource {
  readonly name = "gmail";

  private readonly gmail: gmail_v1.Gmail;

  constructor(
    auth: GoogleAuthClient,
    /** 取得条件。Gmailの検索構文をそのまま使う（例: is:unread -category:promotions） */
    private readonly query: string,
    private readonly logger: Logger,
  ) {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  async fetch(limit: number): Promise<EmailMessage[]> {
    const list = await this.gmail.users.messages.list({
      userId: GMAIL_USER_ID,
      q: this.query,
      maxResults: limit,
    });

    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    // 検索条件はメール本文と違い自分で書いたものなのでログに出してよい
    this.logger.debug("gmail.listed", { query: this.query, count: ids.length });

    const messages: EmailMessage[] = [];
    for (const id of ids) {
      const detail = await this.gmail.users.messages.get({
        userId: GMAIL_USER_ID,
        id,
        format: "full",
      });
      messages.push(toEmailMessage(id, detail.data));
    }

    return messages;
  }
}

/** 返信の下書きを Gmail に作成する。送信はしない。 */
export class GmailDraftWriter implements DraftWriter {
  readonly name = "gmail";

  private readonly gmail: gmail_v1.Gmail;

  constructor(
    auth: GoogleAuthClient,
    private readonly logger: Logger,
  ) {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  async createDraft(result: TriageResult): Promise<void> {
    const raw = buildRawMessage(result);

    const response = await this.gmail.users.drafts.create({
      userId: GMAIL_USER_ID,
      requestBody: {
        message: {
          raw,
          ...(result.message.threadId ? { threadId: result.message.threadId } : {}),
        },
      },
    });

    // 宛先は個人情報なのでログに出さない（公開リポジトリの実行ログは誰でも読める）
    this.logger.info("gmail.draft_created", {
      messageId: result.message.id,
      draftId: response.data.id,
    });
  }
}

/** Gmail API のレスポンスを EmailMessage に正規化する。 */
export function toEmailMessage(id: string, data: gmail_v1.Schema$Message): EmailMessage {
  const headers = data.payload?.headers ?? [];
  const header = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const receivedAt = data.internalDate
    ? new Date(Number(data.internalDate)).toISOString()
    : new Date().toISOString();

  return {
    id,
    threadId: data.threadId ?? undefined,
    from: header("From"),
    subject: header("Subject"),
    body: extractPlainTextBody(data.payload) || (data.snippet ?? ""),
    receivedAt,
  };
}

/**
 * 本文からプレーンテキストを取り出す。
 * multipart/alternative の入れ子があるので再帰で探し、
 * 見つからなければ呼び出し側で snippet にフォールバックする。
 */
function extractPlainTextBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const found = extractPlainTextBody(child);
    if (found) return found;
  }

  return "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/** RFC822 形式の返信メールを組み立て、base64url にする。 */
export function buildRawMessage(result: TriageResult): string {
  const subject = result.message.subject.startsWith("Re:")
    ? result.message.subject
    : `Re: ${result.message.subject}`;

  const lines = [
    `To: ${result.message.from}`,
    // 件名の非ASCIIはそのままだと文字化けするので MIME encoded-word にする
    `Subject: ${encodeHeader(subject)}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(result.classification.replyDraft, "utf-8").toString("base64"),
  ];

  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

function encodeHeader(value: string): string {
  // ASCIIのみならそのまま。日本語が含まれる場合だけエンコードする
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}
