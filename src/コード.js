/**
 * ============================================================
 * RELAY — 依頼受付・整理・受渡エージェント (GAS) v4
 * ============================================================
 * v3 からの変更点:
 *   [変更] 既定動作を「整理→受渡文の提示」に変更。依頼を送ると
 *          まず正規化し、他のAIにコピペで渡せる「受渡パケット」を
 *          返す。API経由の実行はボタンで明示指示した場合のみ。
 *   [追加] uiOrganize(): 受渡パケット生成（整理文のみ / 憲法込みの
 *          フルプロンプトの両方を返す）。
 *   [追加] 「推奨解釈で続行」時、採用した解釈をパケットに明記。
 *   [改善] callModel_ のエラーメッセージに設定ガイドを追加。
 *   （UI側: Enter送信を廃止しボタン送信のみに変更 — Index.html v2）
 *
 * v3: Gemini 既定を gemini-3.5-flash に更新 / MIME対応リーダ /
 *     inspectConstitutionFiles() 診断関数
 * v2: testPipeline ログ修正 / チャットUI / 複数ターン対応アダプタ
 *
 * Script Properties:
 *   AGENTS_MD_FILE_ID      必須
 *   PERSONA_MD_FILE_ID     必須
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
const CONSTITUTION_CACHE_SEC_ = 600;

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
    CACHE_.put(CONSTITUTION_CACHE_KEY_, constitution, CONSTITUTION_CACHE_SEC_);
  }
  return constitution;
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

/** 診断: 憲法を構成する各ファイルの実体をログ出力する。 */
function inspectConstitutionFiles() {
  const targets = [
    ['AGENTS_MD_FILE_ID', true],
    ['PERSONA_MD_FILE_ID', true],
    ['STYLE_DELTA_FILE_ID', false]
  ];
  targets.forEach(function (t) {
    const id = PROPS_.getProperty(t[0]);
    if (!id) { Logger.log(t[0] + ': 未設定' + (t[1] ? '（必須）' : '（任意）')); return; }
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
  '  "outcome_affecting": true or false\n' +
  '}\n' +
  '判定基準: どの解釈でも成果物が変わらない曖昧さは assumptions に入れ、' +
  '成果物が変わる曖昧さのみ ambiguities に入れて outcome_affecting を true にする。';

function normalizeRequest(rawText, provider) {
  provider = provider || prop_('DEFAULT_PROVIDER', 'gemini');
  const raw = callModelText_(provider, NORMALIZER_PROMPT_, '依頼文:\n' + rawText);
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
 * @param {string} rawText  原文
 * @param {Object} n        正規化結果
 * @param {boolean} adoptRecommended  「推奨解釈で続行」により推奨解釈を採用したか
 */
function buildHandoffPacket_(rawText, n, adoptRecommended) {
  const lines = [];
  lines.push('## 依頼（受渡パケット）');
  lines.push('前段のエージェントが依頼を整理した。与えられた作業規約と応答特性に厳密に従って実行せよ。');
  lines.push('');
  lines.push('### 目的');
  lines.push(n.objective || '(未整理)');
  lines.push('');
  lines.push('### 完了条件');
  lines.push(n.done_definition || '未定義 — 着手前に作業規約の原則1に従い完了条件を1行で提示してから進むこと。');
  if (n.constraints && n.constraints.length) {
    lines.push('');
    lines.push('### 制約');
    n.constraints.forEach(function (c) { lines.push('- ' + c); });
  }
  if (adoptRecommended && n.ambiguities && n.ambiguities.length) {
    lines.push('');
    lines.push('### 採用した解釈（依頼者が推奨解釈での続行を明示指示）');
    n.ambiguities.forEach(function (a) {
      lines.push('- ' + a.point + ' → ' + (a.recommended || (a.options && a.options[0]) || ''));
    });
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
 * ここではAIに依頼を「実行」させない。実行は uiExecute で明示的に行う。
 *
 * @param {string} rawText  依頼文（UI側で追記があれば結合済みの全文）
 * @param {Object} opts {provider, skipClarification}
 * @return {Object} needs_clarification | organized {packet, fullPrompt, normalized, logRow}
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
 * 「APIで実行」ボタン、および実行後の追撃ターンで使用。
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
    '以下は AI エージェントの低評価事例である。現行の作業規約・応答特性を前提に、' +
    '再発を防ぐための追加規約を STYLE_DELTA.md への追記案として提案せよ。\n' +
    '要件: 各提案は「## 提案N」「規約文（命令形1〜3文）」「根拠となった事例番号」の形式。' +
    '既存規約の言い換えは提案しない。最大5件。\n\n' +
    '現行の憲法:\n' + loadConstitution_().slice(0, 20000) + '\n\n低評価事例:\n' + cases;

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

  if (!stage('正規化', function () {
    const n = normalizeRequest('スプレッドシートAのB列を合計してC1に書くGAS関数を書いて');
    return 'objective: ' + n.objective;
  })) return results;

  stage('整理（パケット生成）', function () {
    const r = uiOrganize('FizzBuzzを出力するGAS関数を書いて。完了条件: 1〜15の出力例をログに含める。');
    return 'status: ' + r.status + (r.logRow ? ' / ログ行: ' + r.logRow : '') +
      (r.packet ? ' / パケット ' + r.packet.length + ' 文字' : '');
  });

  Logger.log('=== testPipeline 終了 ===');
  return results;
}
