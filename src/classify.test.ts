/**
 * 分類まわりの検証。
 * 中心は「確信度が足りないものが必ず保留に落ちる」こと。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConfidenceThreshold, buildTriageResult, isActionRequired } from "./core/classify.js";
import type { Classification, EmailMessage } from "./core/types.js";
import { StubClassifier } from "./adapters/stub.js";

const baseClassification: Classification = {
  category: "quote_request",
  confidence: 0.9,
  summary: "見積依頼",
  reason: "見積という語を検出",
  replyDraft: "承知しました。",
};

const message: EmailMessage = {
  id: "test-1",
  from: "a@example.com",
  subject: "見積のお願い",
  body: "お見積りをお願いします。",
  receivedAt: "2026-09-03T00:00:00Z",
};

describe("applyConfidenceThreshold", () => {
  it("閾値以上ならそのまま通す", () => {
    const result = applyConfidenceThreshold(baseClassification, 0.6);
    assert.equal(result.heldForReview, false);
    assert.equal(result.classification.category, "quote_request");
  });

  it("閾値未満なら保留に倒し、元の判定を残す", () => {
    const result = applyConfidenceThreshold({ ...baseClassification, confidence: 0.4 }, 0.6);
    assert.equal(result.heldForReview, true);
    assert.equal(result.classification.category, "unclassified");
    assert.equal(result.originalCategory, "quote_request");
    assert.match(result.classification.reason, /閾値/);
  });

  it("保留に倒したら返信下書きを捨てる", () => {
    const result = applyConfidenceThreshold({ ...baseClassification, confidence: 0.1 }, 0.6);
    assert.equal(
      result.classification.replyDraft,
      "",
      "確信の持てない分類に基づく下書きを残すと送信事故になる",
    );
  });

  it("ちょうど閾値の値は通す", () => {
    const result = applyConfidenceThreshold({ ...baseClassification, confidence: 0.6 }, 0.6);
    assert.equal(result.heldForReview, false);
  });

  it("元から unclassified なら heldForReview にはしない", () => {
    const result = applyConfidenceThreshold(
      { ...baseClassification, category: "unclassified", confidence: 0.2 },
      0.6,
    );
    assert.equal(result.heldForReview, false);
    assert.equal(result.classification.category, "unclassified");
  });
});

describe("isActionRequired", () => {
  it("保留は必ず要対応にする", () => {
    assert.equal(isActionRequired("unclassified"), true);
  });

  it("自動通知と営業は要対応にしない", () => {
    assert.equal(isActionRequired("notification"), false);
    assert.equal(isActionRequired("vendor_sales"), false);
  });
});

describe("buildTriageResult", () => {
  it("保留に倒れたものは要対応になる", () => {
    const result = buildTriageResult(message, { ...baseClassification, confidence: 0.3 }, 0.6);
    assert.equal(result.heldForReview, true);
    assert.equal(result.actionRequired, true);
  });
});

describe("StubClassifier", () => {
  const classifier = new StubClassifier();

  const cases: Array<{ subject: string; body: string; from: string; expected: string }> = [
    {
      subject: "【見積依頼】について",
      body: "お見積りをお願いします",
      from: "a@example.com",
      expected: "quote_request",
    },
    {
      subject: "ログインできない",
      body: "エラーが出て動かないです",
      from: "b@example.com",
      expected: "existing_support",
    },
    {
      subject: "打ち合わせの件",
      body: "候補日をお知らせします",
      from: "c@example.com",
      expected: "appointment",
    },
    {
      subject: "ご提案",
      body: "無料トライアルのご案内です",
      from: "sales@example.com",
      expected: "vendor_sales",
    },
    {
      subject: "通知",
      body: "※このメールは自動送信です",
      from: "noreply@example.com",
      expected: "notification",
    },
    {
      subject: "お問い合わせ",
      body: "資料をいただけますか",
      from: "d@example.com",
      expected: "inquiry",
    },
  ];

  for (const testCase of cases) {
    it(`「${testCase.subject}」を ${testCase.expected} に分類する`, async () => {
      const result = await classifier.classify({
        id: "x",
        from: testCase.from,
        subject: testCase.subject,
        body: testCase.body,
        receivedAt: "2026-09-03T00:00:00Z",
      });
      assert.equal(result.category, testCase.expected);
    });
  }

  it("判断できないメールは低い確信度の unclassified にする", async () => {
    const result = await classifier.classify({
      id: "y",
      from: "e@example.com",
      subject: "（件名なし）",
      body: "添付をご確認ください。",
      receivedAt: "2026-09-03T00:00:00Z",
    });

    assert.equal(result.category, "unclassified");
    assert.ok(result.confidence < 0.6, "保留は閾値未満の確信度で返すこと");
    assert.equal(result.replyDraft, "");
  });

  it("決め手に欠ける文面には低い確信度をつける（＝保留に倒される）", async () => {
    const result = await classifier.classify({
      id: "z",
      from: "f@example.com",
      subject: "先日の件",
      body: "その後いかがでしょうか。",
      receivedAt: "2026-09-03T00:00:00Z",
    });

    assert.ok(
      result.confidence < 0.6,
      "曖昧な文面にカテゴリを当てにいくなら、確信度は閾値未満にすること",
    );
  });
});
