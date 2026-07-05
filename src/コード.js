/**
 * ============================================================
 * RELAY — 依頼受付・整理・受渡エージェント (GAS) v5
 * ============================================================
 * v4 からの変更点:
 *   [変更] 構造化スキーマを刷新: 背景/課題/目的/成果物/完了条件/
 *          スコープ外/制約/曖昧点/前提/未解決点。「依頼をロジカルに
 *          まとめる」中核ロジックを強化。
 *   [追加] 構造化ロジックを外部ファイル ORGANIZER.md へ分離
 *          （Script Property: ORGANIZER_MD_FILE_ID、任意）。
 *          未設定時はコード内蔵の既定プロンプトで動作するため、
 *          設定なしでも従来どおり動く。
 *   [変更] 受渡パケットが新スキーマの全項目を出力。旧スキーマの
 *          正規化結果でも欠損項目を読み飛ばして動作する（後方互換）。
 *
 * v4: 整理→受渡文提示を既定動作化 / uiOrganize / 憲法込みコピー
 * v3: Gemini 既定を gemini-3.5-flash / MIME対応リーダ / 診断関数
 * v2: testPipeline ログ修正 / チャットUI / 複数ターン対応アダプタ
 *
 * Script Properties:
 *   AGENTS_MD_FILE_ID      必須
 *   PERSONA_MD_FILE_ID     必須
 *   ORGANIZER_MD_FILE_ID   任意（依頼構造化規約。未設定なら内蔵版）
 *   STYLE_DELTA_FILE_ID    任意
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
const CACHE_SEC_ = 600;

function prop_(key, fallback) {
  const v = PROPS_.getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Script Property 未設定: ' + key);
  }
  return v;
}

/** 憲法・構造化規約のキャッシュを両方消す。Drive上のmd編集後に実行する。 */
function clearConstitutionCache() {
  CACHE_.remove(CONSTITUTION_CACHE_KEY_);
  CACHE_.remove(ORGANIZER_CACHE_KEY_);
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

/** 内蔵版の構造化規約。ORGANIZER.md 未設定時のフォールバック（内容は同一）。 */
const DEFAULT_ORGANIZER_PROMPT_ =
  'あなたは依頼の交通整理役である。依頼を「実行」しない。後続のAIエージェントが誤解なく着手できる形に依頼を「構造化」することだけが任務である。\n\n' +
  '## 思考手順（この順で考える）\n' +
  '1. 背景と課題を分離する。背景＝動かない事実・状況。課題＝解決すべきボトルネック。\n' +
  '2. 目的をギャップとして定義する。「現状Xだが、理想はY」の形に落とす。手段を目的と取り違えない。手段しか書かれていなければ、その手段が解決する課題を推定し、推定であることを明示する。\n' +
  '3. 成果物を特定する。何が・どんな形式で納品されれば依頼者は受け取れるか。\n' +
  '4. 完了条件を機械化する。判定可能な1文。書けなければ null とし、何が決まれば書けるかを open_questions に入れる。\n' +
  '5. スコープ外を明示する。「今回はやらない」と読めるもの、膨張しがちな隣接領域を挙げる。\n' +
  '6. 曖昧さを2種に仕分ける。成果物が変わる曖昧さのみ ambiguities（選択肢と推奨付き）。変わらないものは assumptions。迷ったら ambiguities。\n' +
  '7. 残存論点を open_questions に最大3つ。なければ空配列。\n\n' +
  '## 出力形式\n' +
  '次のキーを持つJSONのみを出力する。コードフェンス・前置き・後書きは一切付けない。値は簡潔に（各1〜2文）。\n' +
  '{\n' +
  '  "background": "背景（動かない事実・状況）",\n' +
  '  "problem": "課題（解決すべきボトルネック）",\n' +
  '  "objective": "目的（現状→理想のギャップとして1文）",\n' +
  '  "deliverable": "成果物（何を・どんな形式で）",\n' +
  '  "done_definition": "機械的に判定できる完了条件を1文。書けなければ null",\n' +
  '  "out_of_scope": ["今回やらないこと"],\n' +
  '  "constraints": ["明示された制約"],\n' +
  '  "ambiguities": [{"point": "解釈が割れる点", "options": ["解釈A", "解釈B"], "recommended": "推奨解釈と理由（1文）"}],\n' +
  '  "assumptions": ["成果物に影響しないため置いた前提"],\n' +
  '  "open_questions": ["着手前に確認する価値がある残存論点（最大3、なければ空）"],\n' +
  '  "outcome_affecting": true or false\n' +
  '}\n\n' +
  '## 品質基準\n' +
  '- 依頼文の言い換えではなく再構造化であること。\n' +
  '- 推定で補った箇所は「（推定）」を付ける。推定を事実のように書かない。\n' +
  '- ambiguities の選択肢は互いに排他的で、選ぶと成果物が実際に変わるものだけ。3件以内。\n' +
  '- 冗長な敬語・感想・助言を書かない。構造化データのみを返す。';

function normalizeRequest(rawText, provider) {
  provider = provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const raw = callModelText_(provider, loadOrganizerPrompt_(), '依頼文:\n' + rawText);
  return parseJsonLoose_(raw);
}

function parseJsonLoose_(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('正規化結果がJSONではない: ' + cleaned.slice(0, 200));
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

  section('背景', n.background);
  section('課題', n.problem);
  section('目的', n.objective || '(未整理)');
  section('成果物', n.deliverable);
  section('完了条件', n.done_definition ||
    '未定義 — 着手前に作業規約の原則1に従い完了条件を1行で提示してから進むこと。');
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
// UI 向けエントリ
// ------------------------------------------------------------

/**
 * 整理モード（既定）: 依頼文を正規化し、コピペで他AIに渡せる受渡パケットを返す。
 */
function uiOrganize(rawText, opts) {
  opts = opts || {};
  const provider = opts.provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const normalized = normalizeRequest(rawText, provider);

  if (normalized.outcome_affecting && !opts.skipClarification) {
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
 * 実行モード: 憲法を注入した通常チャット。正規化は行わない。
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

  if (!stage('正規化', function () {
    const n = normalizeRequest('スプレッドシートAのB列を合計してC1に書くGAS関数を書いて');
    return 'objective: ' + n.objective + ' / deliverable: ' + (n.deliverable || '(旧スキーマ)');
  })) return results;

  stage('整理（パケット生成）', function () {
    const r = uiOrganize('FizzBuzzを出力するGAS関数を書いて。完了条件: 1〜15の出力例をログに含める。');
    return 'status: ' + r.status + (r.logRow ? ' / ログ行: ' + r.logRow : '') +
      (r.packet ? ' / パケット ' + r.packet.length + ' 文字' : '');
  });

  Logger.log('=== testPipeline 終了 ===');
  return results;
}
