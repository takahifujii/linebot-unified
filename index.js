import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);
const app = express();

const INVENTORY_API_URL = process.env.INVENTORY_API_URL;
const INVENTORY_API_TOKEN = process.env.INVENTORY_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_LINE_USER_IDS = process.env.ADMIN_LINE_USER_IDS || '';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ------------------------------------------
// PWA設定
// ------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(JSON.stringify({
    name: 'E!stocks',
    short_name: 'E!stocks',
    start_url: '/inventory',
    display: 'standalone',
    background_color: '#0b1636',
    theme_color: '#7c74ff',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }));
});

app.get('/icon-192.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-192.png'));
});

app.get('/icon-512.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-512.png'));
});

// ------------------------------------------
// 共通ヘルパー
// ------------------------------------------
function requireEnv(name, value) {
  if (!value) {
    throw new Error(`${name} が未設定です`);
  }
}

function normalizeQuery(text) {
  return String(text || '')
    .replace(/[　\s]+/g, ' ')
    .trim();
}

function isAdminUser(userId) {
  const adminIds = ADMIN_LINE_USER_IDS
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  return adminIds.includes(userId);
}

function parseAdditionCommand(text) {
  const normalized = String(text || '').trim();

  if (!normalized.startsWith('補足登録:') && !normalized.startsWith('補足登録：')) {
    return null;
  }

  const body = normalized.replace(/^補足登録[:：]/, '').trim();
  if (!body) return null;

  const lines = body.split('\n').map((v) => v.trim()).filter(Boolean);

  if (lines.length === 1) {
    return {
      title: 'LINE補足登録',
      content: lines[0],
    };
  }

  return {
    title: lines[0] || 'LINE補足登録',
    content: lines.slice(1).join('\n'),
  };
}

async function callInventoryGet(action, extraParams = {}) {
  requireEnv('INVENTORY_API_URL', INVENTORY_API_URL);
  requireEnv('INVENTORY_API_TOKEN', INVENTORY_API_TOKEN);

  const response = await axios.get(INVENTORY_API_URL, {
    params: {
      token: INVENTORY_API_TOKEN,
      action,
      ...extraParams,
    },
    timeout: 30000,
  });

  return response.data;
}

async function callInventoryPost(action, payload = {}) {
  requireEnv('INVENTORY_API_URL', INVENTORY_API_URL);
  requireEnv('INVENTORY_API_TOKEN', INVENTORY_API_TOKEN);

  const response = await axios.post(
    INVENTORY_API_URL,
    {
      token: INVENTORY_API_TOKEN,
      action,
      payload,
    },
    {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data;
}

function unwrapGasResponse(gasResponse) {
  if (!gasResponse) {
    throw new Error('GASから応答がありません');
  }

  if (gasResponse.status === 'error') {
    const msg =
      typeof gasResponse.data === 'string'
        ? gasResponse.data
        : JSON.stringify(gasResponse.data);

    throw new Error(msg || 'GASエラー');
  }

  return gasResponse.data;
}

// ------------------------------------------
// 会話履歴ヘルパー
// ------------------------------------------
async function getConversationHistory(userId, limit = 6) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SECRET_KEY', SUPABASE_SECRET_KEY);

  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];

  return rows
    .reverse()
    .map((row) => ({
      role: row.role,
      content: row.content,
    }))
    .filter((row) => row.role && row.content);
}

async function saveConversationTurn(userId, role, content) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SECRET_KEY', SUPABASE_SECRET_KEY);

  const { error } = await supabase
    .from('conversation_history')
    .insert([
      {
        user_id: userId,
        role,
        content,
      },
    ]);

  if (error) {
    throw error;
  }
}

// ------------------------------------------
// RAG / Knowledge Search Helpers
// ------------------------------------------
async function createQuestionEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });

  return response.data[0].embedding;
}

function expandKnowledgeQueries(message) {
  const base = normalizeQuery(message);
  const queries = new Set();

  if (!base) return [];

  queries.add(base);
  queries.add(`${base} 現調`);
  queries.add(`${base} 確認事項`);
  queries.add(`${base} 測り方`);
  queries.add(`${base} 寸法`);

  if (base.includes('トイレ')) {
    queries.add(`${base} 排水`);
    queries.add(`${base} 排水位置`);
    queries.add(`${base} 床排水 壁排水`);
  }

  if (base.includes('排水芯')) {
    queries.add(base.replace(/排水芯/g, '排水位置'));
    queries.add(base.replace(/排水芯/g, '芯寸法'));
    queries.add(base.replace(/排水芯/g, '床排水 壁排水'));
    queries.add(`${base} 品番 キャップ`);
  }

  if (base.includes('現調') || base.includes('現場調査')) {
    queries.add(`${base} チェックポイント`);
    queries.add(`${base} 注意点`);
  }

  return Array.from(queries).slice(0, 8);
}

async function searchKnowledge(message, matchCount = 8, minSimilarity = 0.65) {
  const queries = expandKnowledgeQueries(message);
  const allRows = [];

  for (const q of queries) {
    const embedding = await createQuestionEmbedding(q);

    const { data, error } = await supabase.rpc('match_all_knowledge', {
      query_embedding: embedding,
      match_count: matchCount,
    });

    if (error) {
      throw error;
    }

    if (Array.isArray(data)) {
      allRows.push(
        ...data.map((row) => ({
          ...row,
          search_query: q,
        }))
      );
    }
  }

  const dedupedMap = new Map();

  for (const row of allRows) {
    const key = `${row.source_type || 'unknown'}-${row.id}`;
    const current = dedupedMap.get(key);

    if (!current) {
      dedupedMap.set(key, row);
      continue;
    }

    const currentSim =
      typeof current.similarity === 'number' ? current.similarity : -1;
    const rowSim =
      typeof row.similarity === 'number' ? row.similarity : -1;

    if (rowSim > currentSim) {
      dedupedMap.set(key, row);
    }
  }

  return Array.from(dedupedMap.values())
    .filter((row) => {
      if (typeof row.similarity !== 'number') return true;
      return row.similarity >= minSimilarity;
    })
    .sort((a, b) => {
      const aSim = typeof a.similarity === 'number' ? a.similarity : -1;
      const bSim = typeof b.similarity === 'number' ? b.similarity : -1;
      return bSim - aSim;
    })
    .slice(0, 10);
}

function buildKnowledgeContext(results) {
  if (!results || results.length === 0) {
    return '今回の検索では、関連する教科書データを十分に特定できませんでした。教科書に載っていないとは断定せず、関連表現も含めて慎重に回答してください。';
  }

  return results
    .map((row, index) => {
      const title = row.title || '無題';
      const content = row.content || '';
      const similarity =
        typeof row.similarity === 'number'
          ? row.similarity.toFixed(4)
          : 'n/a';
      const searchQuery = row.search_query || 'n/a';
      const sourceType = row.source_type || 'unknown';

      return [
        `【根拠資料${index + 1}】`,
        `資料名: ${title}`,
        `種類: ${sourceType}`,
        `関連度: ${similarity}`,
        `ヒットした検索語: ${searchQuery}`,
        `以下は原文抜粋:`,
        content,
      ].join('\n');
    })
    .join('\n\n====================\n\n');
}

async function saveKnowledgeAddition({ title, content, createdBy }) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SECRET_KEY', SUPABASE_SECRET_KEY);

  const embedding = await createQuestionEmbedding(content);

  const { error } = await supabase
    .from('knowledge_additions')
    .insert([
      {
        title,
        content,
        metadata: {
          source: 'line_addition',
        },
        embedding,
        created_by: createdBy,
        is_active: true,
      },
    ]);

  if (error) {
    throw error;
  }
}

// ------------------------------------------
// GPTに問い合わせる関数
// ------------------------------------------
async function getGptResponse(message, history = []) {
  requireEnv('OPENAI_API_KEY', OPENAI_API_KEY);
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SECRET_KEY', SUPABASE_SECRET_KEY);

  const knowledgeResults = await searchKnowledge(message, 8, 0.65);
  const knowledgeContext = buildKnowledgeContext(knowledgeResults);

  const systemPrompt = `
あなたはリフォーム工房アントレの社内AIサポートキャラクター「ねじーくん」です。
社員に対して、親しみやすく丁寧に、語尾に「だじ〜」「だじ！」をつけて話してください。
以下の社内業務ルール・用語集・教科書データに基づいて、新人社員の質問にやさしく自然に答えてください。
口調は常に前向きで、指導的でありながらも応援するスタンスでお願いします。

【最重要ルール】
- 回答は、まず「教科書データ」を最優先で根拠にすること
- 教科書に十分な根拠がない場合は、推測しすぎず「教科書上では確認できない」と明示すること
- 会話履歴は参考にしてよいが、履歴よりも教科書データの根拠を優先すること
- 教科書に書いていないことを勝手に断定しないこと
- 危険がある施工・電気・ガス・法規関係は断定しすぎず、必要なら有資格者確認を促すこと
- 専門用語は新人にもわかるように補足すること
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'system',
        content: `以下は今回参照すべき教科書データです。必ずこの内容を優先して答えてください。\n\n${knowledgeContext}`,
      },
      ...history,
      { role: 'user', content: message },
    ],
    temperature: 0.2,
  });

  return response.choices[0].message.content || 'うまく答えを作れなかっただじ〜';
}

// ------------------------------------------
// LINEのメッセージ処理
// ------------------------------------------
async function handleEvent(event) {
  console.log('🔥 イベント受信:', JSON.stringify(event, null, 2));

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userId = event?.source?.userId || 'unknown';
  const userMessage = event.message.text;

  try {
    const addition = parseAdditionCommand(userMessage);

    if (addition) {
      if (!isAdminUser(userId)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '補足登録は管理者のみ使えるだじ〜。',
        });
      }

      await saveKnowledgeAddition({
        title: addition.title,
        content: addition.content,
        createdBy: userId,
      });

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '補足知識を登録しただじ〜！次回から検索対象に入るだじ！',
      });
    }

    const history = await getConversationHistory(userId, 6);
    const gptReply = await getGptResponse(userMessage, history);

    await saveConversationTurn(userId, 'user', userMessage);
    await saveConversationTurn(userId, 'assistant', gptReply);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: gptReply.slice(0, 5000),
    });
  } catch (err) {
    console.error('handleEvent Error:', err?.response?.data || err.message || err);

    try {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ごめんだじ〜。今ちょっと調子が悪いだじ〜。',
      });
    } catch (replyErr) {
      console.error('LINE reply fallback Error:', replyErr?.response?.data || replyErr.message || replyErr);
      return null;
    }
  }
}

// ------------------------------------------
// Webhook
// ------------------------------------------
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    req.body.events.forEach((event) => {
      console.log('★受信したuserId:', event?.source?.userId || 'unknown');
    });

    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook Error:', err?.response?.data || err.message || err);
    res.status(500).end();
  }
});

// webhook の後で JSON を有効化
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ------------------------------------------
// GPTテストAPI
// ------------------------------------------
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const reply = await getGptResponse(message || '', []);
    res.json({ reply });
  } catch (err) {
    console.error('Chat API Error:', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'エラーだじ〜' });
  }
});

// ------------------------------------------
// root / health / logtest
// ------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <h1>Hello World from LINE GPT Bot + Inventory App!</h1>
    <ul>
      <li><a href="/inventory">/inventory</a> 在庫管理画面</li>
      <li><a href="/health">/health</a> ヘルスチェック</li>
      <li><a href="/logtest">/logtest</a> ログテスト</li>
    </ul>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'linebot-inventory-unified',
    hasLineToken: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
    hasLineSecret: !!process.env.LINE_CHANNEL_SECRET,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasSupabaseSecret: !!process.env.SUPABASE_SECRET_KEY,
    hasAdminLineUserIds: !!ADMIN_LINE_USER_IDS,
    inventoryApiConfigured: !!INVENTORY_API_URL && !!INVENTORY_API_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.get('/logtest', (req, res) => {
  console.log('🧪 ログ出力テスト成功！');
  res.send('ログ出力したよ！');
});

// ------------------------------------------
// 在庫API（認証なしに戻す）
// ------------------------------------------
app.get('/api/items', async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getItems');
    const items = unwrapGasResponse(gasResponse);
    res.json(items);
  } catch (err) {
    console.error('GET /api/items Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫一覧の取得に失敗しました' });
  }
});

app.get('/api/items/:id', async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getItem', { id: req.params.id });
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('GET /api/items/:id Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫詳細の取得に失敗しました' });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const itemId = req.query.item_id || '';
    const gasResponse = await callInventoryGet('getLogs', itemId ? { item_id: itemId } : {});
    const logs = unwrapGasResponse(gasResponse);
    res.json(logs);
  } catch (err) {
    console.error('GET /api/logs Error:', err.message || err);
    res.status(500).json({ error: err.message || 'ログの取得に失敗しました' });
  }
});

app.get('/api/master', async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getMasters');
    const master = unwrapGasResponse(gasResponse);
    res.json(master);
  } catch (err) {
    console.error('GET /api/master Error:', err.message || err);
    res.status(500).json({ error: err.message || 'マスタ取得に失敗しました' });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.body?.user || 'Unknown',
    };

    const gasResponse = await callInventoryPost('createItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫登録に失敗しました' });
  }
});

app.post('/api/items/update', async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.body?.user || 'Unknown',
    };

    const gasResponse = await callInventoryPost('updateItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/update Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫更新に失敗しました' });
  }
});

app.post('/api/items/use', async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.body?.user || 'Unknown',
    };

    const gasResponse = await callInventoryPost('consumeItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/use Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫消費に失敗しました' });
  }
});

app.post('/api/items/archive', async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.body?.user || 'Unknown',
    };

    const gasResponse = await callInventoryPost('archiveItem', payload);
    const result = unwrapGasResponse(gasResponse);
    res.json(result);
  } catch (err) {
    console.error('POST /api/items/archive Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫アーカイブに失敗しました' });
  }
});

app.post('/api/items/init', async (req, res) => {
  try {
    const gasResponse = await callInventoryPost('init', {});
    const result = unwrapGasResponse(gasResponse);
    res.json(result);
  } catch (err) {
    console.error('POST /api/items/init Error:', err.message || err);
    res.status(500).json({ error: err.message || '初期化に失敗しました' });
  }
});

// ------------------------------------------
// スマホ向け在庫管理画面
// ------------------------------------------
app.get('/inventory', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>E!stocks</title>
  <meta name="theme-color" content="#7c74ff" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <style>
    :root{
      --bg:#0b1636;
      --card:#1e2b4b;
      --text:#ffffff;
      --muted:#aab4cc;
      --line:#33476d;
      --accent:#7c74ff;
      --danger:#ff7a7a;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:linear-gradient(180deg,var(--bg) 0%, #09122f 100%);
      color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif;
    }
    .wrap{max-width:760px;margin:0 auto;padding:16px}
    .title{font-size:28px;font-weight:900;margin:8px 0 4px;color:var(--accent)}
    .sub{color:var(--muted);margin-bottom:16px}
    .card{
      background:rgba(31,46,78,0.92);
      border:1px solid rgba(255,255,255,0.06);
      border-radius:20px;
      padding:14px;
      margin-bottom:14px;
    }
    .row{display:flex;gap:10px;flex-wrap:wrap}
    input,select,button{
      font:inherit;
    }
    input,select{
      width:100%;
      border:1px solid var(--line);
      background:#202d4a;
      color:#fff;
      border-radius:14px;
      padding:12px;
    }
    button{
      border:none;
      border-radius:14px;
      padding:12px 16px;
      background:var(--accent);
      color:#fff;
      font-weight:800;
      cursor:pointer;
    }
    button.secondary{
      background:#dfe4ee;
      color:#17223c;
    }
    button.danger{
      background:#ffe3e3;
      color:#cc4e4e;
    }
    .grid2{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
    }
    .item{
      display:flex;
      gap:12px;
      align-items:flex-start;
    }
    .thumb{
      width:84px;height:84px;border-radius:14px;overflow:hidden;background:#263553;
      display:flex;align-items:center;justify-content:center;color:#9eabc5;font-size:12px;
      flex:0 0 auto;
    }
    .thumb img{width:100%;height:100%;object-fit:cover;display:block}
    .name{font-size:18px;font-weight:900;margin-bottom:4px}
    .muted{font-size:12px;color:var(--muted)}
    .chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
    .chip{
      background:#2b3a5b;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:700;
    }
    .qty{font-size:28px;font-weight:900;color:var(--accent)}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .empty{text-align:center;color:var(--muted);padding:24px}
    .photoPreview{
      width:100%;
      max-height:220px;
      object-fit:cover;
      border-radius:14px;
      display:none;
      margin-top:10px;
    }
    @media (max-width: 640px){
      .grid2{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="title">在庫管理</div>
    <div class="sub">リフォーム工房アントレ 在庫アプリ</div>

    <div class="card">
      <div class="row">
        <input id="searchInput" placeholder="品名・カテゴリ・場所を検索" />
        <button id="reloadBtn">更新</button>
      </div>
    </div>

    <div class="card">
      <div style="font-weight:900;margin-bottom:12px;">新規登録</div>
      <div class="grid2">
        <input id="name" placeholder="品名" />
        <input id="location" placeholder="保管場所" />
      </div>
      <div class="grid2" style="margin-top:10px;">
        <input id="category_l" placeholder="大分類" />
        <input id="category_m" placeholder="中分類" />
      </div>
      <div class="grid2" style="margin-top:10px;">
        <input id="category_s" placeholder="小分類" />
        <input id="qty" type="number" value="1" placeholder="数量" />
      </div>
      <div class="grid2" style="margin-top:10px;">
        <input id="unit" value="個" placeholder="単位" />
        <input id="threshold" type="number" placeholder="要発注ライン" />
      </div>
      <div style="margin-top:10px;">
        <input id="note" placeholder="メモ" />
      </div>
      <div style="margin-top:10px;">
        <input id="user" placeholder="投稿者名" value="藤井" />
      </div>
      <div style="margin-top:10px;">
        <input id="photoInput" type="file" accept="image/*" />
        <img id="photoPreview" class="photoPreview" />
      </div>
      <div class="row" style="margin-top:12px;">
        <button id="createBtn">登録する</button>
      </div>
    </div>

    <div id="itemsContainer"></div>
  </div>

  <script>
    let allItems = [];
    let selectedPhotoBase64 = '';

    const els = {
      searchInput: document.getElementById('searchInput'),
      reloadBtn: document.getElementById('reloadBtn'),
      itemsContainer: document.getElementById('itemsContainer'),
      name: document.getElementById('name'),
      location: document.getElementById('location'),
      categoryL: document.getElementById('category_l'),
      categoryM: document.getElementById('category_m'),
      categoryS: document.getElementById('category_s'),
      qty: document.getElementById('qty'),
      unit: document.getElementById('unit'),
      threshold: document.getElementById('threshold'),
      note: document.getElementById('note'),
      user: document.getElementById('user'),
      photoInput: document.getElementById('photoInput'),
      photoPreview: document.getElementById('photoPreview'),
      createBtn: document.getElementById('createBtn'),
    };

    function safeText(v) {
      return v == null ? '' : String(v);
    }

    function escapeHtml(v) {
      return safeText(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function apiFetch(url, options = {}) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '通信エラー');
      if (data && data.error) throw new Error(data.error);
      return data;
    }

    function extractDriveFileId(url) {
      const raw = safeText(url).trim();
      if (!raw) return '';
      const fileMatch = raw.match(/\\/file\\/d\\/([^/]+)/);
      if (fileMatch && fileMatch[1]) return fileMatch[1];
      const idMatch = raw.match(/[?&]id=([^&]+)/);
      if (idMatch && idMatch[1]) return idMatch[1];
      return '';
    }

    function buildDriveImageCandidates(url) {
      const raw = safeText(url).trim();
      if (!raw) return [];
      const id = extractDriveFileId(raw);
      if (!id) return [raw];
      return [
        'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000',
        'https://drive.google.com/uc?export=view&id=' + id,
        'https://drive.google.com/uc?id=' + id
      ];
    }

    function getPhotoUrls(item) {
      if (!item.photo_urls) return [];
      return safeText(item.photo_urls)
        .split(',')
        .map(v => safeText(v).trim())
        .filter(Boolean);
    }

    function renderItems() {
      const q = safeText(els.searchInput.value).trim().toLowerCase();
      const filtered = allItems.filter((item) => {
        if (!q) return true;
        const hay = [
          item.name,
          item.category_l,
          item.category_m,
          item.category_s,
          item.location,
          item.status
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });

      if (!filtered.length) {
        els.itemsContainer.innerHTML = '<div class="card empty">在庫がありません。</div>';
        return;
      }

      let html = '';

      filtered.forEach((item) => {
        const photos = getPhotoUrls(item);
        let thumbHtml = '画像なし';

        if (photos.length > 0) {
          const cands = buildDriveImageCandidates(photos[0]);
          const c0 = escapeHtml(cands[0] || '');
          thumbHtml = '<img src="' + c0 + '" alt="' + escapeHtml(item.name || '') + '">';
        }

        const chips = [item.category_l, item.category_m, item.category_s, item.location]
          .map(v => safeText(v).trim())
          .filter(Boolean)
          .map(v => '<span class="chip">' + escapeHtml(v) + '</span>')
          .join('');

        html += '<div class="card">';
        html += '  <div class="item">';
        html += '    <div class="thumb">' + thumbHtml + '</div>';
        html += '    <div style="flex:1;min-width:0">';
        html += '      <div class="name">' + escapeHtml(item.name || '') + '</div>';
        html += '      <div class="muted">状態: ' + escapeHtml(item.status || '') + '</div>';
        html += '      <div class="chips">' + chips + '</div>';
        html += '      <div class="qty">' + escapeHtml(item.qty || 0) + ' ' + escapeHtml(item.unit || '') + '</div>';
        html += '      <div class="actions">';
        html += '        <button class="secondary" onclick="editItem(\\'' + escapeHtml(item.item_id) + '\\')">編集</button>';
        html += '        <button onclick="consumeItem(\\'' + escapeHtml(item.item_id) + '\\', \\''
              + escapeHtml(item.name || '') + '\\')">消費</button>';
        html += '      </div>';
        html += '    </div>';
        html += '  </div>';
        html += '</div>';
      });

      els.itemsContainer.innerHTML = html;
    }

    async function loadItems() {
      const data = await apiFetch('/api/items');
      if (!Array.isArray(data)) {
        throw new Error('在庫データの取得に失敗しました');
      }
      allItems = data;
      renderItems();
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function createItem() {
      try {
        const payload = {
          name: els.name.value.trim(),
          category_l: els.categoryL.value.trim(),
          category_m: els.categoryM.value.trim(),
          category_s: els.categoryS.value.trim(),
          location: els.location.value.trim(),
          qty: Number(els.qty.value || 0),
          unit: els.unit.value.trim() || '個',
          threshold: els.threshold.value === '' ? '' : Number(els.threshold.value || 0),
          note: els.note.value.trim() || '在庫登録',
          addIfSameName: true,
          photo_base64: selectedPhotoBase64 || '',
          user: els.user.value.trim() || 'Unknown'
        };

        if (!payload.name) {
          alert('品名を入力してください');
          return;
        }
        if (!payload.location) {
          alert('保管場所を入力してください');
          return;
        }

        await apiFetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        alert('登録しました');

        els.name.value = '';
        els.categoryL.value = '';
        els.categoryM.value = '';
        els.categoryS.value = '';
        els.location.value = '';
        els.qty.value = '1';
        els.unit.value = '個';
        els.threshold.value = '';
        els.note.value = '';
        els.photoInput.value = '';
        selectedPhotoBase64 = '';
        els.photoPreview.style.display = 'none';
        els.photoPreview.src = '';

        await loadItems();
      } catch (err) {
        alert(err.message || '登録に失敗しました');
      }
    }

    async function consumeItem(itemId, itemName) {
      const qty = prompt(itemName + ' の消費数を入力してください', '1');
      if (qty == null) return;

      const note = prompt('メモを入力してください', '使用・消費');
      if (note == null) return;

      try {
        await apiFetch('/api/items/use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: itemId,
            consume_qty: Number(qty || 0),
            note: note || '使用・消費',
            user: els.user.value.trim() || 'Unknown'
          })
        });

        await loadItems();
      } catch (err) {
        alert(err.message || '消費処理に失敗しました');
      }
    }

    async function editItem(itemId) {
      try {
        const item = await apiFetch('/api/items/' + encodeURIComponent(itemId));

        const name = prompt('品名', item.name || '');
        if (name == null) return;
        const location = prompt('保管場所', item.location || '');
        if (location == null) return;
        const categoryL = prompt('大分類', item.category_l || '');
        if (categoryL == null) return;
        const categoryM = prompt('中分類', item.category_m || '');
        if (categoryM == null) return;
        const categoryS = prompt('小分類', item.category_s || '');
        if (categoryS == null) return;
        const unit = prompt('単位', item.unit || '個');
        if (unit == null) return;
        const threshold = prompt('要発注ライン', item.threshold == null ? '' : item.threshold);
        if (threshold == null) return;

        await apiFetch('/api/items/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: itemId,
            name: name.trim(),
            location: location.trim(),
            category_l: categoryL.trim(),
            category_m: categoryM.trim(),
            category_s: categoryS.trim(),
            unit: unit.trim() || '個',
            threshold: threshold === '' ? '' : Number(threshold || 0),
            note: '在庫情報更新',
            user: els.user.value.trim() || 'Unknown'
          })
        });

        await loadItems();
      } catch (err) {
        alert(err.message || '更新に失敗しました');
      }
    }

    els.searchInput.addEventListener('input', renderItems);
    els.reloadBtn.addEventListener('click', () => {
      loadItems().catch((err) => alert(err.message || '更新に失敗しました'));
    });
    els.createBtn.addEventListener('click', createItem);

    els.photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      try {
        selectedPhotoBase64 = await fileToBase64(file);
        els.photoPreview.src = selectedPhotoBase64;
        els.photoPreview.style.display = 'block';
      } catch {
        alert('画像の読み込みに失敗しました');
      }
    });

    window.consumeItem = consumeItem;
    window.editItem = editItem;

    loadItems().catch((err) => {
      document.getElementById('itemsContainer').innerHTML =
        '<div class="card empty">読み込みに失敗しました<br>' +
        escapeHtml(err.message || '') +
        '</div>';
    });
  </script>
</body>
</html>
  `);
});

// ------------------------------------------
// ポート
// ------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Server is running on port ＋　PORT`);
});
