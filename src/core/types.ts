/**
 * ドメイン型の定義。
 *
 * このファイルには「振り分けの世界に何が存在するか」だけを書く。
 * 外部サービス（Gmail / Sheets / Slack / Claude）の都合はここに持ち込まず、
 * すべて adapters 側で吸収する。
 */

/** 分類カテゴリ。`unclassified` は判定できなかったものを受け止める保留枠。 */
export const CATEGORIES = [
  "inquiry",
  "quote_request",
  "existing_support",
  "appointment",
  "vendor_sales",
  "notification",
  "unclassified",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** 画面・シート・Slack に出す日本語ラベル。key をそのまま人に見せない。 */
export const CATEGORY_LABELS: Record<Category, string> = {
  inquiry: "新規問い合わせ",
  quote_request: "見積依頼",
  existing_support: "既存顧客サポート",
  appointment: "日程調整",
  vendor_sales: "営業・売り込み",
  notification: "自動通知",
  unclassified: "保留（要目視）",
};

/**
 * 要対応と見なすカテゴリ。
 * 保留（unclassified）を必ず含めるのがこの仕組みの肝で、
 * 「AIが判断できなかったメール」が誰の目にも触れずに消えることを防ぐ。
 */
export const ACTION_REQUIRED_CATEGORIES: readonly Category[] = [
  "inquiry",
  "quote_request",
  "existing_support",
  "appointment",
  "unclassified",
];

/** 受信メール1通。Gmail API のレスポンスをこの形に正規化して扱う。 */
export interface EmailMessage {
  /** メールを一意に識別するID。冪等性の判定キーになるので必ず安定した値を入れる */
  id: string;
  /** スレッドID。返信下書きを同じスレッドにぶら下げるために使う */
  threadId?: string;
  from: string;
  subject: string;
  /** 本文（プレーンテキスト）。長い場合は分類前に切り詰める */
  body: string;
  /** 受信日時（ISO8601） */
  receivedAt: string;
}

/** 分類結果。Classifier が返す唯一の型。 */
export interface Classification {
  category: Category;
  /** 0.0〜1.0。閾値を下回ったら unclassified に倒す */
  confidence: number;
  /** 1〜2文の日本語要約。シートとSlackに出る */
  summary: string;
  /** そう判断した理由。後から精度を検証するために残す */
  reason: string;
  /** 返信の下書き本文。不要な種別（自動通知など）では空文字 */
  replyDraft: string;
}

/** 1通の処理結果。 */
export interface TriageResult {
  message: EmailMessage;
  classification: Classification;
  /** 確信度不足で保留に倒したか。倒した場合は元のカテゴリを originalCategory に残す */
  heldForReview: boolean;
  originalCategory?: Category;
  /** 要対応か（＝通知対象か） */
  actionRequired: boolean;
}

/** 分類器。StubClassifier（デモ用）と ClaudeClassifier（本番）を差し替える。 */
export interface Classifier {
  readonly name: string;
  classify(message: EmailMessage): Promise<Classification>;
}

/** メールの取得元。fixtures からの読み込みと Gmail を差し替える。 */
export interface MailSource {
  readonly name: string;
  fetch(limit: number): Promise<EmailMessage[]>;
}

/** 処理結果の記録先。スプレッドシートや標準出力。 */
export interface RecordSink {
  readonly name: string;
  record(result: TriageResult): Promise<void>;
}

/** 要対応メールの通知先。Slack や標準出力。 */
export interface Notifier {
  readonly name: string;
  notify(result: TriageResult): Promise<void>;
}

/** 返信下書きの作成先。Gmail の下書き。 */
export interface DraftWriter {
  readonly name: string;
  createDraft(result: TriageResult): Promise<void>;
}

/** 処理済みメッセージIDの保管庫。再実行時の二重処理を防ぐ。 */
export interface ProcessedStore {
  readonly name: string;
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
}
