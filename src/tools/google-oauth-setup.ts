/**
 * OAuth のリフレッシュトークンを取得する補助スクリプト。
 *
 *   npm run auth:google
 *
 * 個人の @gmail.com で動かす場合、最初に1回だけこれを実行する。
 * ブラウザで許可した結果をローカルの一時サーバで受け取り、
 * リフレッシュトークンを画面に表示する。取得後はこのスクリプトを使わない。
 *
 * Googleがすでに廃止した「コードを手でコピーする方式(OOB)」は使えないため、
 * localhost で受け取る形にしている（インストール済みアプリの標準的な手順）。
 */

import { createServer } from "node:http";
import { google } from "googleapis";
import { GOOGLE_SCOPES } from "../adapters/google-auth.js";
import { loadDotEnv } from "../config.js";

/** 受け取り用のポート。Google Cloud 側のリダイレクトURIと一致させる必要がある */
const PORT = 53_682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main(): Promise<void> {
  loadDotEnv();

  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];

  if (!clientId || !clientSecret) {
    process.stderr.write(
      [
        "",
        "GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET を先に設定してください。",
        ".env に書くか、環境変数として渡します。",
        "取得手順は docs/operations.md の「3-2B. 個人のGmailを使う場合」を参照してください。",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const url = client.generateAuthUrl({
    // access_type: offline と prompt: consent の両方が要る。
    // これを外すと2回目以降リフレッシュトークンが返ってこない
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
  });

  process.stderr.write(
    [
      "",
      "次のURLをブラウザで開き、対象のGoogleアカウントで許可してください。",
      "",
      url,
      "",
      `許可すると ${REDIRECT_URI} に戻ってきます。このまま待機します...`,
      "",
    ].join("\n"),
  );

  const code = await waitForCode();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    process.stderr.write(
      [
        "",
        "リフレッシュトークンが返ってきませんでした。",
        "同じアカウントで過去に許可済みの場合に起きます。",
        "https://myaccount.google.com/permissions でこのアプリのアクセスを解除してから、もう一度実行してください。",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    [
      "",
      "取得できました。次の行を .env に追記するか、GitHub の Secrets に登録してください。",
      "",
      `GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`,
      "",
      "注意: OAuth同意画面が「テスト」状態のままだと、このトークンは7日で失効します。",
      "　　　公開（本番）に切り替えてから取得し直してください。",
      "",
    ].join("\n"),
  );
}

/** ローカルサーバを立てて、リダイレクトで返ってくる認可コードを1回だけ受け取る。 */
function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<p>受け取りました。このタブを閉じて、ターミナルに戻ってください。</p>"
          : "<p>失敗しました。ターミナルの表示を確認してください。</p>",
      );

      server.close();
      if (code) resolve(code);
      else reject(new Error(`認可に失敗しました: ${error ?? "codeが返ってきませんでした"}`));
    });

    server.on("error", reject);
    server.listen(PORT);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`\n失敗しました: ${String(error)}\n\n`);
  process.exitCode = 1;
});
