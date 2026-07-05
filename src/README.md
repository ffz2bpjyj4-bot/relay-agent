# RELAY — 依頼受付・整理・受渡エージェント

依頼を構造化（Stage 1）し、外部憲法ファイルを注入して後続 AI モデルへ受け渡す（Stage 2）GAS。低評価ログから規約追補を提案する感化ループ付き。

## 構成

| ファイル | 役割 | 置き場所 |
|---|---|---|
| Code.gs | 本体 | GAS プロジェクト |
| AGENTS.md | 作業規約（既存のものをそのまま使用） | Google Drive |
| PERSONA.md | 応答特性規約 | Google Drive |
| STYLE_DELTA.md | 承認済み追補（最初は空ファイルで可） | Google Drive |
| ログ用スプレッドシート | 実行記録・評価 | Google Drive |

## セットアップ（依存順）

1. Drive に AGENTS.md / PERSONA.md / 空の STYLE_DELTA.md をアップロードし、各ファイル ID を控える（URL の `/d/` と `/edit` の間）。
2. ログ用スプレッドシートを新規作成し ID を控える。シートは初回実行時に自動作成される。
3. GAS プロジェクトを作成し Code.gs を貼り付ける。既存の gas-clasp-template を使う場合は clasp のバージョン固定（3.x = `tokens`）を維持すること。
4. プロジェクトの設定 → スクリプト プロパティに以下を登録する。**API キーをコード内に書かないこと。**

   | プロパティ | 値 |
   |---|---|
   | AGENTS_MD_FILE_ID | 手順1の ID |
   | PERSONA_MD_FILE_ID | 手順1の ID |
   | STYLE_DELTA_FILE_ID | 手順1の ID（任意） |
   | LOG_SPREADSHEET_ID | 手順2の ID |
   | DEFAULT_PROVIDER | gemini / anthropic / openai |
   | GEMINI_API_KEY 等 | 使うプロバイダのキー |

5. エディタから `testPipeline()` を実行。初回は Drive / Spreadsheet / 外部接続の権限承認が出る。ログに `OK` が3行並べば疎通完了。`NG` の行が示す段階（憲法読込 / 正規化 / 受渡）を切り分けること。モデル名起因の 400/404 はプロパティ `*_MODEL` を最新名に更新する。
6. （任意）Web エンドポイントが必要なら「デプロイ → ウェブアプリ」。**警告: 公開前に必ず RELAY_WEBHOOK_TOKEN を設定すること。** 未設定のまま「全員」公開すると誰でも API キー消費を誘発できる。
7. （任意）感化ループを回すなら、トリガーで `proposeStyleDelta` を週次実行に設定する。

## 運用フロー

1. `handoff('依頼文')` を実行。成果物を左右する曖昧さがあれば `needs_clarification` で停止し、曖昧点・選択肢・推奨が返る。
2. 解釈を確定したら依頼文を修正して再実行するか、推奨解釈で `handoff(text, {skipClarification: true})`。
3. 結果はログシートに記録される。期待と違った応答には `recordFeedback(行番号, 評価1-5, '何が違ったか')`。
4. 週次の `proposeStyleDelta()` が低評価事例から追補案を Drive に生成する。**憲法本体は自動では書き換わらない。** 採用する規約だけを STYLE_DELTA.md に手動転記し、`clearConstitutionCache()` を実行して反映する。

## 設計上の割り切り

- 憲法の自動書換をしないのは意図的（承認なき自己改変の禁止）。感化は「提案 → 人間の採否 → 追補」の一方向。
- 転写できるのは規約・文体・検証習慣であり、判断品質そのものはモデル依存で残る。追補の蓄積は文体の再現度を上げるが、モデル間の能力差は埋めない（確信度: 高）。
