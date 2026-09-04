/**
 * 処理済みメッセージIDの管理（冪等性）。
 *
 * なぜ必要か: 定期実行は必ず二重に走る。
 * GitHub Actions の再実行、cron の重複、途中で落ちた実行の手動リトライ。
 * IDを記録していないと、そのたびに同じメールがシートに追記され、
 * 同じ通知が Slack に飛び、同じ下書きが増える。
 * 「同じ入力で何度走らせても結果が変わらない」ことを担保するのがここ。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProcessedStore } from "./types.js";

/**
 * JSONファイルに処理済みIDを保存する実装。
 *
 * 単一プロセスの定期実行が前提なので排他制御はしていない。
 * 複数ワーカーで走らせる規模になったら DynamoDB なり Redis なりに
 * この ProcessedStore インターフェースの実装を差し替える想定。
 */
export class FileProcessedStore implements ProcessedStore {
  readonly name = "file";

  private ids: Set<string> | null = null;

  constructor(
    private readonly filePath: string,
    /** 保持する上限件数。古いものから捨てる。ファイルの無限成長を防ぐ */
    private readonly maxEntries = 5_000,
  ) {}

  async has(id: string): Promise<boolean> {
    const ids = await this.load();
    return ids.has(id);
  }

  async add(id: string): Promise<void> {
    const ids = await this.load();
    if (ids.has(id)) return;
    ids.add(id);
    await this.persist(ids);
  }

  private async load(): Promise<Set<string>> {
    if (this.ids) return this.ids;

    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      this.ids = new Set(
        Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
      );
    } catch (error) {
      // 初回実行ではファイルが無いのが正常。それ以外の読み取り失敗は握りつぶさない
      if (isNotFound(error)) {
        this.ids = new Set();
      } else {
        throw error;
      }
    }
    return this.ids;
  }

  private async persist(ids: Set<string>): Promise<void> {
    // Set は挿入順を保つので、先頭（＝古いもの）から切り捨てる
    const entries = [...ids];
    const trimmed =
      entries.length > this.maxEntries ? entries.slice(entries.length - this.maxEntries) : entries;

    if (trimmed.length !== entries.length) {
      this.ids = new Set(trimmed);
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(trimmed, null, 2), "utf-8");
  }
}

/** メモリ上だけの実装。デモとテストで使う。プロセスが終われば消える。 */
export class MemoryProcessedStore implements ProcessedStore {
  readonly name = "memory";

  private readonly ids = new Set<string>();

  constructor(initial: readonly string[] = []) {
    for (const id of initial) this.ids.add(id);
  }

  async has(id: string): Promise<boolean> {
    return this.ids.has(id);
  }

  async add(id: string): Promise<void> {
    this.ids.add(id);
  }

  /** テストから中身を確認するためのヘルパー */
  snapshot(): string[] {
    return [...this.ids];
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
