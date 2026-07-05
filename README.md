# gas-clasp-template

GASプロジェクトをGitHub管理し、mainへのpushで自動的にGASへ転送するテンプレート。
sybil-briefing構築時に実際に踏んだ障害を全て反映している。

## 前提（1回だけ。マシン共通）

| 項目 | 内容 |
|---|---|
| clasp導入 | `npm install -g @google/clasp` |
| バージョン確認 | `clasp -v` → **このテンプレートのpackage.jsonは3.3.0固定**。ローカルとCIのメジャーバージョンが違うと認証ファイルのスキーマ不整合（`token`/`tokens`）で必ず壊れる。ローカルを上げたらpackage.jsonも同時に上げる |
| Apps Script API | https://script.google.com/home/usersettings で「Google Apps Script API」をON |
| clasp login | `clasp login` → ブラウザで「Logged in!」表示を確認してからターミナルに戻る。途中離脱すると不完全な`~/.clasprc.json`が残る |
| ログイン検証 | `node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.clasprc.json'))))"` → `tokens` が含まれていればOK（clasp 3.x系） |

## 新規プロジェクトの構築手順

### 1. GASプロジェクトの用意

- 既存プロジェクトを使う場合: スクリプトエディタURL `script.google.com/d/{scriptId}/edit` からscriptIdを控える
- 新規の場合: script.new で作成 → コード貼付 → scriptIdを控える

### 2. このテンプレートから新規リポジトリ生成

GitHub上で本リポジトリの「Use this template」→「Create a new repository」。
**forkやREADME付き初期化はしない**（履歴汚染・push reject の原因）。

### 3. ローカルセットアップ

```bash
git clone https://github.com/{owner}/{new-repo}.git
cd {new-repo}
# .clasp.json を手動作成（clasp cloneは既存.clasp.jsonがあるディレクトリでは失敗する点に注意）
echo '{"scriptId":"{控えたscriptId}","rootDir":"src"}' > .clasp.json
clasp pull   # GAS側の既存コードをsrc/に取得（新規プロジェクトなら省略可）
```

注意: claspはGASの`.gs`ファイルをローカルでは`.js`として扱う。**src/に手でファイルを足すときも`.js`拡張子で統一する**。同名で`.gs`と`.js`が並存すると`clasp push`が`Conflicting files found`で全停止する（実際に発生した）。

### 4. GitHub Secrets登録（リポジトリごと）

Settings → Secrets and variables → Actions → New repository secret

| Secret名 | 値 |
|---|---|
| `CLASPRC_JSON` | `cat ~/.clasprc.json` の出力全体（先頭`{`〜末尾`}`を欠落なく） |
| `CLASP_JSON` | `cat .clasp.json` の出力全体 |

scriptId自体は認証情報ではないが、運用統一のためSecret管理にしている。

### 5. ローカルからの初回push

```bash
git add .
git status   # .clasp.json / .clasprc.json が含まれていないことを必ず目視
git commit -m "init"
git push -u origin main
```

push認証はPersonal Access Token。**スコープは `repo` + `workflow` の両方必須**
（workflowがないと`.github/workflows/`を含むpushがrejectされる。実際に発生した）。
古いトークンがKeychainに残って認証失敗が続く場合:
`security delete-internet-password -s github.com` を成功しなくなるまで繰り返す。

### 6. 動作確認

push直後にActionsが自動発火する。Actionsタブ→最新run→`clasp-push`ジョブで
`Pushed N files.` または `Script is already up to date.` が出れば成功。

## GAS側でのみ設定するもの（clasp管理外）

以下はコードと別レイヤーで、pushでは転送されない。GASエディタで直接設定する。

| 項目 | 場所 | 備考 |
|---|---|---|
| スクリプトプロパティ | プロジェクトの設定 → スクリプトプロパティ | APIキー（GEMINI_API_KEY等）、配信先メール等。コードに書かない |
| トリガー | セットアップ関数の実行 or トリガー画面 | 時間主導トリガー等 |
| ウェブアプリデプロイ | デプロイ → 新しいデプロイ | 初回のみ。/exec URLをスクリプトプロパティに登録する構成が多い |

## 運用ルール

1. **GitHubが唯一の正。GASエディタで直接編集しない** — `clasp push --force`は確認なしで上書きするため、エディタ側の変更は次のpushで消える。
2. **`clasp push`はHEADのみ更新。/execは更新されない** — doGet/doPost等ウェブアプリの挙動を変えたら、GASエディタ「デプロイを管理」→既存デプロイの編集→バージョン「新バージョン」→デプロイ。**「新しいデプロイ」を選ぶとURLが変わる**ので必ず既存の編集で。頻繁なら deploy.yml 内のコメントアウト（clasp deploy -i）を有効化して自動化。
3. **claspのバージョンはローカルとpackage.jsonを常に一致させる**。

## トラブルシューティング（実際に発生したエラーと対処）

| エラー | 原因 | 対処 |
|---|---|---|
| `npm ci` がEUSAGEで失敗 | package-lock.json未コミット | 本テンプレートは`npm install`使用で回避済み |
| `Error retrieving access token: ... reading 'access_token'` | ローカルとCIのclaspメジャーバージョン不一致（認証スキーマが`token`/`tokens`で異なる） | `clasp -v`とpackage.jsonを一致させる |
| `refusing to allow a Personal Access Token to create or update workflow` | PATに`workflow`スコープなし | トークンに`workflow`を追加して再生成 |
| `Invalid username or token` が新トークンでも続く | Keychainの古い認証情報が自動使用される | `security delete-internet-password -s github.com` |
| `Repository not found` | リポジトリ未作成 or リモートURLのowner欠落 | `git remote -v`で確認、`git remote set-url`で修正 |
| `! [rejected] main -> main (fetch first)` | GitHub側でREADME等付きで初期化した | 空で作り直すか、初回のみ`git push --force` |
| `Conflicting files found`（詳細なし） | src/に同名の`.gs`と`.js`が並存 | 重複を削除。`ls src/`で確認 |
| ウェブアプリの挙動が変わらない | /execが旧バージョンを配信 | 運用ルール2のバージョン更新 |
| doGetのリダイレクトがiframe内で止まる | HtmlServiceのサンドボックス | HTML先頭に`<base target="_top">` |
| Gemini API 503 | モデル側の一時過負荷 | 指数バックオフ再試行を実装（sybil-briefingの20_generate.gs参照） |
| メールの絵文字が文字化け | HTML埋め込み絵文字のエンコード崩れ | 絵文字を使わずテキストラベルにする |
