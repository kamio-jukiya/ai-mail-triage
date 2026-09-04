/**
 * Gmail の読み取りと下書き作成。
 *
 * 認証はサービスアカウント + ドメイン全体の委任（Domain-Wide Delegation）。
 * ブラウザでのOAuth同意が要らないので、GitHub Actions のような
 * 無人環境で動かせる。設定手順は docs/operations.md に書いてある。
 */

import { google, type gmail_v1 } from "googleapis";
import type { DraftWriter, EmailMessage, MailSource, TriageResult } from "../core/types.js";
import type { Logger } from "../logger.js";

export interface GmailOptions {
  /** サービスアカウントのJSONキー（パース済み） */
  credentials: { client_email: string; private_key: string };
  /** 代理でアクセスする対象のメールアドレス */
  userEmail: string;
  logger: Logger;
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

function createGmailClient(options: GmailOptions): gmail_v1.Gmail {
  const auth = new google.auth.JWT({
    email: options.credentials.client_email,
    key: options.credentials.private_key,
    scopes: SCOPES,
    // 委任先。これを指定しないとサービスアカウント自身のメールボックスを見にいく
    subject: options.userEmail,
  });

  return google.gmail({ version: "v1", auth });
}

/** Gmail からメールを取得する。 */
export class GmailMailSource implements MailSource {
  readonly name = "gmail";

  private readonly gmail: gmail_v1.Gmail;
  private readonly logger: Logger;

  constructor(
    options: GmailOptions,
    /** 取得条件。Gmailの検索構文をそのまま使う（例: is:unread -category:promotions） */
    private readonly query: string,
  ) {
    this.gmail = createGmailClient(options);
    this.logger = options.logger;
  }

  async fetch(limit: number): Promise<EmailMessage[]> {
    const list = await this.gmail.users.messages.list({
      userId: "me",
      q: this.query,
      maxResults: limit,
    });

    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    this.logger.debug("gmail.listed", { query: this.query, count: ids.length });

    const messages: EmailMessage[] = [];
    for (const id of ids) {
      const detail = await this.gmail.users.messages.get({
        userId: "me",
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
  private readonly logger: Logger;

  constructor(options: GmailOptions) {
    this.gmail = createGmailClient(options);
    this.logger = options.logger;
  }

  async createDraft(result: TriageResult): Promise<void> {
    const raw = buildRawMessage(result);

    const response = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(result.message.threadId ? { threadId: result.message.threadId } : {}),
        },
      },
    });

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
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}
