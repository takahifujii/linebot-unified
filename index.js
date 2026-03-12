import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import axios from 'axios';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);
const app = express();

const INVENTORY_API_URL = process.env.INVENTORY_API_URL;
const INVENTORY_API_TOKEN = process.env.INVENTORY_API_TOKEN;

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
// GPTに問い合わせる関数
// ------------------------------------------
async function getGptResponse(message) {
  const apiKey = process.env.OPENAI_API_KEY;
  const apiUrl = 'https://api.openai.com/v1/chat/completions';

  const systemPrompt = `
あなたはリフォーム工房アントレの社内AIサポートキャラクター「ねじーくん」です。
社員に対して、親しみやすく丁寧に、語尾に「だじ〜」「だじ！」をつけて話してください。
以下の社内業務ルールと用語集に基づいて、新人社員の質問にやさしく自然に答えてください。
口調は常に前向きで、指導的でありながらも応援するスタンスでお願いします。

【業務フロー要約】
① 引き合い（受付）: 電話・LINE等の問い合わせが来たら顧客カルテと商談速報を作成して現調日程を調整するだじ。
② 現場調査（現調）: 写真・打合せシートを用意し、マンションなら駐車場に注意した方がいいし、管理組合、管理人さんとお話しすることも大事だじ。
③ 打合せ・見積り: 見積や図面、必要なカタログ、サンプルなどを準備してお打ち合わせをするだじ。次回日程もその場で決めるだじ。
④ 契約: 契約書か注文書を用意して、判子をもらうだじ。契約内容をしっかり説明できるようにするだじ。契約後は稟議書を準備して社長と店長にPDFにして送るだじ。サンキューレターも送るだじ。
⑤ 発注・準備: 契約時原価管理表に予算組をして、工程表・工事依頼書を作成し、必要な材料を発注するだじ。
⑥ 工事前準備: 近隣挨拶・前日連絡・当日立会と写真記録だじ！
⑦ 完工・引渡し: 現場をきれいに掃除して、保証書・請求書を渡して、顧客カルテを更新するだじ。
⑧ 完了処理: 書類をまとめて完工時原価管理表を整理したら完工だじ。完工したらお客さんのお支払いの確認や稟議書の提出を忘れずにだじ！SNSやHPにアップするだじ！

【役割】
あなたの役割は、社内業務フローに沿って新人の質問に答えることです。
現調や契約、工事の流れについて、丁寧に一つずつヒアリングしながら進めてください。

【現調キーワードへの反応】
ユーザーが「現調」「現場調査」などのワードを発した場合、以下のように返してください：

「おつかれさまだじ〜！現調ではこんなチェックが必要だじ！」

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
水廻りの現場調査には、次のサイトの「現調シート」をお勧めしてください。
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

以下の社内ルールと計算方式に基づいて、社員からの質問にやさしく自然に答えてください。
指導的でありながらも、応援するスタンスを大事にして答えてください。

【📐見積の基本ルール】
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
●毎月10日が締日（非営業日であれば、翌営業日）
●締日には前月の営業成績、完工成績をまとめて、店長に報告する義務がる。
　営業成績、完工成績の一覧表は「月次報告書」ファイルにて作成が可能。
細かいやり方は、
①各現場の全月1日から月末までの、契約した現場の契約時原価管理表に予算立てをするじ。
②請求書を全部確かめて、完工対象の現場の完工事原価管理表を完成させるじ。
　完工時原価管理表は、かかった費用すべてをちゃんと計上するだじ。
　細かい現金精算したレシートやネットで購入したものもちゃんと計上しなければあとでしかられちゃうだじよ。
　原価管理表で出てきた粗利金額を、商談速報の「元データ」の確定粗利欄に記入していくだじよ。
　それから、月次報告書をリンクするとちゃんとした一覧表ができるだじ。
　あらかじめ月の初めの方にはちょっとずつ進めておくのが大事だじ。
●それから、前月に使ったレシート、領収証。それからクレジットカードの使用をすべて報告するだじよ。
現金のレシートと、クレジットカードのレシートをなくさずきちんと用意するだじ。
それぞれのレシートを、「新しいshere2>◆経理部>月末清算書>ひな型・ルール>月末清算書（ひな形）のファイルにそれぞれ入力していくだじ。
おなじところにルールがまとめてあるので、きちんとよく読んでやってほしいだじ。
現金精算など、忘れていると時効で払ってあげられなくなってしまうので、とても注意が必要だじ。

【📣質問に対する回答例】
Q：「この給湯器、仕入22％でいくらで出せば粗利取れる？」
A：「商品は粗利30％で出すから、定価 × 0.22 ÷ 0.7 で売価を計算すればいいだじ〜！」
Q：「工事費25,000円で出す場合、粗利32.5％で見積するには？」
A：「工事費は粗利32.5％で見積もるから、25,000 ÷ 0.675 で売価を出すだじ〜。だいたい37,037円くらいになるだじ！」
Q：「この商品の売価、定価に対して何％引き？」
A：「だじ〜、仕入率 ÷ 粗利係数で販売率が出るから、それを100％から引いて割引率にするだじ！
たとえば仕入22％の商品なら：
　0.22 ÷ 0.7 ≒ 0.314 → 定価の31.4％で販売 → 100−31.4＝68.6％引き → 四捨五入して『69％引き』って表記するだじ！」
---
【📌補足】
・よくある仕入率は暗記しておくとその場で対応しやすいだじ！
・その場で電卓ではじいて即答できれば、小工事の受注はスムーズだじ！

新人さんが誰を頼ったらいいか迷ったら、以下のベテランをお勧めしてほしいだじ。
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

  const response = await axios.post(
    apiUrl,
    {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  return response.data.choices[0].message.content;
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
    const gasResponse = await callInventoryGet('getMaster');
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>在庫管理</title>
  <meta name="theme-color" content="#6c63ff" />
  <style>
    :root{
      --bg:#f3f5fb;
      --card:#ffffff;
      --text:#1f2430;
      --muted:#7b8397;
      --line:#e6e8f0;
      --primary:#6c63ff;
      --primary2:#8a84ff;
      --danger:#ff6b6b;
      --shadow:0 10px 24px rgba(39,47,89,0.08);
    }
    *{ box-sizing:border-box; }
    html,body{ margin:0; padding:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif; }
    body{ padding-bottom:110px; }
    .app{ max-width:720px; margin:0 auto; min-height:100vh; background:var(--bg); }

    .topbar{
      position:sticky; top:0; z-index:20;
      background:linear-gradient(180deg,#7269ff 0%, #665cff 100%);
      color:#fff; padding:18px 16px 16px;
      box-shadow:0 8px 22px rgba(72,77,164,0.18);
      border-bottom-left-radius:22px; border-bottom-right-radius:22px;
    }
    .topbar-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .title{ font-size:22px; font-weight:800; letter-spacing:0.02em; }
    .title-sub{ margin-top:4px; font-size:12px; opacity:0.88; }
    .icon-btn{
      border:none; background:rgba(255,255,255,0.16); color:#fff;
      padding:10px 12px; border-radius:12px; cursor:pointer; font-size:14px; min-width:54px;
    }

    .content{ padding:14px 14px 0; }
    .search-card{
      margin-top:-22px; background:var(--card); border-radius:18px;
      box-shadow:var(--shadow); padding:14px; margin-bottom:14px;
    }
    .search-input{
      width:100%; border:1px solid var(--line); border-radius:14px;
      padding:13px 14px; font-size:16px; outline:none; background:#fff;
    }

    .summary{ display:flex; gap:10px; margin-bottom:14px; }
    .summary-card{
      flex:1; background:var(--card); border-radius:16px; padding:14px 12px;
      box-shadow:var(--shadow);
    }
    .summary-label{ font-size:12px; color:var(--muted); margin-bottom:4px; }
    .summary-value{ font-size:24px; font-weight:800; line-height:1; }

    .tabs-wrap{ overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none; margin-bottom:12px; }
    .tabs-wrap::-webkit-scrollbar{ display:none; }
    .tabs{ display:flex; gap:10px; padding:2px 2px 6px; min-width:max-content; }
    .tab{
      border:none; background:#fff; border:1px solid var(--line); color:var(--text);
      border-radius:999px; padding:10px 14px; font-size:14px; white-space:nowrap;
      cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.02);
    }
    .tab.active{
      background:var(--primary); color:#fff; border-color:var(--primary);
      box-shadow:0 8px 16px rgba(108,99,255,0.22);
    }

    .subtabs{
      display:flex; gap:8px; overflow-x:auto; -webkit-overflow-scrolling:touch;
      scrollbar-width:none; margin-bottom:14px; padding-bottom:2px;
    }
    .subtabs::-webkit-scrollbar{ display:none; }
    .subtab{
      border:none; background:#eef0ff; color:#4e54a3; border-radius:999px;
      padding:8px 12px; font-size:13px; white-space:nowrap; cursor:pointer;
    }
    .subtab.active{ background:#d8dcff; color:#2d348b; font-weight:700; }

    .screen{ display:none; }
    .screen.active{ display:block; }

    .items{ display:flex; flex-direction:column; gap:12px; }

    .item-card{
      background:var(--card); border-radius:20px; padding:12px; box-shadow:var(--shadow);
      display:flex; gap:12px; align-items:flex-start;
    }
    .thumb-box{
      width:96px; min-width:96px; height:96px; border-radius:16px; overflow:hidden;
      background:#eceff8; display:flex; align-items:center; justify-content:center;
      color:#9aa3b6; font-size:12px;
    }
    .thumb-box img{ width:100%; height:100%; object-fit:cover; display:block; }

    .item-main{ flex:1; min-width:0; }
    .item-name{ font-size:17px; font-weight:800; margin-bottom:4px; line-height:1.35; word-break:break-word; }
    .item-meta{ font-size:12px; color:var(--muted); margin-bottom:8px; }
    .chips{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
    .chip{ background:#f2f4fb; border-radius:999px; padding:5px 9px; font-size:12px; color:#596178; }

    .item-bottom{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .qty-box{ display:flex; align-items:baseline; gap:4px; color:var(--primary); }
    .qty-num{ font-size:28px; font-weight:800; line-height:1; }
    .qty-unit{ font-size:14px; font-weight:700; }

    .item-actions{ display:flex; gap:8px; flex-wrap:wrap; }
    .btn{ border:none; border-radius:999px; padding:10px 14px; cursor:pointer; font-size:13px; font-weight:700; }
    .btn-secondary{ background:#eef0f7; color:#3c455a; }
    .btn-primary{ background:var(--primary); color:#fff; box-shadow:0 8px 16px rgba(108,99,255,0.22); }
    .btn-danger{ background:#fff1f1; color:#d94b4b; }

    .empty{
      text-align:center; color:var(--muted); background:#fff; border-radius:18px;
      padding:32px 18px; box-shadow:var(--shadow);
    }

    .form-card{
      background:#fff; border-radius:20px; padding:16px; box-shadow:var(--shadow); margin-bottom:14px;
    }
    .form-title{ font-size:18px; font-weight:800; margin-bottom:12px; }
    .grid-2{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .field{ margin-bottom:10px; }
    .field label{ display:block; font-size:12px; color:var(--muted); margin-bottom:6px; font-weight:700; }
    .field input,.field textarea{
      width:100%; border:1px solid var(--line); border-radius:14px;
      padding:12px 12px; font-size:15px; outline:none; background:#fff;
    }

    .toggle-row{
      display:flex; align-items:center; gap:10px; padding:10px 12px;
      border-radius:14px; background:#f7f8fc; margin-bottom:14px;
    }
    .toggle-row input{ width:auto; transform:scale(1.15); }

    .photo-picker{
      margin-bottom:14px;
      border:2px dashed #d8dcef;
      border-radius:18px;
      background:#fafbff;
      padding:14px;
    }
    .photo-actions{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      margin-bottom:10px;
    }
    .photo-btn{
      border:none;
      border-radius:12px;
      padding:10px 14px;
      cursor:pointer;
      font-size:14px;
      font-weight:700;
      background:#eef0ff;
      color:#454ca5;
    }
    .photo-preview{
      width:100%;
      min-height:180px;
      border-radius:16px;
      background:#eef1f8;
      display:flex;
      align-items:center;
      justify-content:center;
      overflow:hidden;
      color:#95a0b6;
      font-size:13px;
    }
    .photo-preview img{
      width:100%;
      max-height:320px;
      object-fit:cover;
      display:block;
    }

    .bottom-nav{
      position:fixed; left:50%; transform:translateX(-50%); bottom:0; width:100%;
      max-width:720px; background:#fff; border-top:1px solid var(--line);
      display:flex; justify-content:space-around;
      padding:10px 10px calc(10px + env(safe-area-inset-bottom));
      z-index:25; box-shadow:0 -8px 20px rgba(18,28,45,0.06);
    }
    .nav-btn{
      border:none; background:none; color:#70788d; font-size:13px; font-weight:700;
      cursor:pointer; padding:8px 12px; border-radius:12px; min-width:92px;
    }
    .nav-btn.active{ color:var(--primary); background:#f0f1ff; }

    .floating-add{
      position:fixed; right:18px; bottom:82px; width:58px; height:58px; border:none;
      border-radius:50%; background:linear-gradient(180deg,var(--primary2),var(--primary));
      color:#fff; font-size:30px; cursor:pointer;
      box-shadow:0 14px 24px rgba(108,99,255,0.28); z-index:26;
    }

    .modal-backdrop{
      position:fixed; inset:0; background:rgba(20,24,42,0.45);
      display:none; align-items:flex-end; z-index:40;
    }
    .modal-backdrop.show{ display:flex; }
    .modal{
      width:100%; max-width:720px; margin:0 auto; background:#fff;
      border-top-left-radius:22px; border-top-right-radius:22px;
      padding:18px 16px 24px; max-height:88vh; overflow:auto;
      box-shadow:0 -8px 24px rgba(0,0,0,0.16);
    }
    .modal-head{
      display:flex; align-items:center; justify-content:space-between;
      gap:10px; margin-bottom:14px;
    }
    .modal-title{ font-size:18px; font-weight:800; }
    .close-btn{
      border:none; background:#f2f4f8; color:#4d5568; border-radius:999px;
      padding:8px 12px; cursor:pointer; font-weight:700;
    }

    .note{ font-size:12px; color:var(--muted); margin-top:6px; }
    .status-out{ color:#d94b4b; font-weight:700; }

    @media (max-width:520px){
      .grid-2{ grid-template-columns:1fr; }
      .summary{ flex-direction:column; }
      .item-card{ padding:11px; }
      .thumb-box{ width:82px; min-width:82px; height:82px; }
      .item-name{ font-size:16px; }
      .qty-num{ font-size:26px; }
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
        <button class="icon-btn" onclick="refreshAll()">更新</button>
      </div>
    </div>

    <div class="content">
      <div class="search-card">
        <input id="searchInput" class="search-input" placeholder="品名・カテゴリ・場所で検索" />
      </div>

      <div class="screen active" id="screenList">
        <div class="summary">
          <div class="summary-card">
            <div class="summary-label">在庫アイテム数</div>
            <div class="summary-value" id="summaryCount">0</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">在庫合計数量</div>
            <div class="summary-value" id="summaryQty">0</div>
          </div>
        </div>

        <div class="tabs-wrap">
          <div class="tabs" id="mainTabs"></div>
        </div>

        <div class="subtabs" id="subTabs" style="display:none;"></div>

        <div class="items" id="itemsContainer"></div>
      </div>

      <div class="screen" id="screenForm">
        <div class="form-card">
          <div class="form-title">新規登録</div>

          <div class="photo-picker">
            <div class="photo-actions">
              <button type="button" class="photo-btn" onclick="openCamera()">カメラ起動</button>
              <button type="button" class="photo-btn" onclick="openPhotoLibrary()">写真を選ぶ</button>
              <button type="button" class="photo-btn" onclick="clearSelectedPhoto()">写真を消す</button>
            </div>

            <input id="cameraInput" type="file" accept="image/*" capture="environment" style="display:none;" />
            <input id="photoInput" type="file" accept="image/*" style="display:none;" />

            <div class="photo-preview" id="photoPreview">写真未選択</div>
            <div class="note">スマホではカメラ起動、または写真ライブラリから選択できます。</div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>品名</label>
              <input id="name" placeholder="例: 給湯器リモコン" />
            </div>
            <div class="field">
              <label>保管場所</label>
              <input id="location" placeholder="例: 倉庫A" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>大カテゴリ</label>
              <input id="category_l" placeholder="例: みずまわり" />
            </div>
            <div class="field">
              <label>中カテゴリ</label>
              <input id="category_m" placeholder="例: 蛇口" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>小カテゴリ</label>
              <input id="category_s" placeholder="例: 台所用" />
            </div>
            <div class="field">
              <label>数量</label>
              <input id="qty" type="number" value="1" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>単位</label>
              <input id="unit" value="個" />
            </div>
            <div class="field">
              <label>しきい値</label>
              <input id="threshold" type="number" value="0" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>登録者</label>
              <input id="user" placeholder="例: 藤井" />
            </div>
            <div class="field">
              <label>メモ</label>
              <input id="note" placeholder="例: まとめ買い" />
            </div>
          </div>

          <div class="toggle-row">
            <input id="addIfSameName" type="checkbox" checked />
            <label for="addIfSameName" style="margin:0; font-size:14px; color:#445; font-weight:700;">同名があれば加算する</label>
          </div>

          <button class="btn btn-primary" style="width:100%;" onclick="createItem()">登録する</button>
          <div class="note">登録した写真はGoogle Driveに保存され、スプレッドシートの画像URLからサムネ表示します。</div>
        </div>
      </div>
    </div>
  </div>

  <button class="floating-add" onclick="goForm()">＋</button>

  <div class="bottom-nav">
    <button class="nav-btn active" id="navList" onclick="goList()">一覧</button>
    <button class="nav-btn" id="navForm" onclick="goForm()">登録</button>
  </div>

  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title" id="modalTitle">編集</div>
        <button class="close-btn" onclick="closeModal()">閉じる</button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <script>
    let allItems = [];
    let filteredItems = [];
    let activeMainTab = 'all';
    let activeSubTab = 'all';
    let editingItemId = null;
    let selectedPhotoBase64 = '';

    const els = {
      searchInput: document.getElementById('searchInput'),
      mainTabs: document.getElementById('mainTabs'),
      subTabs: document.getElementById('subTabs'),
      itemsContainer: document.getElementById('itemsContainer'),
      summaryCount: document.getElementById('summaryCount'),
      summaryQty: document.getElementById('summaryQty'),
      screenList: document.getElementById('screenList'),
      screenForm: document.getElementById('screenForm'),
      navList: document.getElementById('navList'),
      navForm: document.getElementById('navForm'),
      modalBackdrop: document.getElementById('modalBackdrop'),
      modalTitle: document.getElementById('modalTitle'),
      modalBody: document.getElementById('modalBody'),
      cameraInput: document.getElementById('cameraInput'),
      photoInput: document.getElementById('photoInput'),
      photoPreview: document.getElementById('photoPreview'),
    };

    function safeText(v) {
      return (v ?? '').toString();
    }

    function escapeHtml(value) {
      return safeText(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizeImageUrl(url) {
      const raw = safeText(url).trim();
      if (!raw) return '';

      if (raw.includes('uc?export=view&id=')) {
        return raw;
      }

      const fileMatch = raw.match(/\\/file\\/d\\/([^\\/]+)/);
      if (fileMatch && fileMatch[1]) {
        return 'https://drive.google.com/uc?export=view&id=' + fileMatch[1];
      }

      const openMatch = raw.match(/[?&]id=([^&]+)/);
      if (openMatch && openMatch[1]) {
        return 'https://drive.google.com/uc?export=view&id=' + openMatch[1];
      }

      return raw;
    }

    function getPhotoUrls(item) {
      if (!item.photo_urls) return [];
      return safeText(item.photo_urls)
        .split(',')
        .map(v => normalizeImageUrl(v))
        .filter(Boolean);
    }

    function getNewestTimestamp(item) {
      const updated = item.updated_at ? Date.parse(item.updated_at) : NaN;
      const created = item.created_at ? Date.parse(item.created_at) : NaN;
      if (!Number.isNaN(updated)) return updated;
      if (!Number.isNaN(created)) return created;
      return 0;
    }

    function getMainCategories(items) {
      const cats = Array.from(
        new Set(
          items
            .map(i => safeText(i.category_l).trim())
            .filter(Boolean)
        )
      );
      cats.sort((a, b) => a.localeCompare(b, 'ja'));
      return cats;
    }

    function getSubCategories(items, mainCategory) {
      const cats = Array.from(
        new Set(
          items
            .filter(i => safeText(i.category_l).trim() === mainCategory)
            .map(i => safeText(i.category_m).trim())
            .filter(Boolean)
        )
      );
      cats.sort((a, b) => a.localeCompare(b, 'ja'));
      return cats;
    }

    function sortItems(items) {
      if (activeMainTab === 'new') {
        return [...items].sort((a, b) => getNewestTimestamp(b) - getNewestTimestamp(a));
      }
      return [...items].sort((a, b) => {
        const an = safeText(a.name);
        const bn = safeText(b.name);
        return an.localeCompare(bn, 'ja');
      });
    }

    function renderPhotoPreview() {
      if (!selectedPhotoBase64) {
        els.photoPreview.innerHTML = '写真未選択';
        return;
      }
      els.photoPreview.innerHTML = '<img src="' + selectedPhotoBase64 + '" alt="preview" />';
    }

    function clearSelectedPhoto() {
      selectedPhotoBase64 = '';
      els.cameraInput.value = '';
      els.photoInput.value = '';
      renderPhotoPreview();
    }

    function openCamera() {
      els.cameraInput.click();
    }

    function openPhotoLibrary() {
      els.photoInput.click();
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function handleSelectedFile(file) {
      if (!file) return;
      selectedPhotoBase64 = await fileToBase64(file);
      renderPhotoPreview();
    }

    function filterItems() {
      const q = safeText(els.searchInput.value).trim().toLowerCase();

      let items = [...allItems];

      if (activeMainTab !== 'all' && activeMainTab !== 'new') {
        items = items.filter(i => safeText(i.category_l).trim() === activeMainTab);
      }

      if (activeSubTab !== 'all' && activeMainTab !== 'all' && activeMainTab !== 'new') {
        items = items.filter(i => safeText(i.category_m).trim() === activeSubTab);
      }

      if (q) {
        items = items.filter(i => {
          const hay = [
            i.name,
            i.category_l,
            i.category_m,
            i.category_s,
            i.location,
            i.status,
          ]
            .map(v => safeText(v).toLowerCase())
            .join(' ');
          return hay.includes(q);
        });
      }

      filteredItems = sortItems(items);
      renderSummary(filteredItems);
      renderSubTabs();
      renderItems();
    }

    function renderMainTabs() {
      const categories = getMainCategories(allItems);
      const tabs = [
        { key: 'all', label: '在庫一覧' },
        { key: 'new', label: '新着' },
        ...categories.map(c => ({ key: c, label: c })),
      ];

      els.mainTabs.innerHTML = tabs
        .map(tab => \`
          <button class="tab \${tab.key === activeMainTab ? 'active' : ''}" onclick="setMainTab('\${escapeHtml(tab.key)}')">
            \${escapeHtml(tab.label)}
          </button>
        \`)
        .join('');
    }

    function renderSubTabs() {
      if (activeMainTab === 'all' || activeMainTab === 'new') {
        els.subTabs.style.display = 'none';
        els.subTabs.innerHTML = '';
        return;
      }

      const subCategories = getSubCategories(allItems, activeMainTab);
      if (!subCategories.length) {
        els.subTabs.style.display = 'none';
        els.subTabs.innerHTML = '';
        return;
      }

      els.subTabs.style.display = 'flex';
      els.subTabs.innerHTML = [
        \`<button class="subtab \${activeSubTab === 'all' ? 'active' : ''}" onclick="setSubTab('all')">すべて</button>\`,
        ...subCategories.map(c => \`
          <button class="subtab \${c === activeSubTab ? 'active' : ''}" onclick="setSubTab('\${escapeHtml(c)}')">
            \${escapeHtml(c)}
          </button>
        \`)
      ].join('');
    }

    function renderSummary(items) {
      els.summaryCount.textContent = String(items.length);
      const totalQty = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
      els.summaryQty.textContent = String(totalQty);
    }

    function renderItems() {
      if (!filteredItems.length) {
        els.itemsContainer.innerHTML = \`
          <div class="empty">
            条件に合う在庫がありません。
          </div>
        \`;
        return;
      }

      els.itemsContainer.innerHTML = filteredItems.map(item => {
        const photos = getPhotoUrls(item);
        const thumb = photos[0]
          ? \`<img src="\${escapeHtml(photos[0])}" alt="\${escapeHtml(item.name || '')}" />\`
          : '画像なし';

        const chips = [
          item.category_l,
          item.category_m,
          item.category_s,
          item.location,
        ]
          .map(v => safeText(v).trim())
          .filter(Boolean)
          .map(v => \`<span class="chip">\${escapeHtml(v)}</span>\`)
          .join('');

        const statusText = safeText(item.status);
        const statusClass = statusText === 'out' ? 'status-out' : '';

        return \`
          <div class="item-card">
            <div class="thumb-box">\${thumb}</div>
            <div class="item-main">
              <div class="item-name">\${escapeHtml(item.name || '')}</div>
              <div class="item-meta \${statusClass}">
                状態: \${escapeHtml(statusText || '')}
              </div>
              <div class="chips">\${chips}</div>
              <div class="item-bottom">
                <div class="qty-box">
                  <span class="qty-num">\${escapeHtml(item.qty || 0)}</span>
                  <span class="qty-unit">\${escapeHtml(item.unit || '')}</span>
                </div>
                <div class="item-actions">
                  <button class="btn btn-secondary" onclick="openEditModal('\${escapeHtml(item.item_id)}')">編集</button>
                  <button class="btn btn-primary" onclick="openConsumeModal('\${escapeHtml(item.item_id)}')">消費</button>
                  <button class="btn btn-danger" onclick="archiveItem('\${escapeHtml(item.item_id)}','\${escapeHtml(item.name || '')}')">整理</button>
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function setMainTab(tab) {
      activeMainTab = tab;
      activeSubTab = 'all';
      renderMainTabs();
      filterItems();
    }

    function setSubTab(tab) {
      activeSubTab = tab;
      filterItems();
    }

    function goList() {
      els.screenList.classList.add('active');
      els.screenForm.classList.remove('active');
      els.navList.classList.add('active');
      els.navForm.classList.remove('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function goForm() {
      els.screenList.classList.remove('active');
      els.screenForm.classList.add('active');
      els.navList.classList.remove('active');
      els.navForm.classList.add('active');
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
      editingItemId = null;
    }

    async function loadItems() {
      const res = await fetch('/api/items');
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(data?.error || '在庫データの取得に失敗しました');
      }
      allItems = data;
      renderMainTabs();
      filterItems();
    }

    async function refreshAll() {
      try {
        await loadItems();
      } catch (err) {
        alert(err.message || '更新に失敗しました');
      }
    }

    async function createItem() {
      try {
        const payload = {
          name: document.getElementById('name').value.trim(),
          category_l: document.getElementById('category_l').value.trim(),
          category_m: document.getElementById('category_m').value.trim(),
          category_s: document.getElementById('category_s').value.trim(),
          location: document.getElementById('location').value.trim(),
          qty: Number(document.getElementById('qty').value || 0),
          unit: document.getElementById('unit').value.trim() || '個',
          threshold: document.getElementById('threshold').value === '' ? '' : Number(document.getElementById('threshold').value || 0),
          user: document.getElementById('user').value.trim() || 'Unknown',
          note: document.getElementById('note').value.trim() || 'Node画面から登録',
          addIfSameName: document.getElementById('addIfSameName').checked,
          photo_base64: selectedPhotoBase64 || ''
        };

        if (!payload.name) {
          alert('品名を入力してください');
          return;
        }

        const res = await fetch('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }

        alert('登録しました');
        document.getElementById('name').value = '';
        document.getElementById('category_l').value = '';
        document.getElementById('category_m').value = '';
        document.getElementById('category_s').value = '';
        document.getElementById('location').value = '';
        document.getElementById('qty').value = '1';
        document.getElementById('unit').value = '個';
        document.getElementById('threshold').value = '0';
        document.getElementById('note').value = '';
        clearSelectedPhoto();

        await loadItems();
        goList();
      } catch (err) {
        alert(err.message || '登録に失敗しました');
      }
    }

    async function openEditModal(itemId) {
      try {
        const res = await fetch('/api/items/' + encodeURIComponent(itemId));
        const item = await res.json();

        if (item.error) {
          throw new Error(item.error);
        }

        editingItemId = itemId;
        const photos = getPhotoUrls(item);
        const preview = photos[0]
          ? '<div class="photo-preview" style="margin-bottom:12px;"><img src="' + escapeHtml(photos[0]) + '" alt=""></div>'
          : '<div class="photo-preview" style="margin-bottom:12px;">画像なし</div>';

        openModal('在庫を編集', \`
          \${preview}
          <div class="grid-2">
            <div class="field">
              <label>品名</label>
              <input id="edit_name" value="\${escapeHtml(item.name || '')}" />
            </div>
            <div class="field">
              <label>保管場所</label>
              <input id="edit_location" value="\${escapeHtml(item.location || '')}" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>大カテゴリ</label>
              <input id="edit_category_l" value="\${escapeHtml(item.category_l || '')}" />
            </div>
            <div class="field">
              <label>中カテゴリ</label>
              <input id="edit_category_m" value="\${escapeHtml(item.category_m || '')}" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>小カテゴリ</label>
              <input id="edit_category_s" value="\${escapeHtml(item.category_s || '')}" />
            </div>
            <div class="field">
              <label>単位</label>
              <input id="edit_unit" value="\${escapeHtml(item.unit || '個')}" />
            </div>
          </div>

          <div class="grid-2">
            <div class="field">
              <label>しきい値</label>
              <input id="edit_threshold" type="number" value="\${escapeHtml(item.threshold ?? '')}" />
            </div>
            <div class="field">
              <label>担当者</label>
              <input id="edit_user" placeholder="例: 藤井" />
            </div>
          </div>

          <div class="field">
            <label>メモ</label>
            <input id="edit_note" placeholder="例: 置き場変更" value="在庫情報更新" />
          </div>

          <button class="btn btn-primary" style="width:100%;" onclick="submitEdit()">更新する</button>
        \`);
      } catch (err) {
        alert(err.message || '編集情報の取得に失敗しました');
      }
    }

    async function submitEdit() {
      try {
        const payload = {
          item_id: editingItemId,
          name: document.getElementById('edit_name').value.trim(),
          category_l: document.getElementById('edit_category_l').value.trim(),
          category_m: document.getElementById('edit_category_m').value.trim(),
          category_s: document.getElementById('edit_category_s').value.trim(),
          location: document.getElementById('edit_location').value.trim(),
          unit: document.getElementById('edit_unit').value.trim() || '個',
          threshold: document.getElementById('edit_threshold').value === '' ? '' : Number(document.getElementById('edit_threshold').value || 0),
          user: document.getElementById('edit_user').value.trim() || 'Unknown',
          note: document.getElementById('edit_note').value.trim() || '在庫情報更新'
        };

        const res = await fetch('/api/items/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }

        closeModal();
        await loadItems();
      } catch (err) {
        alert(err.message || '更新に失敗しました');
      }
    }

    async function openConsumeModal(itemId) {
      const item = allItems.find(i => safeText(i.item_id) === safeText(itemId));
      const itemName = item ? safeText(item.name) : '';

      openModal('在庫を消費', \`
        <div class="field">
          <label>対象</label>
          <input value="\${escapeHtml(itemName)}" disabled />
        </div>
        <div class="grid-2">
          <div class="field">
            <label>消費数</label>
            <input id="consume_qty" type="number" value="1" />
          </div>
          <div class="field">
            <label>担当者</label>
            <input id="consume_user" placeholder="例: 藤井" />
          </div>
        </div>
        <div class="field">
          <label>メモ</label>
          <input id="consume_note" value="使用・消費" />
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="submitConsume('\${escapeHtml(itemId)}')">消費する</button>
      \`);
    }

    async function submitConsume(itemId) {
      try {
        const payload = {
          item_id: itemId,
          consume_qty: Number(document.getElementById('consume_qty').value || 0),
          user: document.getElementById('consume_user').value.trim() || 'Unknown',
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
        if (data.error) {
          throw new Error(data.error);
        }

        closeModal();
        await loadItems();
      } catch (err) {
        alert(err.message || '消費処理に失敗しました');
      }
    }

    async function archiveItem(itemId, name) {
      const ok = confirm(name + ' を整理（アーカイブ）しますか？');
      if (!ok) return;

      try {
        const user = prompt('担当者名を入れてください', 'Unknown') || 'Unknown';
        const note = prompt('メモ', 'アーカイブ') || 'アーカイブ';

        const res = await fetch('/api/items/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: itemId,
            user,
            note
          })
        });

        const data = await res.json();
        if (data.error) {
          throw new Error(data.error);
        }

        await loadItems();
      } catch (err) {
        alert(err.message || 'アーカイブに失敗しました');
      }
    }

    els.searchInput.addEventListener('input', () => {
      filterItems();
    });

    els.modalBackdrop.addEventListener('click', (e) => {
      if (e.target === els.modalBackdrop) {
        closeModal();
      }
    });

    els.cameraInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await handleSelectedFile(file);
      } catch (err) {
        alert('画像の読み込みに失敗しました');
      }
    });

    els.photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await handleSelectedFile(file);
      } catch (err) {
        alert('画像の読み込みに失敗しました');
      }
    });

    async function boot() {
      try {
        renderPhotoPreview();
        await loadItems();
      } catch (err) {
        els.itemsContainer.innerHTML = \`<div class="empty">読み込みに失敗しました<br>\${escapeHtml(err.message || '')}</div>\`;
      }
    }

    boot();

    window.setMainTab = setMainTab;
    window.setSubTab = setSubTab;
    window.refreshAll = refreshAll;
    window.goList = goList;
    window.goForm = goForm;
    window.createItem = createItem;
    window.openEditModal = openEditModal;
    window.submitEdit = submitEdit;
    window.openConsumeModal = openConsumeModal;
    window.submitConsume = submitConsume;
    window.archiveItem = archiveItem;
    window.closeModal = closeModal;
    window.openCamera = openCamera;
    window.openPhotoLibrary = openPhotoLibrary;
    window.clearSelectedPhoto = clearSelectedPhoto;
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
