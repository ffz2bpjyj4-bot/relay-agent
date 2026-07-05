/**
 * ============================================================
 * RELAY — 依頼受付・整理・受渡エージェント (GAS)
 * ============================================================
 * 目的:
 *   Jun からの依頼を一旦受け止めて構造化し、外部ファイルの
 *   AGENTS.md / PERSONA.md / STYLE_DELTA.md を「憲法」として
 *   注入した上で、任意の後続 AI モデルへ受け渡す。
 *
 * 設計原則:
 *   - 憲法はコードに埋め込まず Drive 上の外部ファイルから読む（発展性）
 *   - モデル非依存のアダプタ層（Gemini / Anthropic / OpenAI）
 *   - AGENTS.md 原則2 に従い、解釈が割れる依頼は受渡前に確認を返す
 *   - 全実行をスプレッドシートに記録し、評価→STYLE_DELTA 提案の
 *     継続的感化ループを持つ（憲法の自動書換はしない。承認は人間）
 *
 * Script Properties（必須/任意）:
 *   AGENTS_MD_FILE_ID      必須  Drive 上の AGENTS.md
 *   PERSONA_MD_FILE_ID     必須  Drive 上の PERSONA.md
 *   STYLE_DELTA_FILE_ID    任意  Drive 上の STYLE_DELTA.md（感化の蓄積先）
 *   LOG_SPREADSHEET_ID     必須  実行ログ用スプレッドシート
 *   DEFAULT_PROVIDER       任意  gemini | anthropic | openai（既定 gemini）
 *   GEMINI_API_KEY         使う場合必須
 *   GEMINI_MODEL           任意（既定 gemini-2.0-flash）
 *   ANTHROPIC_API_KEY      使う場合必須
 *   ANTHROPIC_MODEL        任意（既定 claude-sonnet-4-6）
 *   OPENAI_API_KEY         使う場合必須
 *   OPENAI_MODEL           任意（既定 gpt-4o）
 *   RELAY_WEBHOOK_TOKEN    任意  doPost 保護用トークン
 *
 * 注意（確信度: 中）:
 *   モデル名・エンドポイントは変更されうるため全て Properties で
 *   上書き可能にしてある。疎通しない場合はまず各社ドキュメントで
 *   最新のモデル名を確認し Properties を更新すること。
 */

// ------------------------------------------------------------
// 設定・共通ユーティリティ
// ------------------------------------------------------------

const PROPS_ = PropertiesService.getScriptProperties();
const CACHE_ = CacheService.getScriptCache();
const CONSTITUTION_CACHE_KEY_ = 'relay_constitution_v1';
const CONSTITUTION_CACHE_SEC_ = 600; // 10分。編集を即反映したい場合は clearConstitutionCache()

function prop_(key, fallback) {
  const v = PROPS_.getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error('Script Property 未設定: ' + key);
  }
  return v;
}

function clearConstitutionCache() {
  CACHE_.remove(CONSTITUTION_CACHE_KEY_);
  return '憲法キャッシュを削除した。次回読込時に Drive から再取得する。';
}

// ------------------------------------------------------------
// 憲法（外部ファイル）読込
// ------------------------------------------------------------

/**
 * AGENTS.md + PERSONA.md + STYLE_DELTA.md を結合した system プロンプトを返す。
 * STYLE_DELTA は任意（未設定なら省略）。CacheService で10分キャッシュ。
 */
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
  // CacheService の上限は100KB。超過時はキャッシュせず毎回読む。
  if (constitution.length < 90000) {
    CACHE_.put(CONSTITUTION_CACHE_KEY_, constitution, CONSTITUTION_CACHE_SEC_);
  }
  return constitution;
}

function readDriveText_(fileId) {
  const file = DriveApp.getFileById(fileId);
  return file.getBlob().getDataAsString('UTF-8');
}

// ------------------------------------------------------------
// Stage 1: 依頼の受け止めと構造化
// ------------------------------------------------------------

const NORMALIZER_PROMPT_ =
  'あなたは依頼の交通整理役である。以下の依頼文を読み、後続のAIエージェントが' +
  '誤解なく着手できる形に構造化せよ。回答は次のキーを持つJSONのみを出力する。' +
  'Markdownのコードフェンスや前置きは一切付けない。\n' +
  '{\n' +
  '  "objective": "依頼の目的を1文で",\n' +
  '  "done_definition": "機械的に判定できる完了条件を1文で。書けなければ null",\n' +
  '  "constraints": ["明示された制約"],\n' +
  '  "ambiguities": [{"point": "解釈が割れる点", "options": ["解釈A", "解釈B"], "recommended": "推奨解釈と理由"}],\n' +
  '  "assumptions": ["解釈が割れるが成果物に影響しないため置く前提"],\n' +
  '  "outcome_affecting": true or false  // ambiguities のいずれかが成果物を変えるか\n' +
  '}\n' +
  '判定基準: どの解釈でも成果物が変わらない曖昧さは assumptions に入れ、' +
  '成果物が変わる曖昧さのみ ambiguities に入れて outcome_affecting を true にする。';

/**
 * 依頼文を構造化JSONに変換する。
 * @return {Object} {objective, done_definition, constraints, ambiguities, assumptions, outcome_affecting}
 */
function normalizeRequest(rawText, provider) {
  provider = provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const raw = callModel_(provider, NORMALIZER_PROMPT_, '依頼文:\n' + rawText);
  return parseJsonLoose_(raw);
}

function parseJsonLoose_(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  // 先頭の { から末尾の } までを抽出（前置き混入への防御）
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('正規化結果がJSONではない: ' + cleaned.slice(0, 200));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ------------------------------------------------------------
// Stage 2: 受渡（handoff）
// ------------------------------------------------------------

/**
 * メインエントリ。依頼を構造化し、成果物を左右する曖昧さがあれば
 * 確認質問を返して停止。なければ憲法を注入して後続モデルへ受け渡す。
 *
 * @param {string} rawText  Jun からの依頼文
 * @param {Object} opts     {provider, skipClarification: 確認を飛ばし推奨解釈で強行}
 * @return {Object} {status: 'needs_clarification'|'completed', ...}
 */
function handoff(rawText, opts) {
  opts = opts || {};
  const provider = opts.provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const normalized = normalizeRequest(rawText, provider);

  // AGENTS.md 原則2: 成果物を変える曖昧さは黙って選ばない
  if (normalized.outcome_affecting && !opts.skipClarification) {
    const result = {
      status: 'needs_clarification',
      normalized: normalized,
      message: '成果物を左右する曖昧点がある。解釈を確定してから handoff(rawText, {skipClarification:true}) で再実行するか、依頼文を修正して再実行すること。'
    };
    logRun_(rawText, normalized, provider, '(受渡前に確認質問を返却)', 'clarification');
    return result;
  }

  const packet = buildHandoffPacket_(rawText, normalized);
  const constitution = loadConstitution_();
  const response = callModel_(provider, constitution, packet);
  const row = logRun_(rawText, normalized, provider, response, 'completed');

  return { status: 'completed', logRow: row, provider: provider, normalized: normalized, response: response };
}

/**
 * 構造化結果を受渡パケット（後続モデルへの user メッセージ）に整形。
 */
function buildHandoffPacket_(rawText, n) {
  const lines = [];
  lines.push('## 受渡パケット');
  lines.push('前段のエージェントが依頼を整理した。system に与えた作業規約と応答特性に厳密に従って実行せよ。');
  lines.push('');
  lines.push('### 目的');
  lines.push(n.objective || '(未整理)');
  lines.push('');
  lines.push('### 完了条件');
  lines.push(n.done_definition || '未定義 — 着手前に AGENTS.md 原則1 に従い完了条件を1行で提示してから進むこと。');
  if (n.constraints && n.constraints.length) {
    lines.push('');
    lines.push('### 制約');
    n.constraints.forEach(function (c) { lines.push('- ' + c); });
  }
  if (n.assumptions && n.assumptions.length) {
    lines.push('');
    lines.push('### 置いた前提（成果物に影響しないと判断したもの。異なれば申告せよ）');
    n.assumptions.forEach(function (a) { lines.push('- ' + a); });
  }
  lines.push('');
  lines.push('### 原文');
  lines.push(rawText);
  return lines.join('\n');
}

// ------------------------------------------------------------
// アダプタ層（モデル非依存）
// ------------------------------------------------------------

function callModel_(provider, systemText, userText) {
  switch (provider) {
    case 'gemini': return callGemini_(systemText, userText);
    case 'anthropic': return callAnthropic_(systemText, userText);
    case 'openai': return callOpenAI_(systemText, userText);
    default: throw new Error('未知の provider: ' + provider);
  }
}

function callGemini_(systemText, userText) {
  const model = prop_('GEMINI_MODEL', 'gemini-2.0-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
    ':generateContent?key=' + prop_('GEMINI_API_KEY');
  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }]
  };
  const data = fetchJson_(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload) });
  try {
    return data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  } catch (e) {
    throw new Error('Gemini 応答の解析失敗: ' + JSON.stringify(data).slice(0, 300));
  }
}

function callAnthropic_(systemText, userText) {
  const payload = {
    model: prop_('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
    max_tokens: 4096,
    system: systemText,
    messages: [{ role: 'user', content: userText }]
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

function callOpenAI_(systemText, userText) {
  const payload = {
    model: prop_('OPENAI_MODEL', 'gpt-4o'),
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userText }
    ]
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

/** @return {number} 追記した行番号（recordFeedback で使う） */
function logRun_(rawText, normalized, provider, response, status) {
  const sheet = getLogSheet_();
  sheet.appendRow([
    new Date(), provider, status, rawText,
    JSON.stringify(normalized), String(response).slice(0, 45000), '', ''
  ]);
  return sheet.getLastRow();
}

/**
 * 実行結果への評価を記録する。rating: 1(悪)〜5(良)、comment: 何が期待と違ったか。
 * 例: recordFeedback(12, 2, '結論が最後に来た。前置きが長い。')
 */
function recordFeedback(rowNumber, rating, comment) {
  const sheet = getLogSheet_();
  sheet.getRange(rowNumber, 7).setValue(rating);
  sheet.getRange(rowNumber, 8).setValue(comment || '');
  return '行 ' + rowNumber + ' に評価を記録した。';
}

/**
 * 継続的感化: 低評価（rating <= 3）の実行を集約し、STYLE_DELTA.md への
 * 追記案を生成して Drive に「提案ファイル」として保存する。
 *
 * 重要: 憲法本体は自動で書き換えない。提案を Jun がレビューし、採用分を
 * 手動で STYLE_DELTA.md に転記する。承認なき自己改変は AGENTS.md 原則3
 * （ついで改善の禁止）に反するため意図的にこの設計とした。
 *
 * 週次トリガー推奨: proposeStyleDelta を毎週実行。
 */
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
    '以下は AI エージェントの低評価事例である。現行の作業規約・応答特性を前提に、' +
    '再発を防ぐための追加規約を STYLE_DELTA.md への追記案として提案せよ。\n' +
    '要件: 各提案は「## 提案N」「規約文（命令形1〜3文）」「根拠となった事例番号」の形式。' +
    '既存規約の言い換えは提案しない。最大5件。\n\n' +
    '現行の憲法:\n' + loadConstitution_().slice(0, 20000) + '\n\n低評価事例:\n' + cases;

  const provider = prop_('DEFAULT_PROVIDER', 'gemini');
  const proposal = callModel_(provider, 'あなたは規約改善の提案者である。採否は人間が決める。', prompt);

  const fileName = 'STYLE_DELTA_proposal_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '.md';
  const file = DriveApp.createFile(fileName, proposal, MimeType.PLAIN_TEXT);
  return '提案を生成した: ' + file.getUrl() + '\nレビュー後、採用分を STYLE_DELTA.md に手動転記し clearConstitutionCache() を実行すること。';
}

// ------------------------------------------------------------
// Web エントリポイント（任意）
// ------------------------------------------------------------

/**
 * POST { "token": "...", "request": "依頼文", "provider": "gemini", "skipClarification": false }
 */
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
    const result = handoff(body.request, { provider: body.provider, skipClarification: !!body.skipClarification });
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------
// 検証用（AGENTS.md 原則4: 「動いた」ではなく「検証した」）
// ------------------------------------------------------------

/**
 * セットアップ検証。エディタから実行しログを確認する。
 * 各段階の成否を配列で返すため、どこで落ちたか機械的に分かる。
 */
function testPipeline() {
  const results = [];
  try {
    const c = loadConstitution_();
    results.push('OK: 憲法読込 (' + c.length + ' 文字)');
  } catch (e) { results.push('NG: 憲法読込 — ' + e); return results; }

  try {
    const n = normalizeRequest('スプレッドシートAのB列を合計してC1に書くGAS関数を書いて');
    results.push('OK: 正規化 — objective: ' + n.objective);
  } catch (e) { results.push('NG: 正規化 — ' + e); return results; }

  try {
    const r = handoff('FizzBuzzを出力するGAS関数を書いて。完了条件: 1〜15の出力例をログに含める。');
    results.push('OK: 受渡 — status: ' + r.status + (r.logRow ? ' / ログ行: ' + r.logRow : ''));
  } catch (e) { results.push('NG: 受渡 — ' + e); }

  Logger.log(results.join('\n'));
  return results;
}
