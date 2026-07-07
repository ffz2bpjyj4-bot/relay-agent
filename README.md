# RELAY — 依頼受付・整理・受渡・検収エージェント

依頼を構造化（Stage 1）し、外部憲法ファイルを注入して後続 AI モデルへ受け渡し（Stage 2）、納品物を検収する（Stage 3）GAS。低評価ログから規約追補を提案する感化ループ付き。

## 段階（Stage）

| Stage | 関数 | 入力 → 出力 | 頭脳ファイル |
|---|---|---|---|
| 1 整理 | `uiOrganize` | 依頼文 → 受渡パケット（構造化JSON＋検収条件） | ORGANIZER.md |
| 2 実行 | `uiChat` / `handoff` | パケット → 納品物（憲法注入で実行） | AGENTS.md + PERSONA.md（+ STYLE_DELTA.md） |
| 3 検収 | `uiReview` | パケット + 納品物 → 検収JSON（accept/conditional/reject） | REVIEWER.md |

Web UI ではヘッダのドロップダウンで Stage を選んでから送信する。Stage 3 のみパケットと納品物の2欄になる。Stage 1 の「実行(→Stage 2)」、Stage 2 の「検収(→Stage 3)」ボタンで段階を繋げられる。

## 構成

| ファイル | 役割 | 置き場所 |
|---|---|---|
| Code.gs | 本体 | GAS プロジェクト |
| Index.html | Web UI | GAS プロジェクト |
| AGENTS.md | 作業規約 | Google Drive |
| PERSONA.md | 応答特性規約 | Google Drive |
| ORGANIZER.md | 依頼構造化規約（Stage 1 の頭脳。未設定なら内蔵版） | Google Drive |
| REVIEWER.md | 納品検収規約（Stage 3 の頭脳。未設定なら内蔵版） | Google Drive |
| STYLE_DELTA.md | 承認済み追補（感化ループの転記先。最初は空ファイルで可） | Google Drive |
| ログ用スプレッドシート | 実行記録・評価 | Google Drive |

**内蔵版の同期義務:** ORGANIZER.md / REVIEWER.md は Code.gs 内に同一内容のフォールバック（`DEFAULT_ORGANIZER_PROMPT_` / `DEFAULT_REVIEWER_PROMPT_`）を持つ。Drive 側 .md を改訂したら内蔵版も更新すること。未設定環境での挙動を一致させるためで、`*_MD_FILE_ID` を設定していれば Drive 版が優先される。

## セットアップ（依存順）

1. Drive に AGENTS.md / PERSONA.md / ORGANIZER.md / REVIEWER.md / 空の STYLE_DELTA.md をアップロードし、各ファイル ID を控える（URL の `/d/` と `/edit` の間）。ORGANIZER.md / REVIEWER.md は省略可（内蔵版で動く）。
2. ログ用スプレッドシートを新規作成し ID を控える。シートは初回実行時に自動作成される。
3. GAS プロジェクトを作成し Code.gs と Index.html を貼り付ける。既存の gas-clasp-template を使う場合は clasp のバージョン固定（3.x = `tokens`）を維持すること。
4. プロジェクトの設定 → スクリプト プロパティに以下を登録する。**API キーをコード内に書かないこと。**

   | プロパティ | 値 |
   |---|---|
   | AGENTS_MD_FILE_ID | 手順1の ID（必須） |
   | PERSONA_MD_FILE_ID | 手順1の ID（必須） |
   | ORGANIZER_MD_FILE_ID | 手順1の ID（任意。未設定なら内蔵版） |
   | REVIEWER_MD_FILE_ID | 手順1の ID（任意。未設定なら内蔵版） |
   | STYLE_DELTA_FILE_ID | 手順1の ID（任意） |
   | LOG_SPREADSHEET_ID | 手順2の ID（必須） |
   | DEFAULT_PROVIDER | gemini / anthropic / openai |
   | GEMINI_API_KEY 等 | 使うプロバイダのキー |

5. エディタから `testPipeline()` を実行。初回は Drive / Spreadsheet / 外部接続の権限承認が出る。ログに `OK` が6行（憲法読込 / 構造化規約読込 / 検収規約読込 / 正規化 / 整理 / 検収）並べば疎通完了。`NG` の行が示す段階を切り分けること。モデル名起因の 400/404 はプロパティ `*_MODEL` を最新名に更新する。
6. `inspectConstitutionFiles()` で各 md の実体（名前・MIME・文字数・冒頭）を確認できる。Drive 版と内蔵版のどちらが使われているかの確認に使う。
7. （任意）Web エンドポイントが必要なら「デプロイ → ウェブアプリ」。**警告: 公開前に必ず RELAY_WEBHOOK_TOKEN を設定すること。** 未設定のまま「全員」公開すると誰でも API キー消費を誘発できる。
8. （任意）感化ループを回すなら、トリガーで `proposeStyleDelta` を週次実行に設定する。

## 運用フロー

1. **整理（Stage 1）** `handoff('依頼文', {organizeOnly:true})` または UI の Stage 1。成果物を左右する曖昧さがあれば `needs_clarification` で停止し、曖昧点・選択肢・推奨が返る。パケットには依頼型（task_type）と検収条件（acceptance_criteria）が含まれる。
2. 解釈を確定したら依頼文を修正して再実行するか、推奨解釈で `{skipClarification: true}`。
3. **実行（Stage 2）** パケットを後続モデルに渡す。UI の「実行」ボタン、`handoff('依頼文')`（整理→実行を一括）、または他AIのチャット欄に「憲法込みでコピー」した全文を貼る。
4. **検収（Stage 3）** `uiReview(パケット, 納品物)`、または doPost に `{action:'review', packet, delivery}`。全項目 pass なら accept、fail があれば reject、実行確認待ちが残れば conditional。検収は修正しない — reject は Stage 2 への再依頼で直す。
5. 結果はログシートに記録される。期待と違った応答には `recordFeedback(行番号, 評価1-5, '何が違ったか')` か UI の 👎。
6. 週次の `proposeStyleDelta()` が低評価事例から追補案を Drive に生成する。**憲法本体は自動では書き換わらない。** 採用する規約だけを STYLE_DELTA.md に手動転記し、`clearConstitutionCache()` を実行して反映する。

## 設計上の割り切り

- 憲法の自動書換をしないのは意図的（承認なき自己改変の禁止）。感化は「提案 → 人間の採否 → 追補」の一方向。
- 検収（Stage 3）は判定のみで、納品物を書き直さない。ここで直すと未検収の成果物が生まれるため、修正は Stage 2 の再依頼に戻す。検収器はコードを実行できないので、実行が要る項目は accept ではなく needs_execution として Jun の確認に委ねる。
- 検収条件（acceptance_criteria）は納品物が存在しない Stage 1 で生成する。納品物を見てから基準を作ると基準が納品物に引きずられるため、順序を固定している。
- 転写できるのは規約・文体・検証習慣であり、判断品質そのものはモデル依存で残る。追補の蓄積は文体の再現度を上げるが、モデル間の能力差は埋めない（確信度: 高）。
