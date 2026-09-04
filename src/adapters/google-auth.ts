/**
 * Google APIの認証クライアントを組み立てる。
 *
 * 2方式ある。使う側（Gmail / Sheets）はどちらかを意識しない。
 *
 *   1. サービスアカウント + ドメイン全体の委任
 *      Google Workspace 向け。管理コンソールでの委任設定が必要で、
 *      その代わり無人で動き、トークンの失効を考えなくてよい。
 *
 *   2. OAuth（インストール済みアプリ + リフレッシュトークン）
 *      個人の @gmail.com 向け。**ドメイン全体の委任は管理コンソールでしか設定できず、
 *      個人アカウントには委任先ドメインが存在しないため、1の方式は使えない。**
 *      最初の1回だけブラウザで許可し、以降はリフレッシュトークンで動く。
 *
 * どちらを使うかは環境変数から自動で決まる（config.ts を参照）。
 */

import { google, type Auth } from "googleapis";

/**
 * 要求するスコープ。
 * gmail.send を**入れていないのは意図的**で、下書きの作成までしかできない。
 * 万一の不具合でも顧客にメールが送信されることが技術的に起こりえない状態を保つ。
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

/** サービスアカウント方式の設定 */
export interface ServiceAccountAuthConfig {
  mode: "service_account";
  credentials: { client_email: string; private_key: string };
  /** 委任先のメールアドレス。これを指定しないとサービスアカウント自身の空のメールボックスを見にいく */
  subject: string;
}

/** OAuth方式の設定 */
export interface OAuthAuthConfig {
  mode: "oauth";
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GoogleAuthConfig = ServiceAccountAuthConfig | OAuthAuthConfig;

export type GoogleAuthClient = Auth.JWT | Auth.OAuth2Client;

/** 設定に応じた認証クライアントを返す。 */
export function createGoogleAuth(config: GoogleAuthConfig): GoogleAuthClient {
  if (config.mode === "service_account") {
    return new google.auth.JWT({
      email: config.credentials.client_email,
      key: config.credentials.private_key,
      scopes: [...GOOGLE_SCOPES],
      subject: config.subject,
    });
  }

  const client = new google.auth.OAuth2(config.clientId, config.clientSecret);
  // アクセストークンは有効期限が短いので保存しない。
  // リフレッシュトークンだけを渡し、都度ライブラリに更新させる
  client.setCredentials({ refresh_token: config.refreshToken });
  return client;
}

/**
 * Gmail API に渡すユーザー指定。
 * どちらの方式でも "me"（＝認証したアカウント自身）でよい。
 * サービスアカウント方式では JWT の subject が、OAuth方式では許可したアカウントが "me" になる。
 */
export const GMAIL_USER_ID = "me";
