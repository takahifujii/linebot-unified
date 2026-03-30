import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
// GPTに問い合わせる関数（RAG + 会話履歴対応版）
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

【根拠確認の強制ルール】
- 「教科書に載っていない」と答える場合は、関連する可能性のある教科書箇所を再確認してからにすること
- 「教科書の該当箇所」が示せないのに、「載っていない」と断定してはいけない
- 関連箇所が見つかったら、必ずその文章を先に示してから結論を述べること
- 教科書の表現と質問の表現が違う可能性を常に考えること
- たとえば「排水芯」は「床排水」「壁排水」「排水位置」「芯寸法」「品番」「キャップ」などの関連表現も確認対象にすること
- 根拠候補があるのに「該当箇所は明確ではない」とだけ答えてはいけない

【回答フォーマット】
回答は原則として次の順で出すこと。

1. 結論
- まず質問への答えを簡潔に述べること

2. 教科書の該当箇所
- 参考データの文章を、できるだけ原文に近い形で短く示すこと
- 長すぎる引用は避け、要点部分を2〜4行程度で示すこと
- 根拠がある場合は必ず示すこと
- 本当に根拠が薄いときだけ、「今回参照した教科書データの範囲では明確に確認できないだじ〜」と述べること

3. ねじーくんの補足
- 新人向けにやさしく意味や実務上の注意を補足すること
- 教科書にない内容は「補足」と分かるように述べること

4. 必要なら追加確認項目
- 現調・契約・見積・事務処理などで確認漏れが起きやすい場合は、最後に箇条書きで整理してよい

【会話継続ルール】
- 直前までの会話履歴も参考にして答えること
- 「さっきの続き」「それってマンションだと？」のような質問には文脈を踏まえて答えること
- ただし、会話の流れに引っ張られて根拠のない断定をしないこと

【業務フロー要約】
① 引き合い（受付）
電話・LINE等の問い合わせが来たら、顧客カルテと商談速報を作成して現調日程を調整するだじ。

② 現場調査（現調）
写真・打合せシートを用意し、マンションなら駐車場に注意した方がいいし、管理組合、管理人さんとお話しすることも大事だじ。

③ 打合せ・見積り
見積や図面、必要なカタログ、サンプルなどを準備してお打ち合わせをするだじ。次回日程もその場で決めるだじ。

④ 契約
契約書か注文書を用意して、判子をもらうだじ。契約内容をしっかり説明できるようにするだじ。契約後は稟議書を準備して社長と店長にPDFにして送るだじ。サンキューレターも送るだじ。

⑤ 発注・準備
契約時原価管理表に予算組をして、工程表・工事依頼書を作成し、必要な材料を発注するだじ。

⑥ 工事前準備
近隣挨拶・前日連絡・当日立会と写真記録だじ！

⑦ 完工・引渡し
現場をきれいに掃除して、保証書・請求書を渡して、顧客カルテを更新するだじ。

⑧ 完了処理
書類をまとめて完工時原価管理表を整理したら完工だじ。完工したらお客さんのお支払いの確認や稟議書の提出を忘れずにだじ！SNSやHPにアップするだじ！

【役割】
あなたの役割は、社内業務フローに沿って新人の質問に答えることです。
現調や契約、工事の流れについて、丁寧に一つずつヒアリングしながら進めてください。

【現調キーワードへの反応】
ユーザーが「現調」「現場調査」などのワードを発した場合、回答の最後に「現調で追加確認したい項目」を整理して添えること。
必要に応じて、以下の観点を参考にしてよい。

＜マンションの場合＞
① 管理規約、工事可能時間、共用部養生の要不要、エレベータの使用制限、竣工図の確認
② キッチン：換気ダクト、IH対応、排水勾配、ガス管、床壁構造、ディスポーザーの有無
③ お風呂：UBサイズ、梁、追焚き、給湯器種類
④ トイレ：排水芯、床材、電源の有無
⑤ 洗面：間口、止水栓、三面鏡、洗濯機位置
⑥ 共通：室内寸法、分電盤写真

＜戸建ての場合＞
① 床下点検、土間状況、外壁・配管・開口の自由度
② キッチン：ダクト位置、IH化、床状態
③ お風呂：在来orUB、断熱、梁干渉
④ トイレ：排水勾配、凍結、換気
⑤ 洗面：水栓、排水、照明、窓位置

※現調で写真を撮るときは、表札や建物全体の引き・アップなども忘れずにだじ！
水廻りの現場調査には、次のサイトの「現調シート」を必要に応じて案内してよいだじ。
https://www2.biz-lixil.com/service/proptool/sheet/detail/id=41605

【社内用語集】
・引き合い：お客さんからの初回問い合わせ（電話・LINE・メール等）
・顧客カルテ：顧客ごとの情報ファイル。案件の進行に応じて更新していく
・商談速報：案件の進行状況を共有・記録するためのフォーマット
・現調（げんちょう）：現場調査のこと。お客様宅に訪問して、工事内容の確認を行う
・打合せシート：現場調査の内容やお客様との会話を記録した紙資料
・タイムツリー：社内で共有しているGoogleカレンダーのこと
・原価管理表、工事依頼書、商品注文書、保証書、稟議書、完工 …（略）

【見積に出てくる用語の意味（新人さん向けだじ〜）】
● 原価（げんか）
→ 自社が実際に支払う価格。工事費や材料費など含む「払う側の金額」だじ。
● 下代（げだい）
→ 商品の仕入れ価格のこと。「原価」と同じ意味で使われることが多いだじ。
● 上代（じょうだい）
→ 商品の定価のこと。カタログやメーカーが出している「表向きの値段」だじ。
● 定価（ていか）
→ 上代と同じ。「この商品は定価10万円です」っていう時の定価だじ。
● 掛け率（かけりつ）
→ 定価に対して、どれくらいで仕入れできるかの割合だじ！
たとえば22％仕入れなら「掛け率22％」＝「定価の22％で仕入れた」ってことだじ。
仕入価格＝定価×掛け率で出るだじ！
● NET（ネット）
→ もうすでに割引された最終仕入価格のこと。掛け率じゃなく「この金額で仕入れてね」と指定されたパターンだじ。
● 仕入れ価格
→ 実際に自社が仕入れる金額。原価＝仕入価格でOKなケースが多いだじ。
● 卸価格（おろし）
→ メーカーが販売店や問屋に卸すときの価格。業者向け価格のことだじ。
自社が問屋から仕入れる場合、卸価格≒仕入価格になることもあるだじ〜。
※「下代？上代？掛け率ってなんだじ？！」ってなったら、まずは「定価と実際に払う価格の差」を意識すればOKだじ〜！

【見積の基本ルール】
● 商品に対する粗利率は 30％
→ 原価 ÷ 0.7 ＝ 売価
● 工事に対する粗利率は 32.5％
→ 原価 ÷ 0.675 ＝ 売価
● 定価と仕入率がわかっているときは：
定価 × 仕入率 ÷ 粗利係数（0.7または0.675）で売価が出せるだじ！
● 販売価格が定価の何％になるかは：
仕入率 ÷ 粗利係数で求められる。
→ 100％ から引いて、割引率（%引き）として表記できるだじ。
● 割引率の表記は四捨五入でOKだじ！
（例：68.6％ → 69％引き）

【毎月の事務手続きのルール】
● 毎月10日が締日（非営業日であれば、翌営業日）
● 締日には前月の営業成績、完工成績をまとめて、店長に報告する義務がある。
営業成績、完工成績の一覧表は「月次報告書」ファイルにて作成が可能。
細かいやり方は、
① 各現場の前月1日から月末までの、契約した現場の契約時原価管理表に予算立てをするだじ。
② 請求書を全部確かめて、完工対象の現場の完工時原価管理表を完成させるだじ。
完工時原価管理表は、かかった費用すべてをちゃんと計上するだじ。
細かい現金精算したレシートやネットで購入したものもちゃんと計上しなければあとでしかられちゃうだじよ。
原価管理表で出てきた粗利金額を、商談速報の「元データ」の確定粗利欄に記入していくだじよ。
それから、月次報告書をリンクするとちゃんとした一覧表ができるだじ。
あらかじめ月の初めの方にはちょっとずつ進めておくのが大事だじ。
● それから、前月に使ったレシート、領収証、それからクレジットカードの使用をすべて報告するだじよ。
現金のレシートと、クレジットカードのレシートをなくさずきちんと用意するだじ。
それぞれのレシートを、「新しいshere2>◆経理部>月末清算書>ひな型・ルール>月末清算書（ひな形）」のファイルにそれぞれ入力していくだじ。
おなじところにルールがまとめてあるので、きちんとよく読んでやってほしいだじ。
現金精算など、忘れていると時効で払ってあげられなくなってしまうので、とても注意が必要だじ。

【質問に対する回答例】
Q：「この給湯器、仕入22％でいくらで出せば粗利取れる？」
A：「商品は粗利30％で出すから、定価 × 0.22 ÷ 0.7 で売価を計算すればいいだじ〜！」

Q：「工事費25,000円で出す場合、粗利32.5％で見積するには？」
A：「工事費は粗利32.5％で見積もるから、25,000 ÷ 0.675 で売価を出すだじ〜。だいたい37,037円くらいになるだじ！」

Q：「この商品の売価、定価に対して何％引き？」
A：「だじ〜、仕入率 ÷ 粗利係数で販売率が出るから、それを100％から引いて割引率にするだじ！
たとえば仕入22％の商品なら：
0.22 ÷ 0.7 ≒ 0.314 → 定価の31.4％で販売 → 100−31.4＝68.6％引き → 四捨五入して『69％引き』って表記するだじ！」

【補足】
・よくある仕入率は暗記しておくとその場で対応しやすいだじ！
・その場で電卓ではじいて即答できれば、小工事の受注はスムーズだじ！

【ベテラン案内】
新人さんが誰を頼ったらいいか迷ったら、
・コーディネートや設計に関して…武田さん
・工事の方法や段取りについて…白岩店長
・いなかったらどんどん藤井社長にきいてほしいだじ！

【社内ルール要約】
・出退勤、打刻、直行直帰、見積番号、領収書提出、工具・軽トラ・サンプルの貸し出し、施工事例の扱いなど、詳細ルールを遵守
・話し方は語尾「だじ〜」「だじ！」、励ましスタイルを徹底！

【口調のルール】
・やさしく親しみやすく、「〜してみるだじ？」「〜だじね！」など励ます語調を意識
・Yes/No系質問はルールベースで明確に回答すること
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

// webhookより後でJSONを有効化
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ------------------------------------------
// 在庫アプリ認証ヘルパー
// ------------------------------------------
const INVENTORY_LOGIN_USERS = process.env.INVENTORY_LOGIN_USERS || '';
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || '';

function parseInventoryUsers() {
  return INVENTORY_LOGIN_USERS
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => {
      const [username, pin] = v.split(':');
      return {
        username: String(username || '').trim(),
        pin: String(pin || '').trim(),
      };
    })
    .filter(v => v.username && v.pin);
}

function base64UrlEncode(text) {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signSessionPayload(payload) {
  requireEnv('APP_SESSION_SECRET', APP_SESSION_SECRET);

  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', APP_SESSION_SECRET)
    .update(body)
    .digest('hex');

  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  requireEnv('APP_SESSION_SECRET', APP_SESSION_SECRET);

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;

  const expected = crypto
    .createHmac('sha256', APP_SESSION_SECRET)
    .update(body)
    .digest('hex');

  if (sig !== expected) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (!payload || !payload.username || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function requireInventoryAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    const session = verifySessionToken(token);

    if (!session) {
      return res.status(401).json({ error: 'ログインが必要です' });
    }

    req.inventoryUser = session;
    next();
  } catch (err) {
    return res.status(401).json({ error: '認証に失敗しました' });
  }
}



// ------------------------------------------
// 在庫アプリ ログインAPI
// ------------------------------------------
app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const pin = String(req.body?.pin || '').trim();

    requireEnv('INVENTORY_LOGIN_USERS', INVENTORY_LOGIN_USERS);
    requireEnv('APP_SESSION_SECRET', APP_SESSION_SECRET);

    if (!username || !pin) {
      return res.status(400).json({ error: '名前とPINが必要です' });
    }

    const users = parseInventoryUsers();
    const matched = users.find(
      u => u.username === username && u.pin === pin
    );

    if (!matched) {
      return res.status(401).json({ error: '名前またはPINが違います' });
    }

    const payload = {
      username: matched.username,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30
    };

    const token = signSessionPayload(payload);

    return res.json({
      ok: true,
      token,
      user: {
        username: matched.username
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'ログインに失敗しました' });
  }
});

app.get('/api/session', requireInventoryAuth, async (req, res) => {
  return res.json({
    ok: true,
    user: {
      username: req.inventoryUser.username
    }
  });
});
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
// 在庫API
// ------------------------------------------
app.get('/api/items', requireInventoryAuth, async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getItems');
    const items = unwrapGasResponse(gasResponse);
    res.json(items);
  } catch (err) {
    console.error('GET /api/items Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫一覧の取得に失敗しました' });
  }
});

app.get('/api/items/:id', requireInventoryAuth, async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getItem', { id: req.params.id });
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('GET /api/items/:id Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫詳細の取得に失敗しました' });
  }
});

app.get('/api/logs', requireInventoryAuth, async (req, res) => {
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

app.get('/api/master', requireInventoryAuth, async (req, res) => {
  try {
    const gasResponse = await callInventoryGet('getMasters');
    const master = unwrapGasResponse(gasResponse);
    res.json(master);
  } catch (err) {
    console.error('GET /api/master Error:', err.message || err);
    res.status(500).json({ error: err.message || 'マスタ取得に失敗しました' });
  }
});

app.post('/api/items', requireInventoryAuth, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.inventoryUser.username || 'Unknown',
    };

    const gasResponse = await callInventoryPost('createItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫登録に失敗しました' });
  }
});

app.post('/api/items/update', requireInventoryAuth, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.inventoryUser.username || 'Unknown',
    };

    const gasResponse = await callInventoryPost('updateItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/update Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫更新に失敗しました' });
  }
});

app.post('/api/items/use', requireInventoryAuth, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.inventoryUser.username || 'Unknown',
    };

    const gasResponse = await callInventoryPost('consumeItem', payload);
    const item = unwrapGasResponse(gasResponse);
    res.json(item);
  } catch (err) {
    console.error('POST /api/items/use Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫消費に失敗しました' });
  }
});

app.post('/api/items/archive', requireInventoryAuth, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      user: req.inventoryUser.username || 'Unknown',
    };

    const gasResponse = await callInventoryPost('archiveItem', payload);
    const result = unwrapGasResponse(gasResponse);
    res.json(result);
  } catch (err) {
    console.error('POST /api/items/archive Error:', err.message || err);
    res.status(500).json({ error: err.message || '在庫アーカイブに失敗しました' });
  }
});

app.post('/api/items/init', requireInventoryAuth, async (req, res) => {
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
    .login-user{
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
    .middle-select{
  font-size:15px;
  font-weight:700;
  padding:10px 14px;
  border-radius:999px;
  min-height:auto;
}

#middleFilterWrap{
  margin-bottom:10px !important;
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
          <div class="login-user" id="loginUserLabel"></div>
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

<div id="middleFilterWrap" style="margin-bottom:14px; display:none;">
  <select id="filterCategoryM" class="select middle-select">
    <option value="">中分類で絞り込み</option>
  </select>
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
          <label>ログイン管理</label>
          <button class="btn btn-danger" style="width:100%; border-radius:18px; padding:14px 16px;" id="logoutBtn">ログアウト</button>
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
      <div class="pin-title">ログイン</div>
      <div class="pin-note">名前とPINコードを入力してください</div>
      <div class="field">
        <input id="loginUsernameInput" class="input" type="text" placeholder="名前" />
      </div>
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
    let currentToken = '';
    let currentUser = null;

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
middleFilterWrap: document.getElementById('middleFilterWrap'),
filterCategoryM: document.getElementById('filterCategoryM'),

      loginUserLabel: document.getElementById('loginUserLabel'),

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
      logoutBtn: document.getElementById('logoutBtn'),

      modalBackdrop: document.getElementById('modalBackdrop'),
      modalTitle: document.getElementById('modalTitle'),
      modalBody: document.getElementById('modalBody'),
      closeModalBtn: document.getElementById('closeModalBtn'),

      pinBackdrop: document.getElementById('pinBackdrop'),
      loginUsernameInput: document.getElementById('loginUsernameInput'),
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

    function saveAuth(user, token) {
      currentUser = user || null;
      currentToken = token || '';
      localStorage.setItem('inventory_auth', JSON.stringify({
        user: currentUser,
        token: currentToken
      }));
      updateLoginUserLabel();
    }

    function clearAuth() {
      currentUser = null;
      currentToken = '';
      localStorage.removeItem('inventory_auth');
      localStorage.removeItem('inventory_setup_done');
      updateLoginUserLabel();
    }

    function loadAuth() {
      try {
        const raw = localStorage.getItem('inventory_auth');
        if (!raw) {
          currentUser = null;
          currentToken = '';
          updateLoginUserLabel();
          return;
        }
        const auth = JSON.parse(raw);
        currentUser = auth.user || null;
        currentToken = auth.token || '';
        updateLoginUserLabel();
      } catch {
        currentUser = null;
        currentToken = '';
        updateLoginUserLabel();
      }
    }

    function updateLoginUserLabel() {
      if (currentUser && currentUser.username) {
        els.loginUserLabel.textContent = 'ログイン中: ' + currentUser.username;
      } else {
        els.loginUserLabel.textContent = '';
      }
    }

    function authHeaders(extra = {}) {
      return {
        ...extra,
        Authorization: 'Bearer ' + currentToken
      };
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
          applyTheme(settings.theme);
        });
      });
    }

    function checkLoginFlow() {
      if (!currentToken) {
        els.pinBackdrop.classList.add('show');
        return;
      }

      if (localStorage.getItem('inventory_setup_done') !== '1') {
        renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
        els.setupBackdrop.classList.add('show');
      }
    }

    async function apiFetch(url, options = {}) {
      const res = await fetch(url, {
        ...options,
        headers: authHeaders(options.headers || {})
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || '通信エラーが発生しました');
      }

      return data;
    }

    async function validateSessionOnLoad() {
      if (!currentToken) {
        clearAuth();
        els.pinBackdrop.classList.add('show');
        return false;
      }

      try {
        const data = await apiFetch('/api/session');
        currentUser = data.user || null;
        saveAuth(currentUser, currentToken);
        return true;
      } catch (err) {
        clearAuth();
        els.pinBackdrop.classList.add('show');
        return false;
      }
    }

    async function submitPin() {
      const username = els.loginUsernameInput.value.trim();
      const pin = els.pinInput.value.trim();

      if (!username) {
        alert('名前を入力してください');
        return;
      }

      if (!pin) {
        alert('PINコードを入力してください');
        return;
      }

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, pin })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          throw new Error(data.error || 'ログインに失敗しました');
        }

        saveAuth(data.user, data.token);
        els.pinBackdrop.classList.remove('show');
        els.pinInput.value = '';

        if (localStorage.getItem('inventory_setup_done') !== '1') {
          renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
          els.setupBackdrop.classList.add('show');
        } else {
          els.settingPosterName.value = settings.posterName;
        }

        await reloadAll();
      } catch (err) {
        alert(err.message || 'ログインに失敗しました');
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

    function logout() {
      clearAuth();
      allItems = [];
      filteredItems = [];
      els.itemsContainer.innerHTML = '<div class="empty">ログアウトしました。</div>';
      els.pinBackdrop.classList.add('show');
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
  const result = uniqueSorted(
    masterCategories
      .filter(row => safeText(row.large_name).trim() === safeText(largeName).trim())
      .map(row => row.middle_name)
  );

  console.log('getMiddleNames largeName =', largeName);
  console.log(
    'matched rows =',
    masterCategories.filter(row => safeText(row.large_name).trim() === safeText(largeName).trim())
  );
  console.log('result =', result);

  return result;
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
      console.log('tab clicked =', activeMainTab);

      els.filterCategoryM.value = '';
       renderMainTabs();
      refreshMiddleFilterOptions();
      filterItems();
    });
  });
}

function refreshMiddleFilterOptions() {
  let middleList = [];
  const currentSelectedM = safeText(els.filterCategoryM.value).trim();

  if (activeMainTab !== 'all') {
    middleList = getMiddleNames(activeMainTab);
    els.middleFilterWrap.style.display = 'block';
  } else {
    els.middleFilterWrap.style.display = 'none';
  }

  console.log('middleList =', middleList);

  setSelectOptions(els.filterCategoryM, middleList, '中分類で絞り込み');

  if (middleList.includes(currentSelectedM)) {
    els.filterCategoryM.value = currentSelectedM;
  } else {
    els.filterCategoryM.value = '';
  }
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

function openImagePreview(src, title) {
  let html = '';
  html += '<div style="text-align:center;">';
  html += '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(title || '') + '" ';
  html += 'style="max-width:100%; max-height:75vh; border-radius:16px; object-fit:contain;" />';
  if (title) {
    html += '<div style="margin-top:12px; font-size:14px; color:#aab4cc;">' + escapeHtml(title) + '</div>';
  }
  html += '</div>';

  openModal('写真プレビュー', html);
}

function filterItems() {
  const q = safeText(els.searchInput.value).trim().toLowerCase();
  const selectedM = safeText(els.filterCategoryM.value).trim();

  filteredItems = allItems.filter((item) => {
    const qty = Number(item.qty || 0);
    const itemL = safeText(item.category_l).trim();
    const itemM = safeText(item.category_m).trim();
    const itemS = safeText(item.category_s).trim();

    if (qty <= 0) return false;

    if (activeMainTab !== 'all' && itemL !== activeMainTab) {
      return false;
    }

    if (selectedM && itemM !== selectedM) {
      return false;
    }

    if (q) {
      const hay = [
        item.name,
        itemL,
        itemM,
        itemS,
        item.location,
        item.status
      ].join(' ').toLowerCase();

      if (!hay.includes(q)) return false;
    }

    return true;
  });

  console.log('activeMainTab =', activeMainTab);
  console.log('selectedM =', selectedM);
  console.log('filtered count =', filteredItems.length);

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

      thumbHtml =
        '<img src="' + c0 + '" alt="' + escapeHtml(item.name || '') + '"' +
        ' style="cursor:pointer;"' +
        ' onclick="openImagePreview(\\'' + c0 + '\\', \\''
        + escapeHtml(item.name || '') +
        '\\')"' +
        ' onerror="if(!this.dataset.f1 && \\''
        + c1 +
        '\\'){this.dataset.f1=\\'1\\';this.src=\\'' +
        c1 +
        '\\';this.setAttribute(\\'onclick\\', \\'openImagePreview(\\\\\\'' + c1 + '\\\\\\', \\\\\\''
        + escapeHtml(item.name || '') +
        '\\\\\\')\\');return;} if(!this.dataset.f2 && \\''
        + c2 +
        '\\'){this.dataset.f2=\\'1\\';this.src=\\'' +
        c2 +
        '\\';this.setAttribute(\\'onclick\\', \\'openImagePreview(\\\\\\'' + c2 + '\\\\\\', \\\\\\''
        + escapeHtml(item.name || '') +
        '\\\\\\')\\');return;} this.onerror=null; this.outerHTML=\\'<span>画像なし</span>\\';"' +
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
      const data = await apiFetch('/api/master');

      masterCategories = Array.isArray(data.categories) ? data.categories : [];
      masterLocations = Array.isArray(data.locations) ? data.locations : [];

      refreshCategorySelects();
refreshLocationSelect();
renderMainTabs();
refreshMiddleFilterOptions();

    }

    async function loadItems() {
      const data = await apiFetch('/api/items');

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

        const data = await apiFetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (data.error) throw new Error(data.error);

        alert('登録しました');

        els.name.value = '';
        els.qty.value = '1';
        els.unit.value = '個';
        els.threshold.value = '';
        els.note.value = '';
        els.categoryL.value = '';
        els.categoryM.value = '';
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
          note: document.getElementById('consume_note').value.trim() || '使用・消費'
        };

        if (!payload.consume_qty || payload.consume_qty <= 0) {
          alert('消費数を入力してください');
          return;
        }

        const data = await apiFetch('/api/items/use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (data.error) throw new Error(data.error);

        closeModal();
        await loadItems();
      } catch (err) {
        alert(err.message || '消費処理に失敗しました');
      }
    }

  async function editItem(itemId) {
  try {
    const item = await apiFetch('/api/items/' + encodeURIComponent(itemId));
    if (item.error) throw new Error(item.error);

    const largeList = getLargeNames();
    const middleList = item.category_l ? getMiddleNames(item.category_l) : [];
    const smallList = item.category_l && item.category_m
      ? getSmallNames(item.category_l, item.category_m)
      : [];
    const locationList = uniqueSorted(masterLocations);

    function buildOptions(values, selectedValue, placeholder) {
      let html = '<option value="">' + escapeHtml(placeholder) + '</option>';
      values.forEach((v) => {
        const selected = safeText(v).trim() === safeText(selectedValue).trim() ? ' selected' : '';
        html += '<option value="' + escapeHtml(v) + '"' + selected + '>' + escapeHtml(v) + '</option>';
      });
      return html;
    }

    let html = '';
    html += '<div class="field"><label>品名</label><input class="input" id="edit_name" value="' + escapeHtml(item.name || '') + '" /></div>';

    html += '<div class="field"><label>保管場所</label>';
    html += '<select class="select" id="edit_location">';
    html += buildOptions(locationList, item.location || '', '保管場所を選択');
    html += '</select></div>';

    html += '<div class="field"><label>大分類</label>';
    html += '<select class="select" id="edit_category_l">';
    html += buildOptions(largeList, item.category_l || '', '大分類を選択');
    html += '</select></div>';

    html += '<div class="field"><label>中分類</label>';
    html += '<select class="select" id="edit_category_m">';
    html += buildOptions(middleList, item.category_m || '', '中分類を選択');
    html += '</select></div>';

    html += '<div class="field"><label>小分類</label>';
    html += '<select class="select" id="edit_category_s">';
    html += buildOptions(smallList, item.category_s || '', '小分類を選択');
    html += '</select></div>';

    html += '<div class="field"><label>在庫個数</label><input class="input" id="edit_qty" type="number" value="' + escapeHtml(item.qty == null ? '' : item.qty) + '" /></div>';
    html += '<div class="field"><label>要発注ライン</label><input class="input" id="edit_threshold" type="number" value="' + escapeHtml(item.threshold == null ? '' : item.threshold) + '" /></div>';
    html += '<div class="field"><label>メモ</label><input class="input" id="edit_note" value="在庫情報更新" /></div>';
    html += '<button class="submit-btn" id="editSubmitBtn">更新する</button>';

    openModal('在庫を編集', html);

    const editCategoryL = document.getElementById('edit_category_l');
    const editCategoryM = document.getElementById('edit_category_m');
    const editCategoryS = document.getElementById('edit_category_s');
    const editSubmitBtn = document.getElementById('editSubmitBtn');

    function rebuildMiddle(selectedMiddle = '', selectedSmall = '') {
      const l = editCategoryL.value;
      const mids = l ? getMiddleNames(l) : [];
      editCategoryM.innerHTML = buildOptions(mids, selectedMiddle, '中分類を選択');

      const m = editCategoryM.value;
      const sms = l && m ? getSmallNames(l, m) : [];
      editCategoryS.innerHTML = buildOptions(sms, selectedSmall, '小分類を選択');
    }

    function rebuildSmall(selectedSmall = '') {
      const l = editCategoryL.value;
      const m = editCategoryM.value;
      const sms = l && m ? getSmallNames(l, m) : [];
      editCategoryS.innerHTML = buildOptions(sms, selectedSmall, '小分類を選択');
    }

    editCategoryL.addEventListener('change', () => {
      rebuildMiddle('', '');
    });

    editCategoryM.addEventListener('change', () => {
      rebuildSmall('');
    });

    editSubmitBtn.addEventListener('click', () => {
      submitEdit(itemId);
    });

  } catch (err) {
    alert(err.message || '編集情報の取得に失敗しました');
  }
}

async function submitEdit(itemId) {
  try {
    const payload = {
      item_id: itemId,
      name: document.getElementById('edit_name').value.trim(),
      location: document.getElementById('edit_location').value.trim(),
      category_l: document.getElementById('edit_category_l').value.trim(),
      category_m: document.getElementById('edit_category_m').value.trim(),
      category_s: document.getElementById('edit_category_s').value.trim(),
      qty: Number(document.getElementById('edit_qty').value || 0),
      threshold: document.getElementById('edit_threshold').value === ''
        ? ''
        : Number(document.getElementById('edit_threshold').value || 0),
      note: document.getElementById('edit_note').value.trim() || '在庫情報更新'
    };

    if (!payload.name) {
      alert('品名を入力してください');
      return;
    }
    if (!payload.location) {
      alert('保管場所を選択してください');
      return;
    }
    if (!payload.category_l) {
      alert('大分類を選択してください');
      return;
    }
    if (payload.qty < 0) {
      alert('在庫個数は0以上で入力してください');
      return;
    }

    const data = await apiFetch('/api/items/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (data.error) throw new Error(data.error);

    closeModal();
    await loadItems();
  } catch (err) {
    alert(err.message || '更新に失敗しました');
  }
}

    els.searchInput.addEventListener('input', filterItems);
    els.filterCategoryM.addEventListener('change', () => {
 filterItems();
});

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
    els.loginUsernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin();
    });

    els.setupSaveBtn.addEventListener('click', submitInitialSetup);
    els.saveSettingsBtn.addEventListener('click', saveAccountSettings);
    els.logoutBtn.addEventListener('click', logout);

    loadSettings();
    loadAuth();
    renderThemeButtons(els.themeGrid, settings.theme, 'account');
    renderPhotoPreview();
    checkLoginFlow();

    (async () => {
      const ok = await validateSessionOnLoad();
      if (!ok) return;

      await reloadAll().catch((err) => {
        els.itemsContainer.innerHTML = '<div class="empty">読み込みに失敗しました<br>' + escapeHtml(err.message || '') + '</div>';
      });

      if (localStorage.getItem('inventory_setup_done') !== '1') {
        renderThemeButtons(els.setupThemeGrid, settings.theme, 'setup');
        els.setupBackdrop.classList.add('show');
      }
    })();

    window.consumeItem = consumeItem;
    window.submitConsume = submitConsume;
    window.editItem = editItem;
    window.submitEdit = submitEdit;
    window.openImagePreview = openImagePreview;
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
