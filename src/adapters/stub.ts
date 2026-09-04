/**
 * ルールベースの分類器。デモとテスト用。
 *
 * なぜ用意するか: APIキーもネットワークも無い状態で
 * `npm run demo` を動かせるようにするため。
 * 受け取った人が最初にやるのは「とりあえず動かしてみる」なので、
 * そこにAPIキーの発行という壁を置かない。
 *
 * 精度は求めていない。キーワードで素朴に判定し、
 * 該当が無ければ低い確信度を返して保留に落とす。
 * その「保留に落ちる」動きこそデモで見せたい部分なので、
 * fixtures には意図的に判定できないメールを混ぜてある。
 */

import type { Category, Classification, Classifier, EmailMessage } from "../core/types.js";

interface Rule {
  category: Category;
  /** 件名・本文に対して評価するキーワード */
  keywords: string[];
  /** 差出人アドレスに対して評価するキーワード（任意） */
  fromKeywords?: string[];
  confidence: number;
  replyDraft: string;
}

/**
 * 上から順に評価し、最初に一致したものを採用する。
 * 自動通知と営業を先に置いているのは、それらの文面が
 * 問い合わせのキーワードを含みがちで誤判定を招くため。
 */
const RULES: Rule[] = [
  {
    category: "notification",
    keywords: ["自動送信", "自動配信", "システム通知", "ご請求", "決済完了", "アラート", "noreply"],
    fromKeywords: ["noreply", "no-reply", "notification", "alert"],
    confidence: 0.95,
    replyDraft: "",
  },
  {
    category: "vendor_sales",
    keywords: ["ご提案", "無料トライアル", "導入事例のご案内", "セミナーのご案内", "営業", "キャンペーン"],
    confidence: 0.82,
    replyDraft: "",
  },
  {
    category: "quote_request",
    keywords: ["見積", "お見積り", "御見積", "概算費用", "料金表"],
    confidence: 0.9,
    replyDraft:
      "お問い合わせありがとうございます。\nお見積りのご依頼を承りました。\n内容を確認のうえ、2営業日以内に概算をお送りいたします。\n不足している情報がありましたら追ってご連絡いたします。",
  },
  {
    category: "appointment",
    keywords: ["日程", "打ち合わせ", "ミーティング", "候補日", "ご都合", "面談"],
    confidence: 0.88,
    replyDraft:
      "ご連絡ありがとうございます。\n日程の件、承知いたしました。\nいただいた候補日で調整いたしますので、確定次第あらためてご連絡いたします。",
  },
  {
    category: "existing_support",
    keywords: ["不具合", "エラー", "動かない", "障害", "ログインできない", "サポート", "復旧"],
    confidence: 0.87,
    replyDraft:
      "ご連絡ありがとうございます。ご不便をおかけしております。\n事象を確認いたしますので、発生日時と操作手順をお知らせいただけますでしょうか。\n確認でき次第、対応状況をご報告いたします。",
  },
  {
    category: "inquiry",
    keywords: ["お問い合わせ", "問い合わせ", "教えてください", "検討している", "資料", "ご相談"],
    confidence: 0.8,
    replyDraft:
      "お問い合わせいただきありがとうございます。\n内容を確認のうえ、担当より2営業日以内にご連絡いたします。\n今しばらくお待ちください。",
  },
  {
    // 弱いシグナル。それらしいが決め手に欠ける文面をここで拾い、
    // 閾値(既定0.6)未満の確信度を返して保留に倒させる。
    // Claude 版でも「確信が持てないときは低い confidence を返す」よう指示しており、
    // その挙動をデモでも再現するために置いている。
    category: "inquiry",
    keywords: ["先日の件", "その後いかが", "ご確認いただけ", "お手すき"],
    confidence: 0.45,
    replyDraft: "ご連絡ありがとうございます。内容を確認のうえ、あらためてご連絡いたします。",
  },
];

export class StubClassifier implements Classifier {
  readonly name = "stub";

  async classify(message: EmailMessage): Promise<Classification> {
    const haystack = `${message.subject}\n${message.body}`;
    const from = message.from.toLowerCase();

    for (const rule of RULES) {
      const hitKeyword = rule.keywords.find((keyword) => haystack.includes(keyword));
      const hitFrom = rule.fromKeywords?.find((keyword) => from.includes(keyword));

      if (hitKeyword || hitFrom) {
        return {
          category: rule.category,
          confidence: rule.confidence,
          summary: buildSummary(message),
          reason: `ルールベース判定: 「${hitKeyword ?? hitFrom}」を検出`,
          replyDraft: rule.replyDraft,
        };
      }
    }

    // どのルールにも当たらなかった。
    // ここで無理にカテゴリを当てにいかず、保留として人間に渡す
    return {
      category: "unclassified",
      confidence: 0.2,
      summary: buildSummary(message),
      reason: "ルールベース判定: 一致するキーワードが無く、判断できませんでした",
      replyDraft: "",
    };
  }
}

/** 本文の先頭を要約の代わりにする。Claude 版では実際に要約が生成される。 */
function buildSummary(message: EmailMessage, maxChars = 60): string {
  const firstLine =
    message.body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  const head = firstLine.length > maxChars ? firstLine.slice(0, maxChars) + "…" : firstLine;
  return `${message.subject} / ${head}`;
}
