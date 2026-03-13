import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ------------------------------------------
// PWA設定
// ------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(JSON.stringify({
    name: 'E!stockS',
    short_name: 'E!stockS',
    start_url: '/inventory',
    display: 'standalone',
    background_color: '#0b1636',
    theme_color: '#7c74ff',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
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
// GPTに問い合わせる関数（RAG対応版）
// ------------------------------------------
async function getGptResponse(message) {
  requireEnv('OPENAI_API_KEY', OPENAI_API_KEY);
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SECRET_KEY', SUPABASE_SECRET_KEY);

  const knowledgeResults = await searchKnowledge(message, 5);
  const knowledgeContext = buildKnowledgeContext(knowledgeResults);

  const systemPrompt = `
あなたはリフォーム工房アントレの社内AIサポートキャラクター「ねじーくん」です。
社員に対して、親しみやすく丁寧に、語尾に「だじ〜」「だじ！」をつけて話してください。
口調は常に前向きで、指導的でありながらも応援するスタンスでお願いします。

【あなたの役割】
- 社内向けの新人教育アシスタントとして振る舞うこと
- 回答は、できる限り「教科書データ」を根拠にして行うこと
- 教科書に十分な根拠がない場合は、推測しすぎず「教科書上では確認できない」と明示すること
- 必要に応じて、確認すべき点・追加ヒアリング項目・現場での注意点を箇条書きで整理すること
- 専門用語は新人にもわかるように補足すること

【必ず守ること】
- 以下の「教科書データ」を最優先で参照すること
- 教科書に書いてあることを勝手にねじ曲げないこと
- 不明点は不明と言うこと
- 危険がある施工・電気・ガス・法規関係は断定しすぎず、必要なら有資格者確認を促すこと

【現調キーワードへの特別対応】
ユーザーが「現調」「現場調査」「下見」などを聞いている場合は、
回答の最後に「現調で追加確認したい項目」を整理して添えること。

【見積・粗利・社内計算ルール】
以下のルールは社内固定ルールとして扱ってください。

● 商品に対する粗利率は 30％
→ 原価 ÷ 0.7 ＝ 売価

● 工事に対する粗利率は 32.5％
→ 原価 ÷ 0.675 ＝ 売価

● 定価と仕入率がわかっているときは：
定価 × 仕入率 ÷ 粗利係数（0.7または0.675）で売価を出す

● 販売価格が定価の何％になるかは：
仕入率 ÷ 粗利係数

● 割引率は：
100％ − 販売率
四捨五入でOK

【ベテラン案内】
新人さんが誰を頼ったらいいか迷ったら、
- コーディネートや設計に関して…武田さん
- 工事の方法や段取りについて…白岩店長
- いなかったらどんどん藤井社長にきいてほしい
と案内してください。

【教科書データ】
${knowledgeContext}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
    temperature: 0.4,
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

  const userMessage = event.message.text;
  const gptReply = await getGptResponse(userMessage);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: gptReply,
  });
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

// webhookより後でJSONを有効化
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ------------------------------------------
// GPTテストAPI
// ------------------------------------------
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    const reply = await getGptResponse(message || '');
    res.json({ reply });
  } catch (err) {
    console.error('Chat API Error:', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'エラーだじ〜' });
  }
});

// ------------------------------------------
// 在庫API
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
    const gasResponse = await callInventoryPost('createItem', req.body);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫登録に失敗しました' });
  }
});

app.post('/api/items/update', async (req, res) => {
  try {
    const gasResponse = await callInventoryPost('updateItem', req.body);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/update Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫更新に失敗しました' });
  }
});

app.post('/api/items/use', async (req, res) => {
  try {
    const gasResponse = await callInventoryPost('consumeItem', req.body);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/use Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫消費に失敗しました' });
  }
});

app.post('/api/items/archive', async (req, res) => {
  try {
    const gasResponse = await callInventoryPost('archiveItem', req.body);
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
  <meta name="viewport" content="width=device-width, initial-scale=0.7, viewport-fit=cover" />
  <title>E!stocks</title>
  <meta name="theme-color" content="#7c74ff" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="E!stockS" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <style>
  body {
  font-size:10px;
}
    :root{
      --bg:#0b1636;
      --card:#1e2b4b;
      --card2:#223150;
      --text:#ffffff;
      --muted:#aab4cc;
      --line:#33476d;
      --accent:#7c74ff;
      --accent2:#9b96ff;
      --danger:#ff7a7a;
      --shadow:0 10px 24px rgba(0,0,0,0.26);
    }
    *{ box-sizing:border-box; }
    html,body{
      margin:0;
      padding:0;
      background:linear-gradient(180deg,var(--bg) 0%, #09122f 100%);
      color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif;
    }
    body{
      min-height:100vh;
      padding-bottom:110px;
    }
    .app{
      max-width:720px;
      margin:0 auto;
      min-height:100vh;
    }
    .topbar{
      position:sticky;
      top:0;
      z-index:20;
      background:rgba(30,43,75,0.95);
      backdrop-filter:blur(10px);
      border-bottom:1px solid rgba(255,255,255,0.08);
      padding:18px 16px 14px;
    }
    .topbar-row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .title{
      font-size:26px;
      font-weight:900;
      color:var(--accent);
      letter-spacing:0.02em;
    }
    .title-sub{
      margin-top:4px;
      font-size:12px;
      color:var(--muted);
    }
    .round-btn{
      border:none;
      width:64px;
      height:64px;
      border-radius:50%;
      background:#1b2744;
      color:#fff;
      font-size:28px;
      cursor:pointer;
      box-shadow:var(--shadow);
      flex:0 0 auto;
    }
    .content{
      padding:14px 14px 0;
    }
    .search-card{
      margin-bottom:14px;
    }
    .search-input{
      width:100%;
      border:1px solid var(--line);
      background:var(--card);
      color:#fff;
      border-radius:18px;
      padding:14px 16px;
      font-size:17px;
      outline:none;
    }
    .search-input::placeholder{
      color:#9ea8bf;
    }
    .tabs-wrap{
      overflow-x:auto;
      -webkit-overflow-scrolling:touch;
      scrollbar-width:none;
      margin-bottom:14px;
    }
    .tabs-wrap::-webkit-scrollbar{ display:none; }
    .tabs{
      display:flex;
      gap:10px;
      min-width:max-content;
      padding:0 2px;
    }
    .tab{
      border:none;
      background:#202d4a;
      color:#dfe6f6;
      border:1px solid #32435f;
      border-radius:999px;
      padding:10px 16px;
      font-size:15px;
      font-weight:700;
      white-space:nowrap;
      cursor:pointer;
    }
    .tab.active{
      background:var(--accent);
      color:#fff;
      border-color:var(--accent);
      box-shadow:0 8px 16px rgba(124,116,255,0.30);
    }
    .screen{ display:none; }
    .screen.active{ display:block; }
    .items{
      display:flex;
      flex-direction:column;
      gap:14px;
    }
    .item-card{
      background:rgba(31,46,78,0.92);
      border:1px solid rgba(255,255,255,0.06);
      border-radius:24px;
      padding:14px;
      box-shadow:var(--shadow);
      display:flex;
      gap:14px;
      align-items:flex-start;
    }
    .thumb-box{
      width:96px;
      min-width:96px;
      height:96px;
      border-radius:18px;
      overflow:hidden;
      background:#263553;
      display:flex;
      align-items:center;
      justify-content:center;
      color:#9eabc5;
      font-size:12px;
      text-align:center;
      border:1px solid rgba(255,255,255,0.06);
    }
    .thumb-box img{
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
    }
    .item-main{
      flex:1;
      min-width:0;
    }
    .item-name{
      font-size:17px;
      font-weight:900;
      line-height:1.35;
      margin-bottom:6px;
      word-break:break-word;
    }
    .item-meta{
      font-size:12px;
      color:var(--muted);
      margin-bottom:8px;
    }
    .chips{
      display:flex;
      flex-wrap:wrap;
      gap:6px;
      margin-bottom:10px;
    }
    .chip{
      background:#2b3a5b;
      color:#e7ecf8;
      border-radius:999px;
      padding:6px 10px;
      font-size:12px;
      font-weight:700;
    }
    .qty-row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      flex-wrap:wrap;
    }
    .qty-box{
      display:flex;
      align-items:baseline;
      gap:4px;
      color:var(--accent);
    }
    .qty-num{
      font-size:32px;
      font-weight:900;
      line-height:1;
    }
    .qty-unit{
      font-size:15px;
      font-weight:800;
    }
    .item-actions{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .btn{
      border:none;
      border-radius:999px;
      padding:10px 16px;
      cursor:pointer;
      font-size:14px;
      font-weight:800;
    }
    .btn-primary{
      background:var(--accent);
      color:#fff;
      box-shadow:0 8px 16px rgba(124,116,255,0.26);
    }
    .btn-secondary{
      background:#dfe4ee;
      color:#17223c;
    }
    .btn-danger{
      background:#ffe3e3;
      color:#cc4e4e;
    }
    .empty{
      background:#1d2946;
      border-radius:22px;
      padding:32px 20px;
      text-align:center;
      color:var(--muted);
      border:1px solid rgba(255,255,255,0.06);
    }
    .section-title{
      font-size:20px;
      font-weight:900;
      margin:10px 0 16px;
      color:var(--accent);
    }
    .field{
      margin-bottom:14px;
    }
    .field label{
      display:block;
      font-size:14px;
      font-weight:800;
      margin-bottom:8px;
      color:#ffffff;
    }
    .field .sub{
      color:var(--muted);
      font-weight:600;
      font-size:12px;
      margin-left:4px;
    }
    .input,
    .select{
      width:100%;
      border:1px solid #33476d;
      background:#202d4a;
      color:#fff;
      border-radius:20px;
      padding:16px 16px;
      font-size:16px;
      outline:none;
      appearance:none;
    }
    .input::placeholder{
      color:#98a6c2;
    }
    .grid-2{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:14px;
    }
    .inline-row{
      display:flex;
      gap:12px;
      align-items:flex-end;
    }
    .inline-row .grow{
      flex:1;
    }
    .inline-link-btn{
      border:none;
      background:none;
      color:var(--accent);
      font-size:16px;
      font-weight:900;
      cursor:pointer;
      white-space:nowrap;
      padding:0 4px 14px;
    }
    .photo-zone{
      border:2px dashed #3a4f78;
      background:#1f2c47;
      border-radius:28px;
      min-height:220px;
      display:flex;
      align-items:center;
      justify-content:center;
      text-align:center;
      color:#9ba8c5;
      padding:12px;
      overflow:hidden;
      cursor:pointer;
      margin-bottom:18px;
    }
    .photo-zone img{
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
      border-radius:22px;
    }
    .photo-zone-inner{
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:10px;
      font-size:18px;
      font-weight:800;
    }
    .photo-zone-icon{
      font-size:52px;
      line-height:1;
    }
    .toggle-row{
      display:flex;
      align-items:center;
      gap:10px;
      margin:8px 0 18px;
      font-size:16px;
      font-weight:800;
    }
    .toggle-row input{
      width:28px;
      height:28px;
      accent-color:var(--accent);
    }
    .submit-btn{
      width:100%;
      border:none;
      background:var(--accent);
      color:#fff;
      border-radius:999px;
      padding:16px 18px;
      font-size:18px;
      font-weight:900;
      cursor:pointer;
      box-shadow:0 10px 18px rgba(124,116,255,0.28);
    }
    .bottom-nav{
      position:fixed;
      left:50%;
      transform:translateX(-50%);
      bottom:0;
      width:100%;
      max-width:720px;
      background:rgba(26,36,61,0.98);
      border-top:1px solid rgba(255,255,255,0.08);
      display:flex;
      justify-content:space-around;
      align-items:flex-end;
      padding:10px 10px calc(10px + env(safe-area-inset-bottom));
      z-index:25;
      backdrop-filter:blur(12px);
    }
    .nav-btn{
      border:none;
      background:none;
      color:#9eabc5;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      gap:6px;
      min-width:90px;
      font-size:14px;
      font-weight:800;
      cursor:pointer;
    }
    .nav-btn .icon{
      font-size:28px;
      line-height:1;
    }
    .nav-btn.active{
      color:#ffffff;
    }
    .nav-plus{
      width:78px;
      height:78px;
      border:none;
      border-radius:50%;
      background:var(--accent);
      color:#fff;
      font-size:42px;
      line-height:1;
      box-shadow:0 10px 24px rgba(124,116,255,0.34);
      margin-top:-34px;
      cursor:pointer;
      flex:0 0 auto;
    }
    .modal-backdrop{
      position:fixed;
      inset:0;
      background:rgba(6,10,20,0.66);
      display:none;
      align-items:center;
      justify-content:center;
      z-index:60;
      padding:18px;
    }
    .modal-backdrop.show{
      display:flex;
    }
    .modal{
      width:100%;
      max-width:520px;
      background:#16233f;
      border:1px solid rgba(255,255,255,0.08);
      border-radius:24px;
      padding:18px;
      box-shadow:0 20px 40px rgba(0,0,0,0.36);
    }
    .modal-head{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:14px;
    }
    .modal-title{
      font-size:20px;
      font-weight:900;
    }
    .close-btn{
      border:none;
      background:#253555;
      color:#fff;
      border-radius:999px;
      padding:8px 12px;
      cursor:pointer;
      font-weight:800;
    }
    .theme-grid{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:10px;
      margin-top:8px;
    }
    .theme-btn{
      border:2px solid transparent;
      border-radius:16px;
      height:52px;
      cursor:pointer;
    }
    .theme-btn.active{
      border-color:#fff;
    }
    .pin-title{
      font-size:24px;
      font-weight:900;
      text-align:center;
      margin-bottom:12px;
      color:var(--accent);
    }
    .pin-note{
      text-align:center;
      color:var(--muted);
      margin-bottom:18px;
    }
    .hidden{
      display:none !important;
    }
    @media (max-width:520px){
      .grid-2{ grid-template-columns:1fr; }
      .thumb-box{ width:86px; min-width:86px; height:86px; }
      .item-name{ font-size:16px; }
      .qty-num{ font-size:28px; }
      .title{ font-size:22px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="topbar-row">
        <div>
          <div class="title">在庫管理</div>
          <div class="title-sub">リフォーム工房アントレ 在庫アプリ</div>
        </div>
        <button class="round-btn" id="refreshBtn">↻</button>
      </div>
    </div>

    <div class="content">
      <div class="search-card" id="searchCard">
        <input id="searchInput" class="search-input" placeholder="品名・カテゴリ・場所を検索" />
      </div>

      <div class="tabs-wrap" id="tabsWrap">
        <div class="tabs" id="mainTabs"></div>
      </div>

      <div class="screen active" id="screenList">
        <div class="items" id="itemsContainer"></div>
      </div>

      <div class="screen" id="screenCreate">
        <div class="section-title">新規登録</div>

        <div class="field">
          <label>写真 <span class="sub">（任意）</span></label>
          <div class="photo-zone" id="photoZone">
            <div class="photo-zone-inner">
              <div class="photo-zone-icon">◉</div>
              <div>タップして撮影/選択</div>
            </div>
          </div>
          <input id="cameraInput" type="file" accept="image/*" capture="environment" style="display:none;" />
          <input id="photoInput" type="file" accept="image/*" style="display:none;" />
        </div>

        <div class="field">
          <label>品名 <span style="color:#ff7a7a;">*</span></label>
          <input id="name" class="input" placeholder="例：塩ビパイプ VP-20" />
        </div>

        <div class="grid-2">
          <div class="field">
            <label>カテゴリ</label>
            <select id="category_l" class="select"></select>
          </div>
          <div class="field">
            <label>保管場所 <span style="color:#ff7a7a;">*</span></label>
            <div class="inline-row">
              <div class="grow">
                <select id="locationSelect" class="select"></select>
              </div>
              <button type="button" class="inline-link-btn" id="addLocationBtn">＋追加</button>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <select id="category_m" class="select"></select>
          </div>
          <div class="field hidden" id="locationOtherWrap">
            <label>保管場所を追加</label>
            <input id="locationOther" class="input" placeholder="新しい保管場所" />
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <select id="category_s" class="select"></select>
          </div>
          <div class="field">
            <label>数量 <span style="color:#ff7a7a;">*</span></label>
            <input id="qty" class="input" type="number" value="1" />
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>単位</label>
            <input id="unit" class="input" value="個" />
          </div>
          <div class="field">
            <label>要発注ライン</label>
            <input id="threshold" class="input" type="number" placeholder="例：5" />
          </div>
        </div>

        <div class="toggle-row">
          <input id="addIfSameName" type="checkbox" checked />
          <label for="addIfSameName">同名があれば「加算」する</label>
        </div>

        <div class="field">
          <label>メモ</label>
          <input id="note" class="input" placeholder="例：まとめ買い" />
        </div>

        <button class="submit-btn" id="createBtn">登録する</button>
      </div>

      <div class="screen" id="screenAccount">
        <div class="section-title">アカウント / 設定</div>

        <div class="field">
          <label>投稿者名</label>
          <input id="settingPosterName" class="input" placeholder="例：藤井" />
        </div>

        <div class="field">
          <label>インターフェース色</label>
          <div class="theme-grid" id="themeGrid"></div>
        </div>

        <button class="submit-btn" id="saveSettingsBtn">設定を保存</button>

        <div style="height:18px;"></div>

        <div class="field">
          <label>PIN認証をリセット</label>
          <button class="btn btn-danger" style="width:100%; border-radius:18px; padding:14px 16px;" id="resetPinBtn">次回起動時にPINを再入力</button>
        </div>
      </div>
    </div>

    <div class="bottom-nav">
      <button class="nav-btn active" id="navList">
        <div class="icon">☷</div>
        <div>在庫一覧</div>
      </button>
      <button class="nav-plus" id="navCreate">＋</button>
      <button class="nav-btn" id="navAccount">
        <div class="icon">⚙</div>
        <div>アカウント</div>
      </button>
    </div>
  </div>

  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="modalTitle">操作</div>
        <button class="close-btn" id="closeModalBtn">閉じる</button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <div class="modal-backdrop" id="pinBackdrop">
    <div class="modal">
      <div class="pin-title">PINコード入力</div>
      <div class="pin-note">初回のみ、PINコードを入力してください</div>
      <div class="field">
        <input id="pinInput" class="input" type="password" inputmode="numeric" placeholder="PINコード" />
      </div>
      <button class="submit-btn" id="pinSubmitBtn">開く</button>
    </div>
  </div>

  <div class="modal-backdrop" id="setupBackdrop">
    <div class="modal">
      <div class="pin-title">初期設定</div>

      <div class="field">
        <label>投稿者名</label>
        <input id="setupPosterName" class="input" placeholder="例：藤井" />
      </div>

      <div class="field">
        <label>インターフェース色</label>
        <div class="theme-grid" id="setupThemeGrid"></div>
      </div>

      <button class="submit-btn" id="setupSaveBtn">保存して始める</button>
    </div>
  </div>

  <script>
    let allItems = [];
    let filteredItems = [];
    let masterCategories = [];
    let masterLocations = [];
    let activeMainTab = 'all';
    let selectedPhotoBase64 = '';

    let settings = {
      posterName: '',
      theme: 'violet'
    };

    const THEMES = {
      violet: { accent: '#7c74ff', accent2: '#9b96ff', bg: '#0b1636', card: '#1e2b4b' },
      green:  { accent: '#36c487', accent2: '#60d8a1', bg: '#0b1d1b', card: '#17312d' },
      orange: { accent: '#ff8e4d', accent2: '#ffae7c', bg: '#23160f', card: '#3b2518' },
      blue:   { accent: '#4f8bff', accent2: '#7aa9ff', bg: '#0b1530', card: '#182746' },
      pink:   { accent: '#ff67b2', accent2: '#ff96ca', bg: '#2a1020', card: '#431a32' },
      brown:  { accent: '#b98a5f', accent2: '#d0a57f', bg: '#1d130d', card: '#342319' }
    };

    const els = {
      searchCard: document.getElementById('searchCard'),
      tabsWrap: document.getElementById('tabsWrap'),
      searchInput: document.getElementById('searchInput'),
      mainTabs: document.getElementById('mainTabs'),
      itemsContainer: document.getElementById('itemsContainer'),
      refreshBtn: document.getElementById('refreshBtn'),
      screenList: document.getElementById('screenList'),
      screenCreate: document.getElementById('screenCreate'),
      screenAccount: document.getElementById('screenAccount'),
      navList: document.getElementById('navList'),
      navCreate: document.getElementById('navCreate'),
      navAccount: document.getElementById('navAccount'),

      photoZone: document.getElementById('photoZone'),
      cameraInput: document.getElementById('cameraInput'),
      photoInput: document.getElementById('photoInput'),
      name: document.getElementById('name'),
      categoryL: document.getElementById('category_l'),
      categoryM: document.getElementById('category_m'),
      categoryS: document.getElementById('category_s'),
      locationSelect: document.getElementById('locationSelect'),
      locationOtherWrap: document.getElementById('locationOtherWrap'),
      locationOther: document.getElementById('locationOther'),
      addLocationBtn: document.getElementById('addLocationBtn'),
      qty: document.getElementById('qty'),
      unit: document.getElementById('unit'),
      threshold: document.getElementById('threshold'),
      addIfSameName: document.getElementById('addIfSameName'),
      note: document.getElementById('note'),
      createBtn: document.getElementById('createBtn'),

      settingPosterName: document.getElementById('settingPosterName'),
      themeGrid: document.getElementById('themeGrid'),
      saveSettingsBtn: document.getElementById('saveSettingsBtn'),
      resetPinBtn: document.getElementById('resetPinBtn'),

      modalBackdrop: document.getElementById('modalBackdrop'),
      modalTitle: document.getElementById('modalTitle'),
      modalBody: document.getElementById('modalBody'),
      closeModalBtn: document.getElementById('closeModalBtn'),

      pinBackdrop: document.getElementById('pinBackdrop'),
      pinInput: document.getElementById('pinInput'),
      pinSubmitBtn: document.getElementById('pinSubmitBtn'),

      setupBackdrop: document.getElementById('setupBackdrop'),
      setupPosterName: document.getElementById('setupPosterName'),
      setupThemeGrid: document.getElementById('setupThemeGrid'),
      setupSaveBtn: document.getElementById('setupSaveBtn')
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

    function uniqueSorted(list) {
      const map = {};
      const out = [];
      for (const raw of list) {
        const v = safeText(raw).trim();
        if (!v) continue;
        if (!map[v]) {
          map[v] = true;
          out.push(v);
        }
      }
      out.sort((a, b) => a.localeCompare(b, 'ja'));
      return out;
    }

    function applyTheme(themeKey) {
      if (!THEMES[themeKey]) themeKey = 'violet';
      settings.theme = themeKey;
      const t = THEMES[themeKey];
      document.documentElement.style.setProperty('--accent', t.accent);
      document.documentElement.style.setProperty('--accent2', t.accent2);
      document.documentElement.style.setProperty('--bg', t.bg);
      document.documentElement.style.setProperty('--card', t.card);
    }

    function loadSettings() {
      try {
        const raw = localStorage.getItem('inventory_settings');
        if (raw) {
          const obj = JSON.parse(raw);
          settings.posterName = safeText(obj.posterName || '');
          settings.theme = safeText(obj.theme || 'violet');
        }
      } catch (e) {}
      applyTheme(settings.theme);
      els.settingPosterName.value = settings.posterName;
      els.setupPosterName.value = settings.posterName;
    }

    function saveSettings() {
      localStorage.setItem('inventory_settings', JSON.stringify(settings));
      applyTheme(settings.theme);
    }

    function renderThemeButtons(targetEl, selectedKey, mode) {
      let html = '';
      Object.keys(THEMES).forEach((key) => {
        const t = THEMES[key];
        html += '<button type="button" class="theme-btn ' + (selectedKey === key ? 'active' : '') + '" ' +
          'data-key="' + escapeHtml(key) + '" ' +
          'style="background:linear-gradient(135deg,' + t.accent + ' 0%,' + t.accent2 + ' 100%);"></button>';
      });
      targetEl.innerHTML = html;

      targetEl.querySelectorAll('.theme-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-key');
          settings.theme = key;
          if (mode === 'setup') {
            renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
          } else {
            renderThemeButtons(els.themeGrid, settings.theme, 'account');
          }
        });
      });
    }

    function checkPinFlow() {
      const pinOk = localStorage.getItem('inventory_pin_ok') === '1';
      const setupDone = localStorage.getItem('inventory_setup_done') === '1';

      if (!pinOk) {
        els.pinBackdrop.classList.add('show');
        return;
      }

      if (!setupDone) {
        renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
        els.setupBackdrop.classList.add('show');
      }
    }

    function submitPin() {
      const pin = els.pinInput.value.trim();
      if (pin === '1616') {
        localStorage.setItem('inventory_pin_ok', '1');
        els.pinBackdrop.classList.remove('show');

        if (localStorage.getItem('inventory_setup_done') !== '1') {
          renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
          els.setupBackdrop.classList.add('show');
        }
      } else {
        alert('PINコードが違います');
      }
    }

    function submitInitialSetup() {
      settings.posterName = els.setupPosterName.value.trim();
      if (!settings.posterName) {
        alert('投稿者名を入力してください');
        return;
      }
      saveSettings();
      localStorage.setItem('inventory_setup_done', '1');
      els.settingPosterName.value = settings.posterName;
      renderThemeButtons(els.themeGrid, settings.theme, 'account');
      els.setupBackdrop.classList.remove('show');
    }

    function saveAccountSettings() {
      settings.posterName = els.settingPosterName.value.trim();
      if (!settings.posterName) {
        alert('投稿者名を入力してください');
        return;
      }
      saveSettings();
      els.setupPosterName.value = settings.posterName;
      alert('設定を保存しました');
    }

    function resetPin() {
      localStorage.removeItem('inventory_pin_ok');
      alert('PINをリセットしました。次回起動時に再入力されます');
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

    function setSelectOptions(selectEl, values, placeholder) {
      let html = '<option value="">' + escapeHtml(placeholder) + '</option>';
      values.forEach((v) => {
        html += '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>';
      });
      selectEl.innerHTML = html;
    }

    function getLargeNames() {
      return uniqueSorted(masterCategories.map(row => row.large_name));
    }

    function getMiddleNames(largeName) {
      return uniqueSorted(
        masterCategories
          .filter(row => safeText(row.large_name).trim() === safeText(largeName).trim())
          .map(row => row.middle_name)
      );
    }

    function getSmallNames(largeName, middleName) {
      return uniqueSorted(
        masterCategories
          .filter(row =>
            safeText(row.large_name).trim() === safeText(largeName).trim() &&
            safeText(row.middle_name).trim() === safeText(middleName).trim()
          )
          .map(row => row.small_name)
      );
    }

    function refreshCategorySelects() {
      const prevL = els.categoryL.value;
      const prevM = els.categoryM.value;
      const prevS = els.categoryS.value;

      const largeList = getLargeNames();
      setSelectOptions(els.categoryL, largeList, '大分類を選択');
      if (largeList.includes(prevL)) els.categoryL.value = prevL;

      const currentL = els.categoryL.value;
      const middleList = currentL ? getMiddleNames(currentL) : [];
      setSelectOptions(els.categoryM, middleList, '中分類を選択');
      if (middleList.includes(prevM)) els.categoryM.value = prevM;

      const currentM = els.categoryM.value;
      const smallList = currentL && currentM ? getSmallNames(currentL, currentM) : [];
      setSelectOptions(els.categoryS, smallList, '小分類を選択');
      if (smallList.includes(prevS)) els.categoryS.value = prevS;
    }

   function refreshLocationSelect() {
  const locations = uniqueSorted(masterLocations);
  let html = '<option value="">保管場所を選択</option>';

  locations.forEach((loc) => {
    html += '<option value="' + escapeHtml(loc) + '">' + escapeHtml(loc) + '</option>';
  });

  html += '<option value="__other__">その他</option>';
  els.locationSelect.innerHTML = html;

  if (locations.includes('白鳥')) {
    els.locationSelect.value = '白鳥';
  }
}

    function updateLocationOtherVisibility() {
      if (els.locationSelect.value === '__other__') {
        els.locationOtherWrap.classList.remove('hidden');
      } else {
        els.locationOtherWrap.classList.add('hidden');
        els.locationOther.value = '';
      }
    }

    async function addLocation() {
      const name = prompt('追加する保管場所名を入力してください');
      if (!name) return;
      const trimmed = name.trim();
      if (!trimmed) return;

      if (!masterLocations.includes(trimmed)) {
        masterLocations.push(trimmed);
        refreshLocationSelect();
      }
      els.locationSelect.value = trimmed;
      updateLocationOtherVisibility();
    }

    function renderMainTabs() {
      const tabs = ['all', ...getLargeNames()];
      let html = '';

      tabs.forEach((key) => {
        const label = key === 'all' ? '在庫一覧' : key;
        html += '<button class="tab ' + (activeMainTab === key ? 'active' : '') + '" data-key="' + escapeHtml(key) + '">' + escapeHtml(label) + '</button>';
      });

      els.mainTabs.innerHTML = html;

      els.mainTabs.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeMainTab = btn.getAttribute('data-key');
          filterItems();
        });
      });
    }

    function showScreen(name) {
      els.screenList.classList.remove('active');
      els.screenCreate.classList.remove('active');
      els.screenAccount.classList.remove('active');
      els.navList.classList.remove('active');
      els.navAccount.classList.remove('active');

      els.searchCard.classList.remove('hidden');
      els.tabsWrap.classList.remove('hidden');

      if (name === 'list') {
        els.screenList.classList.add('active');
        els.navList.classList.add('active');
      } else if (name === 'create') {
        els.screenCreate.classList.add('active');
        els.searchCard.classList.add('hidden');
        els.tabsWrap.classList.add('hidden');
      } else if (name === 'account') {
        els.screenAccount.classList.add('active');
        els.navAccount.classList.add('active');
        els.searchCard.classList.add('hidden');
        els.tabsWrap.classList.add('hidden');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function openModal(title, html) {
      els.modalTitle.textContent = title;
      els.modalBody.innerHTML = html;
      els.modalBackdrop.classList.add('show');
    }

    function closeModal() {
      els.modalBackdrop.classList.remove('show');
      els.modalBody.innerHTML = '';
    }

    function filterItems() {
      const q = safeText(els.searchInput.value).trim().toLowerCase();

      filteredItems = allItems.filter((item) => {
        if (activeMainTab !== 'all' && safeText(item.category_l).trim() !== activeMainTab) {
          return false;
        }

        if (q) {
          const hay = [
            item.name,
            item.category_l,
            item.category_m,
            item.category_s,
            item.location,
            item.status
          ].join(' ').toLowerCase();

          if (!hay.includes(q)) return false;
        }

        return true;
      });

      renderItems();
    }

    function renderItems() {
      if (!filteredItems.length) {
        els.itemsContainer.innerHTML = '<div class="empty">条件に合う在庫がありません。</div>';
        return;
      }

      let html = '';

      filteredItems.forEach((item) => {
        const photos = getPhotoUrls(item);
        let thumbHtml = '画像なし';

        if (photos.length > 0) {
          const cands = buildDriveImageCandidates(photos[0]);
          const c0 = escapeHtml(cands[0] || '');
          const c1 = escapeHtml(cands[1] || '');
          const c2 = escapeHtml(cands[2] || '');

          thumbHtml = '<img src="' + c0 + '" alt="' + escapeHtml(item.name || '') + '"' +
            ' onerror="if(!this.dataset.f1 && \\''
            + c1 +
            '\\'){this.dataset.f1=\\'1\\';this.src=\\'' +
            c1 +
            '\\';return;} if(!this.dataset.f2 && \\''
            + c2 +
            '\\'){this.dataset.f2=\\'1\\';this.src=\\'' +
            c2 +
            '\\';return;} this.onerror=null; this.outerHTML=\\'<span>画像なし</span>\\';"' +
            ' />';
        }

        const chipValues = [item.category_l, item.category_m, item.category_s, item.location]
          .map(v => safeText(v).trim())
          .filter(Boolean);

        let chipsHtml = '';
        chipValues.forEach((v) => {
          chipsHtml += '<span class="chip">' + escapeHtml(v) + '</span>';
        });

        html += '<div class="item-card">';
        html +=   '<div class="thumb-box">' + thumbHtml + '</div>';
        html +=   '<div class="item-main">';
        html +=     '<div class="item-name">' + escapeHtml(item.name || '') + '</div>';
        html +=     '<div class="item-meta">状態: ' + escapeHtml(item.status || '') + '</div>';
        html +=     '<div class="chips">' + chipsHtml + '</div>';
        html +=     '<div class="qty-row">';
        html +=       '<div class="qty-box"><span class="qty-num">' + escapeHtml(item.qty || 0) + '</span><span class="qty-unit">' + escapeHtml(item.unit || '') + '</span></div>';
        html +=       '<div class="item-actions">';
        html +=         '<button class="btn btn-secondary" onclick="editItem(\\'' + escapeHtml(item.item_id) + '\\')">編集</button>';
        html +=         '<button class="btn btn-primary" onclick="consumeItem(\\'' + escapeHtml(item.item_id) + '\\',\\'' + escapeHtml(item.name || '') + '\\')">消費</button>';
        html +=       '</div>';
        html +=     '</div>';
        html +=   '</div>';
        html += '</div>';
      });

      els.itemsContainer.innerHTML = html;
    }

    function renderPhotoPreview() {
      if (!selectedPhotoBase64) {
        els.photoZone.innerHTML =
          '<div class="photo-zone-inner">' +
          '<div class="photo-zone-icon">◉</div>' +
          '<div>タップして撮影/選択</div>' +
          '</div>';
        return;
      }

      els.photoZone.innerHTML = '<img src="' + selectedPhotoBase64 + '" alt="preview" />';
    }

    function clearSelectedPhoto() {
      selectedPhotoBase64 = '';
      els.cameraInput.value = '';
      els.photoInput.value = '';
      renderPhotoPreview();
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function openPhotoChooser() {
      let html = '';
      html += '<div class="field"><button class="btn btn-primary" style="width:100%; border-radius:18px; padding:14px;" onclick="openCameraFromModal()">カメラ起動</button></div>';
      html += '<div class="field"><button class="btn btn-secondary" style="width:100%; border-radius:18px; padding:14px;" onclick="openLibraryFromModal()">写真を選ぶ</button></div>';
      if (selectedPhotoBase64) {
        html += '<div class="field"><button class="btn btn-danger" style="width:100%; border-radius:18px; padding:14px;" onclick="clearPhotoFromModal()">写真を消す</button></div>';
      }
      openModal('写真', html);
    }

    function openCameraFromModal() {
      closeModal();
      els.cameraInput.click();
    }

    function openLibraryFromModal() {
      closeModal();
      els.photoInput.click();
    }

    function clearPhotoFromModal() {
      closeModal();
      clearSelectedPhoto();
    }

    async function loadMasters() {
      const res = await fetch('/api/master');
      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      masterCategories = Array.isArray(data.categories) ? data.categories : [];
      masterLocations = Array.isArray(data.locations) ? data.locations : [];

      refreshCategorySelects();
      refreshLocationSelect();
      renderMainTabs();
    }

    async function loadItems() {
      const res = await fetch('/api/items');
      const data = await res.json();

      if (!Array.isArray(data)) {
        throw new Error(data && data.error ? data.error : '在庫データの取得に失敗しました');
      }

      allItems = data;
      filterItems();
    }

    async function reloadAll() {
      await loadMasters();
      await loadItems();
    }

    async function createItem() {
      try {
        let locationValue = els.locationSelect.value;
        if (locationValue === '__other__') {
          locationValue = els.locationOther.value.trim();
        }

        const payload = {
          name: els.name.value.trim(),
          category_l: els.categoryL.value.trim(),
          category_m: els.categoryM.value.trim(),
          category_s: els.categoryS.value.trim(),
          location: locationValue,
          qty: Number(els.qty.value || 0),
          unit: els.unit.value.trim() || '個',
          threshold: els.threshold.value === '' ? '' : Number(els.threshold.value || 0),
          user: settings.posterName || 'Unknown',
          note: els.note.value.trim() || '在庫登録',
          addIfSameName: els.addIfSameName.checked,
          photo_base64: selectedPhotoBase64 || ''
        };

if (!payload.name) {
  alert('品名を入力してください');
  return;
}
if (!payload.category_l) {
  alert('大分類を選択してください');
  return;
}
if (!payload.location) {
  alert('保管場所を選択してください');
  return;
}
        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('登録しました');

        els.name.value = '';
        els.qty.value = '1';
        els.unit.value = '個';
        els.threshold.value = '';
        els.note.value = '';
        els.categoryL.value = '';
        els.categoryM.value = '';
        els.categoryS.value = '';
        els.locationSelect.value = '';
        els.locationOther.value = '';
        updateLocationOtherVisibility();
        refreshCategorySelects();
        clearSelectedPhoto();

        await loadItems();
        showScreen('list');
      } catch (err) {
        alert(err.message || '登録に失敗しました');
      }
    }

    async function consumeItem(itemId, itemName) {
      let html = '';
      html += '<div class="field"><label>対象</label><input class="input" value="' + escapeHtml(itemName) + '" disabled /></div>';
      html += '<div class="field"><label>消費数</label><input class="input" id="consume_qty" type="number" value="1" /></div>';
      html += '<div class="field"><label>メモ</label><input class="input" id="consume_note" value="使用・消費" /></div>';
      html += '<button class="submit-btn" onclick="submitConsume(\\'' + escapeHtml(itemId) + '\\')">消費する</button>';
      openModal('在庫を消費', html);
    }

    async function submitConsume(itemId) {
      try {
        const payload = {
          item_id: itemId,
          consume_qty: Number(document.getElementById('consume_qty').value || 0),
          user: settings.posterName || 'Unknown',
          note: document.getElementById('consume_note').value.trim() || '使用・消費'
        };

        if (!payload.consume_qty || payload.consume_qty <= 0) {
          alert('消費数を入力してください');
          return;
        }

        const res = await fetch('/api/items/use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        closeModal();
        await loadItems();
      } catch (err) {
        alert(err.message || '消費処理に失敗しました');
      }
    }

    async function editItem(itemId) {
      try {
        const res = await fetch('/api/items/' + encodeURIComponent(itemId));
        const item = await res.json();
        if (item.error) throw new Error(item.error);

        let html = '';
        html += '<div class="field"><label>品名</label><input class="input" id="edit_name" value="' + escapeHtml(item.name || '') + '" /></div>';
        html += '<div class="field"><label>保管場所</label><input class="input" id="edit_location" value="' + escapeHtml(item.location || '') + '" /></div>';
        html += '<div class="field"><label>大分類</label><input class="input" id="edit_category_l" value="' + escapeHtml(item.category_l || '') + '" /></div>';
        html += '<div class="field"><label>中分類</label><input class="input" id="edit_category_m" value="' + escapeHtml(item.category_m || '') + '" /></div>';
        html += '<div class="field"><label>小分類</label><input class="input" id="edit_category_s" value="' + escapeHtml(item.category_s || '') + '" /></div>';
        html += '<div class="field"><label>単位</label><input class="input" id="edit_unit" value="' + escapeHtml(item.unit || '個') + '" /></div>';
        html += '<div class="field"><label>要発注ライン</label><input class="input" id="edit_threshold" type="number" value="' + escapeHtml(item.threshold == null ? '' : item.threshold) + '" /></div>';
        html += '<div class="field"><label>メモ</label><input class="input" id="edit_note" value="在庫情報更新" /></div>';
        html += '<button class="submit-btn" onclick="submitEdit(\\'' + escapeHtml(item.item_id) + '\\')">更新する</button>';

        openModal('在庫を編集', html);
      } catch (err) {
        alert(err.message || '編集情報の取得に失敗しました');
      }
    }

    async function submitEdit(itemId) {
      try {
        const payload = {
          item_id: itemId,
          name: document.getElementById('edit_name').value.trim(),
          category_l: document.getElementById('edit_category_l').value.trim(),
          category_m: document.getElementById('edit_category_m').value.trim(),
          category_s: document.getElementById('edit_category_s').value.trim(),
          location: document.getElementById('edit_location').value.trim(),
          unit: document.getElementById('edit_unit').value.trim() || '個',
          threshold: document.getElementById('edit_threshold').value === '' ? '' : Number(document.getElementById('edit_threshold').value || 0),
          user: settings.posterName || 'Unknown',
          note: document.getElementById('edit_note').value.trim() || '在庫情報更新'
        };

        const res = await fetch('/api/items/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        closeModal();
        await loadItems();
      } catch (err) {
        alert(err.message || '更新に失敗しました');
      }
    }

    els.searchInput.addEventListener('input', filterItems);
    els.refreshBtn.addEventListener('click', () => {
      reloadAll().catch((err) => alert(err.message || '更新に失敗しました'));
    });

    els.categoryL.addEventListener('change', () => {
      els.categoryM.value = '';
      els.categoryS.value = '';
      refreshCategorySelects();
    });

    els.categoryM.addEventListener('change', () => {
      els.categoryS.value = '';
      refreshCategorySelects();
    });

    els.locationSelect.addEventListener('change', updateLocationOtherVisibility);
    els.addLocationBtn.addEventListener('click', addLocation);

    els.photoZone.addEventListener('click', openPhotoChooser);

    els.cameraInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        selectedPhotoBase64 = await fileToBase64(file);
        renderPhotoPreview();
      } catch (err) {
        alert('画像の読み込みに失敗しました');
      }
    });

    els.photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        selectedPhotoBase64 = await fileToBase64(file);
        renderPhotoPreview();
      } catch (err) {
        alert('画像の読み込みに失敗しました');
      }
    });

    els.createBtn.addEventListener('click', createItem);

    els.navList.addEventListener('click', () => showScreen('list'));
    els.navCreate.addEventListener('click', () => showScreen('create'));
    els.navAccount.addEventListener('click', () => showScreen('account'));

    els.closeModalBtn.addEventListener('click', closeModal);
    els.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.modalBackdrop) closeModal();
    });

    els.pinSubmitBtn.addEventListener('click', submitPin);
    els.pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin();
    });

    els.setupSaveBtn.addEventListener('click', submitInitialSetup);
    els.saveSettingsBtn.addEventListener('click', saveAccountSettings);
    els.resetPinBtn.addEventListener('click', resetPin);

    loadSettings();
    renderThemeButtons(els.themeGrid, settings.theme, 'account');
    renderPhotoPreview();
    checkPinFlow();

    reloadAll().catch((err) => {
      els.itemsContainer.innerHTML = '<div class="empty">読み込みに失敗しました<br>' + escapeHtml(err.message || '') + '</div>';
    });

    window.consumeItem = consumeItem;
    window.submitConsume = submitConsume;
    window.editItem = editItem;
    window.submitEdit = submitEdit;
    window.openCameraFromModal = function() {
      closeModal();
      els.cameraInput.click();
    };
    window.openLibraryFromModal = function() {
      closeModal();
      els.photoInput.click();
    };
    window.clearPhotoFromModal = function() {
      closeModal();
      clearSelectedPhoto();
    };
  </script>
</body>
</html>
  `);
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
    inventoryApiConfigured: !!INVENTORY_API_URL && !!INVENTORY_API_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.get('/logtest', (req, res) => {
  console.log('🧪 ログ出力テスト成功！');
  res.send('ログ出力したよ！');
});

// ------------------------------------------
// ポート
// ------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
