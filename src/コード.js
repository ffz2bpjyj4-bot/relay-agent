/**
 * ============================================================
 * RELAY — 依頼受付・整理・受渡・検収エージェント (GAS) v6
 * ============================================================
 * v5 からの変更点:
 *   [追加] Stage 3「検収」を実装。uiReview(packet, delivery) が
 *          REVIEWER 規約で納品物を採点し検収JSONを返す。
 *          Script Property: REVIEWER_MD_FILE_ID（任意、内蔵版フォールバックあり）。
 *   [修正] clarification ゲートを outcome_affecting 依存から
 *          「outcome_affecting または ambiguities 非空」に変更。
 *          ORGANIZER 新スキーマ(v3, outcome_affecting 廃止)でも旧スキーマでも
 *          曖昧点で停止するようにした（後方互換）。
 *   [同期] 内蔵 DEFAULT_ORGANIZER_PROMPT_ を Drive 版 ORGANIZER.md v3 に同期
 *          （task_type / acceptance_criteria / original_request を追加、
 *          outcome_affecting を廃止）。
 *   [追加] 受渡パケットに task_type と 検収条件(acceptance_criteria) を出力。
 *          後段が型別規律の適用と納品前自己照合をできるようにした。
 *
 * --- 内蔵版とDrive版の同期義務 ---
 * 以下は「Drive の .md（正）」と「本ファイルの内蔵フォールバック」の対。
 * .md を改訂したら内蔵版も更新すること（未設定環境での挙動を一致させるため）:
 *   ORGANIZER.md   <-> DEFAULT_ORGANIZER_PROMPT_
 *   REVIEWER.md    <-> DEFAULT_REVIEWER_PROMPT_
 * ※ 内蔵版を持たず *_MD_FILE_ID を必須化する運用に切り替えれば同期義務は消える。
 *
 * Script Properties:
 *   AGENTS_MD_FILE_ID      必須
 *   PERSONA_MD_FILE_ID     必須
 *   ORGANIZER_MD_FILE_ID   任意（依頼構造化規約。未設定なら内蔵版）
 *   REVIEWER_MD_FILE_ID    任意（納品検収規約。未設定なら内蔵版）
 *   STYLE_DELTA_FILE_ID    任意（承認済み追補。最初は空でよい）
 *   LOG_SPREADSHEET_ID     必須
 *   DEFAULT_PROVIDER       任意  gemini | anthropic | openai（既定 gemini）
 *   GEMINI_API_KEY / GEMINI_MODEL         （既定 gemini-3.5-flash）
 *   ANTHROPIC_API_KEY / ANTHROPIC_MODEL   （既定 claude-sonnet-4-6）
 *   OPENAI_API_KEY / OPENAI_MODEL         （既定 gpt-4o）
 *   RELAY_WEBHOOK_TOKEN    任意（doPost を外部公開する場合のみ）
 */

// ------------------------------------------------------------
// 設定・共通ユーティリティ
// ------------------------------------------------------------

const PROPS_ = PropertiesService.getScriptProperties();
const CACHE_ = CacheService.getScriptCache();
const CONSTITUTION_CACHE_KEY_ = 'relay_constitution_v1';
const ORGANIZER_CACHE_KEY_ = 'relay_organizer_v1';
const REVIEWER_CACHE_KEY_ = 'relay_reviewer_v1';
const CACHE_SEC_ = 600;

function prop_(key, fallback) {
  const v = PROPS_.getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Script Property 未設定: ' + key);
  }
  return v;
}

/** 憲法・構造化規約・検収規約のキャッシュを全て消す。Drive上のmd編集後に実行する。 */
function clearConstitutionCache() {
  CACHE_.remove(CONSTITUTION_CACHE_KEY_);
  CACHE_.remove(ORGANIZER_CACHE_KEY_);
  CACHE_.remove(REVIEWER_CACHE_KEY_);
  return 'キャッシュを削除した。次回読込時に Drive から再取得する。';
}

// ------------------------------------------------------------
// 外部ファイル読込
// ------------------------------------------------------------

function loadConstitution_() {
  const cached = CACHE_.get(CONSTITUTION_CACHE_KEY_);
  if (cached) return cached;

  const parts = [];
  parts.push('# 作業規約 (AGENTS.md)\n\n' + readDriveText_(prop_('AGENTS_MD_FILE_ID')));
  parts.push('# 応答特性 (PERSONA.md)\n\n' + readDriveText_(prop_('PERSONA_MD_FILE_ID')));

  const deltaId = PROPS_.getProperty('STYLE_DELTA_FILE_ID');
  if (deltaId) {
    const delta = readDriveText_(deltaId).trim();
    if (delta) parts.push('# 追補 (STYLE_DELTA.md — 承認済みの追加規約。上記と矛盾する場合はこちらが優先)\n\n' + delta);
  }

  const constitution = parts.join('\n\n---\n\n');
  if (constitution.length < 90000) {
    CACHE_.put(CONSTITUTION_CACHE_KEY_, constitution, CACHE_SEC_);
  }
  return constitution;
}

/** 構造化規約。ORGANIZER_MD_FILE_ID 設定時は Drive 版、未設定時は内蔵版。 */
function loadOrganizerPrompt_() {
  const id = PROPS_.getProperty('ORGANIZER_MD_FILE_ID');
  if (!id) return DEFAULT_ORGANIZER_PROMPT_;

  const cached = CACHE_.get(ORGANIZER_CACHE_KEY_);
  if (cached) return cached;

  const text = readDriveText_(id);
  if (text.length < 90000) CACHE_.put(ORGANIZER_CACHE_KEY_, text, CACHE_SEC_);
  return text;
}

/** 検収規約。REVIEWER_MD_FILE_ID 設定時は Drive 版、未設定時は内蔵版。 */
function loadReviewerPrompt_() {
  const id = PROPS_.getProperty('REVIEWER_MD_FILE_ID');
  if (!id) return DEFAULT_REVIEWER_PROMPT_;

  const cached = CACHE_.get(REVIEWER_CACHE_KEY_);
  if (cached) return cached;

  const text = readDriveText_(id);
  if (text.length < 90000) CACHE_.put(REVIEWER_CACHE_KEY_, text, CACHE_SEC_);
  return text;
}

function readDriveText_(fileId) {
  const file = DriveApp.getFileById(fileId);
  const mime = file.getMimeType();
  if (mime === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(fileId).getBody().getText();
  }
  const text = file.getBlob().getDataAsString('UTF-8');
  if (text.indexOf('PK\u0003\u0004') === 0) {
    throw new Error(file.getName() + ' は zip 系バイナリ (docx等 / ' + mime +
      ')。プレーンテキストの .md として再アップロードし、ファイルIDを差し替えること。');
  }
  return text;
}

/** 診断: 各外部ファイルの実体をログ出力する。 */
function inspectConstitutionFiles() {
  const targets = [
    ['AGENTS_MD_FILE_ID', '必須'],
    ['PERSONA_MD_FILE_ID', '必須'],
    ['ORGANIZER_MD_FILE_ID', '任意'],
    ['REVIEWER_MD_FILE_ID', '任意'],
    ['STYLE_DELTA_FILE_ID', '任意']
  ];
  targets.forEach(function (t) {
    const id = PROPS_.getProperty(t[0]);
    if (!id) { Logger.log(t[0] + ': 未設定（' + t[1] + '）'); return; }
    try {
      const file = DriveApp.getFileById(id);
      let head, len;
      try {
        const text = readDriveText_(id);
        len = text.length;
        head = text.slice(0, 200).replace(/\n/g, ' / ');
      } catch (e) {
        len = '-'; head = '読込エラー: ' + e;
      }
      Logger.log(t[0] + ': name=' + file.getName() + ' | mime=' + file.getMimeType() +
        ' | 文字数=' + len + '\n冒頭: ' + head);
    } catch (e) {
      Logger.log(t[0] + ': ファイル取得失敗 — ' + e);
    }
  });
}

// ------------------------------------------------------------
// Stage 1: 依頼の受け止めと構造化
// ------------------------------------------------------------

/**
 * 内蔵版の構造化規約。ORGANIZER.md 未設定時のフォールバック。
 * Drive 版 ORGANIZER.md v3 と同期していること（ファイル冒頭の同期義務を参照）。
 */
const DEFAULT_ORGANIZER_PROMPT_ = `あなたは依頼の交通整理役である。依頼を「実行」しない。後続のAIエージェントが誤解なく着手できる形に依頼を「構造化」することだけが任務である。

## 思考手順（この順で考える）
1. 背景と課題を分離する。背景＝動かない事実・状況。課題＝解決すべきボトルネック。
2. 目的をギャップとして定義する。「現状Xだが、理想はY」の形に落とす。手段を目的と取り違えない。手段しか書かれていなければ、その手段が解決する課題を推定し、推定であることを明示する。
3. 依頼型を1つ選ぶ。後続エージェントの応答規律を決める分類であり、必ず1つに定める。迷ったら C とする。
   - A 事実確認: 答えが1つに定まる
   - B 手順・コード: 成果物が実行可能物
   - C 意思決定・戦略: 正解がなくトレードオフがある
   - D 文章生成: 成果物がテキストそのもの
   - E 調査・分析: 情報の収集と統合
4. 成果物を特定する。何が・どんな形式で（コード/文書/構成案/手順書 等）納品されれば依頼者は受け取れるか。
5. 完了条件を機械化する。判定可能な1文。書けなければ null とし、何が決まれば書けるかを open_questions に入れる。
6. 検収条件を書く。完了条件と成果物形式を、納品物を初めて見る第三者が はい/いいえ で判定できる3〜7項目に分解する。「高品質」「適切」「十分」等の品質語を使わず、存在・一致・数値で書く。机上で判定できず実行が必要な項目には「（要実行）」を付ける。
7. スコープ外を明示する。「今回はやらない」と読めるもの、膨張しがちな隣接領域を挙げる。
8. 曖昧さを2種に仕分ける。成果物が変わる曖昧さのみ ambiguities（選択肢と推奨付き）。変わらないものは assumptions。迷ったら ambiguities。推奨を付けられる論点は open_questions ではなく ambiguities に入れる。
9. 残存論点を open_questions に最大3つ。なければ空配列。

## 出力形式
次のキーを持つJSONのみを出力する。コードフェンス・前置き・後書きは一切付けない。original_request 以外の値は簡潔に（各1〜2文）。
{
  "task_type": "A | B | C | D | E のいずれか1文字",
  "background": "背景（動かない事実・状況）",
  "problem": "課題（解決すべきボトルネック）",
  "objective": "目的（現状→理想のギャップとして1文）",
  "deliverable": "成果物（何を・どんな形式で）",
  "done_definition": "機械的に判定できる完了条件を1文。書けなければ null",
  "acceptance_criteria": ["はい/いいえで判定できる合格条件（3〜7項目。要実行のものは（要実行）を付ける）"],
  "out_of_scope": ["今回やらないこと"],
  "constraints": ["明示された制約"],
  "ambiguities": [{"point": "解釈が割れる点", "options": ["解釈A", "解釈B"], "recommended": "推奨解釈と理由（1文）"}],
  "assumptions": ["成果物に影響しないため置いた前提"],
  "open_questions": ["着手前に確認する価値がある残存論点（最大3、なければ空）"],
  "original_request": "依頼原文を加工せず全文"
}

## JSONの妥当性
- 出力全体が JSON.parse に通ること。これが他のすべての形式規則に優先する。
- 値の中の改行は \\n、ダブルクォートは \\" にエスケープする。
- done_definition が書けない場合は文字列 "null" ではなく JSON の null を出す。
- 該当なしの配列は空配列 [] を出す。キーの省略・null 化はしない。規定にないキーを追加しない。

## 品質基準
- 依頼文の言い換えではなく再構造化であること。
- 推定で補った箇所は「（推定）」を付ける。推定を事実のように書かない。
- ambiguities の選択肢は互いに排他的で、選ぶと成果物が実際に変わるものだけ。3件以内。
- acceptance_criteria は納品物なしで書く。done_definition が null でも、成果物形式と制約から判定可能な項目は書けるだけ書く。
- task_type は依頼の主目的で選ぶ。成果物の受け取り形式を決める要素を優先する。
- 冗長な敬語・感想・助言を書かない。構造化データのみを返す。`;

function normalizeRequest(rawText, provider) {
  provider = provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const raw = callModelText_(provider, loadOrganizerPrompt_(), '依頼文:\n' + rawText);
  return parseJsonLoose_(raw);
}

function parseJsonLoose_(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('JSONではない応答: ' + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ------------------------------------------------------------
// 受渡パケット生成
// ------------------------------------------------------------

/**
 * 新スキーマの全項目を出力。旧スキーマ（項目欠損）でも読み飛ばして動作する。
 * @param {boolean} adoptRecommended  「推奨解釈で続行」により推奨解釈を採用したか
 */
function buildHandoffPacket_(rawText, n, adoptRecommended) {
  const L = [];
  function section(title, body) {
    if (!body) return;
    L.push('');
    L.push('### ' + title);
    L.push(body);
  }
  function listSection(title, arr, mapper) {
    if (!arr || !arr.length) return;
    L.push('');
    L.push('### ' + title);
    arr.forEach(function (x) { L.push('- ' + (mapper ? mapper(x) : x)); });
  }

  L.push('## 依頼（受渡パケット）');
  L.push('前段のエージェントが依頼を整理した。与えられた作業規約と応答特性に厳密に従って実行せよ。');

  section('依頼型', n.task_type ? String(n.task_type) + ' — 応答特性規約の該当型の規律を適用せよ。' : '');
  section('背景', n.background);
  section('課題', n.problem);
  section('目的', n.objective || '(未整理)');
  section('成果物', n.deliverable);
  section('完了条件', n.done_definition ||
    '未定義 — 着手前に作業規約の原則1に従い完了条件を1行で提示してから進むこと。');
  listSection('検収条件（納品前にこの各項目を自己照合し、満たせない項目は成果物末尾に申告せよ）', n.acceptance_criteria);
  listSection('スコープ外（実装しない。必要と考えるなら提案に留める）', n.out_of_scope);
  listSection('制約', n.constraints);
  if (adoptRecommended && n.ambiguities && n.ambiguities.length) {
    listSection('採用した解釈（依頼者が推奨解釈での続行を明示指示）', n.ambiguities,
      function (a) { return a.point + ' → ' + (a.recommended || (a.options && a.options[0]) || ''); });
  }
  listSection('置いた前提（成果物に影響しないと判断したもの。異なれば申告せよ）', n.assumptions);
  listSection('未解決点（成果物を左右するものがあれば着手前に1問だけ確認せよ）', n.open_questions);

  L.push('');
  L.push('### 原文');
  L.push(rawText);
  return L.join('\n');
}

/** 他AIのチャット欄に1回で貼れる、憲法込みのフルプロンプト */
function buildFullPrompt_(packet) {
  return 'あなたはこれから、以下の「作業規約」「応答特性」に従って依頼を実行するエージェントである。' +
    '規約を読了した上で、末尾の受渡パケットに着手せよ。\n\n' +
    loadConstitution_() + '\n\n---\n\n' + packet;
}

// ------------------------------------------------------------
// Stage 3: 納品検収
// ------------------------------------------------------------

/**
 * 内蔵版の検収規約。REVIEWER.md 未設定時のフォールバック。
 * Drive 版 REVIEWER.md と同期していること（ファイル冒頭の同期義務を参照）。
 */
const DEFAULT_REVIEWER_PROMPT_ = `あなたは納品物の検収役である。受渡パケットと納品物を受け取り、合否を判定する。修正しない、改善しない、書き直さない。判定と根拠の報告だけが任務である。

あなたはコードを実行できない。実行しなければ判定できない項目を、机上の印象で pass にしない。

## 入力
- 受渡パケット（ORGANIZER の出力。acceptance_criteria を含む）
- 納品物（Stage 2 の成果物全文）

## 判定手順（この順で実施する）
1. 共通チェック。パケットのフィールドから機械的に導出する:
   - done_definition を納品物が満たしているか。null の場合、納品物側に自己定義された完了条件があり、それを満たしているか。
   - deliverable に指定された形式と一致しているか。
   - out_of_scope に列挙された事項が実装・混入されていないか（ついで改善の検出）。
   - constraints に違反していないか。
   - ambiguities が非空の場合、採用した解釈が納品物の冒頭に明記されているか。
   - assumptions・パケット外で新たに置かれた前提が納品物に明記されているか。
2. task_type 別チェック。
   - B: 完全ファイル置換の形式か。実行する検証手順（コマンド・期待出力・失敗時に報告する情報）が付いているか。「動くはず」「テスト済み」等の実行の偽装がないか。
   - C: 推奨に根拠・確信度・反転条件が付いているか。対立視点があるか。
   - D: 指定形式に従っているか。架空の引用・出典がないか。
   - E: 事実と推論が分離されているか。出典が示され、外部ソースがパラフレーズされているか。
   - A: 通常は検収不要。パケットが A なのに検収に回ってきたこと自体を報告する。
3. 案件固有チェック。acceptance_criteria を1項目ずつ判定する。空の場合、その旨を summary に記し、判定を done_definition と形式チェックのみに依拠したこと（検収強度が下がること）を明示する。

## 判定の規律
- 各項目の判定は3値: pass / fail / needs_execution。needs_execution ＝ 実行しなければ判定できない項目（「（要実行）」付き、テスト通過・動作確認の類すべて）。
- pass には evidence（納品物中の根拠箇所を1行で特定）が必須。evidence が書けない項目は pass にできない。
- fail には「何が欠けているか・どこが違反か」を1行で書く。修正案は書かない。
- 全体の総評・出来栄えへの賛辞を書かない。判定は項目の集積であり、印象ではない。
- 納品物の書き直し・修正版の提示をしない。修正は Stage 2 の再依頼で行う。
- 検収対象外の改善点は suggestions に提案として列挙するに留める（実装指示ではない）。

## 総合判定
- accept: 全項目 pass。
- conditional: fail はゼロだが needs_execution が残る。実行確認を経て確定する。
- reject: fail が1つ以上ある。
fail が1つでも accept を出さない。needs_execution を pass に繰り上げない。

## 出力形式
次のキーを持つJSONのみを出力する。コードフェンス・前置き・後書きは一切付けない。
{
  "verdict": "accept | conditional | reject",
  "summary": "判定理由を1文で",
  "items": [{"criterion": "判定した項目", "result": "pass | fail | needs_execution", "evidence": "納品物中の根拠箇所、または欠落・違反の内容（1行）"}],
  "must_fix": ["reject の場合、再依頼で直すべき点（fail 項目の要約）"],
  "needs_execution": ["実行して確認する手順（conditional の場合）"],
  "suggestions": ["検収対象外の改善提案（なければ空）"]
}
JSON.parse に通ること。改行は \\n、該当なしは空配列、キーの追加・省略をしない。`;

// ------------------------------------------------------------
// UI 向けエントリ
// ------------------------------------------------------------

/**
 * Stage 1 整理モード（既定）: 依頼文を正規化し、コピペで他AIに渡せる受渡パケットを返す。
 */
function uiOrganize(rawText, opts) {
  opts = opts || {};
  const provider = opts.provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const normalized = normalizeRequest(rawText, provider);

  // v3(outcome_affecting 廃止)でも旧スキーマでも曖昧点で停止する。
  const hasBlockingAmbiguity =
    normalized.outcome_affecting === true ||
    (Array.isArray(normalized.ambiguities) && normalized.ambiguities.length > 0);

  if (hasBlockingAmbiguity && !opts.skipClarification) {
    logRun_(rawText, normalized, provider, '(整理前に確認質問を返却)', 'clarification');
    return { status: 'needs_clarification', normalized: normalized };
  }

  const packet = buildHandoffPacket_(rawText, normalized, !!opts.skipClarification);
  const row = logRun_(rawText, normalized, provider, packet, 'organized');
  return {
    status: 'organized',
    packet: packet,
    fullPrompt: buildFullPrompt_(packet),
    normalized: normalized,
    logRow: row,
    provider: provider
  };
}

/**
 * Stage 2 実行モード: 憲法を注入した通常チャット。正規化は行わない。
 * @param {Array} history [{role:'user'|'assistant', text}]
 */
function uiChat(history, opts) {
  opts = opts || {};
  const provider = opts.provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const lastUser = history.filter(function (m) { return m.role === 'user'; }).pop();
  if (!lastUser) throw new Error('user 発言がない');

  const response = callModel_(provider, loadConstitution_(), history);
  const row = logRun_(lastUser.text, { note: 'execute/chat' }, provider, response, 'completed');
  return { status: 'completed', response: response, logRow: row, provider: provider };
}

/**
 * Stage 3 検収モード: 受渡パケットと納品物を検収規約で採点し、検収JSONを返す。
 * @param {string} packet   Stage 1 の受渡パケット（または相当する依頼記述）
 * @param {string} delivery Stage 2 の納品物全文
 */
function uiReview(packet, delivery, opts) {
  opts = opts || {};
  const provider = opts.provider || prop_('DEFAULT_PROVIDER', 'gemini');
  if (!packet || !String(packet).trim()) throw new Error('受渡パケットが空');
  if (!delivery || !String(delivery).trim()) throw new Error('納品物が空');

  const userText = '## 受渡パケット\n' + packet + '\n\n## 納品物\n' + delivery;
  const raw = callModelText_(provider, loadReviewerPrompt_(), userText);

  let verdict = null;
  try {
    verdict = parseJsonLoose_(raw);
  } catch (e) {
    const errRow = logRun_('[検収] ' + String(packet).slice(0, 150),
      { note: 'review', parse_error: String(e) }, provider, raw, 'review_parse_error');
    return { status: 'review_parse_error', raw: raw, error: String(e), logRow: errRow, provider: provider };
  }

  const row = logRun_('[検収] ' + String(packet).slice(0, 150),
    { note: 'review' }, provider, raw, 'reviewed');
  return { status: 'reviewed', verdict: verdict, raw: raw, logRow: row, provider: provider };
}

/** UI の 👍/👎 から呼ぶ。rating: 5=👍, 2=👎 */
function uiFeedback(logRow, rating, comment) {
  return recordFeedback(logRow, rating, comment);
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('RELAY')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------------------
// スクリプト/外部呼び出し用の単発API（doPost が使用）
// ------------------------------------------------------------

function handoff(rawText, opts) {
  opts = opts || {};
  const org = uiOrganize(rawText, opts);
  if (org.status === 'needs_clarification') {
    return {
      status: 'needs_clarification',
      normalized: org.normalized,
      message: '成果物を左右する曖昧点がある。解釈を確定して再実行するか skipClarification:true で推奨解釈により強行する。'
    };
  }
  if (opts.organizeOnly) return org;

  const provider = org.provider;
  const response = callModel_(provider, loadConstitution_(), [{ role: 'user', text: org.packet }]);
  const row = logRun_(rawText, org.normalized, provider, response, 'completed');
  return { status: 'completed', logRow: row, provider: provider, normalized: org.normalized, response: response };
}

// ------------------------------------------------------------
// アダプタ層（モデル非依存・複数ターン対応）
// ------------------------------------------------------------

function callModel_(provider, systemText, messages) {
  switch (provider) {
    case 'gemini': return callGemini_(systemText, messages);
    case 'anthropic': return callAnthropic_(systemText, messages);
    case 'openai': return callOpenAI_(systemText, messages);
    default: throw new Error('未知の provider: ' + provider +
      ' — DEFAULT_PROVIDER には gemini / anthropic / openai のいずれかを設定する。' +
      'モデル名は GEMINI_MODEL 等の *_MODEL プロパティに設定する。');
  }
}

function callModelText_(provider, systemText, userText) {
  return callModel_(provider, systemText, [{ role: 'user', text: userText }]);
}

function callGemini_(systemText, messages) {
  const model = prop_('GEMINI_MODEL', 'gemini-3.5-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + prop_('GEMINI_API_KEY');
  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: messages.map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] };
    })
  };
  const data = fetchJson_(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload) });
  try {
    return data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  } catch (e) {
    throw new Error('Gemini 応答の解析失敗: ' + JSON.stringify(data).slice(0, 300));
  }
}

function callAnthropic_(systemText, messages) {
  const payload = {
    model: prop_('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    max_tokens: 4096,
    system: systemText,
    messages: messages.map(function (m) { return { role: m.role, content: m.text }; })
  };
  const data = fetchJson_('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload)
  });
  try {
    return data.content.filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('\n');
  } catch (e) {
    throw new Error('Anthropic 応答の解析失敗: ' + JSON.stringify(data).slice(0, 300));
  }
}

function callOpenAI_(systemText, messages) {
  const payload = {
    model: prop_('OPENAI_MODEL', 'gpt-4o'),
    messages: [{ role: 'system', content: systemText }].concat(
      messages.map(function (m) { return { role: m.role, content: m.text }; })
    )
  };
  const data = fetchJson_('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + prop_('OPENAI_API_KEY') },
    payload: JSON.stringify(payload)
  });
  try {
    return data.choices[0].message.content;
  } catch (e) {
    throw new Error('OpenAI 応答の解析失敗: ' + JSON.stringify(data).slice(0, 300));
  }
}

function fetchJson_(url, options) {
  options.muteHttpExceptions = true;
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('API エラー HTTP ' + code + ': ' + body.slice(0, 500));
  }
  return JSON.parse(body);
}

// ------------------------------------------------------------
// ログと継続的感化ループ
// ------------------------------------------------------------

const LOG_SHEET_NAME_ = 'runs';
const LOG_HEADER_ = ['timestamp', 'provider', 'status', 'raw_request', 'normalized_json', 'response', 'rating', 'feedback'];

function getLogSheet_() {
  const ss = SpreadsheetApp.openById(prop_('LOG_SPREADSHEET_ID'));
  let sheet = ss.getSheetByName(LOG_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME_);
    sheet.appendRow(LOG_HEADER_);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logRun_(rawText, normalized, provider, response, status) {
  const sheet = getLogSheet_();
  sheet.appendRow([
    new Date(), provider, status, rawText,
    JSON.stringify(normalized), String(response).slice(0, 45000), '', ''
  ]);
  return sheet.getLastRow();
}

function recordFeedback(rowNumber, rating, comment) {
  const sheet = getLogSheet_();
  sheet.getRange(rowNumber, 7).setValue(rating);
  sheet.getRange(rowNumber, 8).setValue(comment || '');
  return '行 ' + rowNumber + ' に評価を記録した。';
}

function proposeStyleDelta() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return '実行ログがない。';

  const values = sheet.getRange(2, 1, last - 1, 8).getValues();
  const bad = values.filter(function (r) { return r[6] !== '' && Number(r[6]) <= 3; });
  if (!bad.length) return '低評価の実行がない。提案は生成しなかった。';

  const cases = bad.slice(-15).map(function (r, i) {
    return '### 事例' + (i + 1) + ' (評価 ' + r[6] + ')\n依頼: ' + String(r[3]).slice(0, 500) +
      '\n応答冒頭: ' + String(r[5]).slice(0, 500) + '\nJunの指摘: ' + r[7];
  }).join('\n\n');

  const prompt =
    '以下は AI エージェントの低評価事例である。現行の作業規約・応答特性・構造化規約を前提に、' +
    '再発を防ぐための追加規約を STYLE_DELTA.md への追記案として提案せよ。\n' +
    '要件: 各提案は「## 提案N」「規約文（命令形1〜3文）」「根拠となった事例番号」の形式。' +
    '既存規約の言い換えは提案しない。最大5件。\n\n' +
    '現行の憲法:\n' + loadConstitution_().slice(0, 20000) +
    '\n\n現行の構造化規約:\n' + loadOrganizerPrompt_().slice(0, 10000) +
    '\n\n低評価事例:\n' + cases;

  const provider = prop_('DEFAULT_PROVIDER', 'gemini');
  const proposal = callModelText_(provider, 'あなたは規約改善の提案者である。採否は人間が決める。', prompt);

  const fileName = 'STYLE_DELTA_proposal_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '.md';
  const file = DriveApp.createFile(fileName, proposal, MimeType.PLAIN_TEXT);
  return '提案を生成した: ' + file.getUrl() + '\nレビュー後、採用分を STYLE_DELTA.md に手動転記し clearConstitutionCache() を実行すること。';
}

// ------------------------------------------------------------
// 外部呼び出し用 doPost（Web UI を使うだけなら不要）
// ------------------------------------------------------------

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: 'JSON解析失敗' });
  }
  const expected = PROPS_.getProperty('RELAY_WEBHOOK_TOKEN');
  if (expected && body.token !== expected) {
    return jsonOut_({ error: 'token不一致' });
  }
  try {
    // action: 'review' なら検収、それ以外は従来の整理→実行。
    if (body.action === 'review') {
      return jsonOut_(uiReview(body.packet, body.delivery, { provider: body.provider }));
    }
    const result = handoff(body.request, {
      provider: body.provider,
      skipClarification: !!body.skipClarification,
      organizeOnly: !!body.organizeOnly
    });
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// 検証用
// ------------------------------------------------------------

function testPipeline() {
  Logger.log('=== testPipeline 開始 ===');
  const results = [];

  function stage(name, fn) {
    try {
      const msg = 'OK: ' + name + ' — ' + fn();
      results.push(msg); Logger.log(msg); return true;
    } catch (e) {
      const msg = 'NG: ' + name + ' — ' + e;
      results.push(msg); Logger.log(msg); return false;
    }
  }

  if (!stage('憲法読込', function () {
    return loadConstitution_().length + ' 文字';
  })) return results;

  if (!stage('構造化規約読込', function () {
    const p = loadOrganizerPrompt_();
    const src = PROPS_.getProperty('ORGANIZER_MD_FILE_ID') ? 'Drive版' : '内蔵版';
    return src + ' ' + p.length + ' 文字';
  })) return results;

  if (!stage('検収規約読込', function () {
    const p = loadReviewerPrompt_();
    const src = PROPS_.getProperty('REVIEWER_MD_FILE_ID') ? 'Drive版' : '内蔵版';
    return src + ' ' + p.length + ' 文字';
  })) return results;

  if (!stage('正規化', function () {
    const n = normalizeRequest('スプレッドシートAのB列を合計してC1に書くGAS関数を書いて');
    return 'task_type: ' + (n.task_type || '(旧スキーマ)') + ' / deliverable: ' + (n.deliverable || '-');
  })) return results;

  let lastPacket = '';
  stage('整理（パケット生成）', function () {
    const r = uiOrganize('FizzBuzzを出力するGAS関数を書いて。完了条件: 1〜15の出力例をログに含める。');
    lastPacket = r.packet || '';
    return 'status: ' + r.status + (r.logRow ? ' / ログ行: ' + r.logRow : '') +
      (r.packet ? ' / パケット ' + r.packet.length + ' 文字' : '');
  });

  stage('検収（uiReview）', function () {
    const pkt = lastPacket ||
      '## 依頼（受渡パケット）\n### 依頼型\nB\n### 完了条件\nFizzBuzzの1〜15出力例がログに含まれる\n' +
      '### 検収条件\n- 1〜15の出力例が示されている\n- （要実行）関数がエラーなく完了する';
    const dlv = 'function fizzBuzz(){ for (var i=1;i<=15;i++){ /* ... */ } }\n' +
      '// 検証手順: エディタで fizzBuzz() を実行しログを確認。期待出力: 1,2,Fizz,4,Buzz,...,14,FizzBuzz';
    const r = uiReview(pkt, dlv);
    return 'status: ' + r.status +
      (r.verdict ? ' / verdict: ' + r.verdict.verdict + ' / items: ' + (r.verdict.items || []).length : '') +
      (r.logRow ? ' / ログ行: ' + r.logRow : '');
  });

  Logger.log('=== testPipeline 終了 ===');
  return results;
}
