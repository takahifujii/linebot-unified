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
// 簡易在庫管理画面
// ------------------------------------------
app.get('/inventory', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>在庫管理</title>
  <style>
    body { font-family: sans-serif; margin: 20px; line-height: 1.5; }
    h1, h2 { margin-bottom: 12px; }
    .box { border: 1px solid #ccc; padding: 16px; margin-bottom: 20px; border-radius: 8px; }
    input, select, button, textarea { padding: 8px; margin: 4px 0; width: 100%; box-sizing: border-box; }
    button { width: auto; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; font-size: 14px; vertical-align: top; }
    th { background: #f5f5f5; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 12px; color: #666; }
    img.thumb { width: 80px; height: auto; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>在庫管理</h1>
  <p class="small">この画面は Render 上の Node アプリ → GAS → スプレッドシート で動いています。</p>

  <div class="box">
    <h2>新規登録</h2>
    <div class="row">
      <div>
        <label>品名</label>
        <input id="name" placeholder="例: 給湯器リモコン" />
      </div>
      <div>
        <label>保管場所</label>
        <input id="location" placeholder="例: 倉庫A" />
      </div>
    </div>

    <div class="row">
      <div>
        <label>大カテゴリ</label>
        <input id="category_l" placeholder="例: 給湯器" />
      </div>
      <div>
        <label>中カテゴリ</label>
        <input id="category_m" placeholder="例: リモコン" />
      </div>
    </div>

    <div class="row">
      <div>
        <label>小カテゴリ</label>
        <input id="category_s" placeholder="例: 台所用" />
      </div>
      <div>
        <label>数量</label>
        <input id="qty" type="number" value="1" />
      </div>
    </div>

    <div class="row">
      <div>
        <label>単位</label>
        <input id="unit" value="個" />
      </div>
      <div>
        <label>しきい値</label>
        <input id="threshold" type="number" value="0" />
      </div>
    </div>

    <div class="row">
      <div>
        <label>登録者</label>
        <input id="user" placeholder="例: 藤井" />
      </div>
      <div>
        <label>メモ</label>
        <input id="note" placeholder="例: まとめ買い" />
      </div>
    </div>

    <label>
      <input id="addIfSameName" type="checkbox" checked style="width:auto;" />
      同名があれば加算する
    </label>

    <button onclick="createItem()">登録する</button>
    <button onclick="loadItems()">一覧を再読み込み</button>
  </div>

  <div class="box">
    <h2>一覧</h2>
    <table>
      <thead>
        <tr>
          <th>品名</th>
          <th>カテゴリ</th>
          <th>場所</th>
          <th>数量</th>
          <th>状態</th>
          <th>画像</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="itemsBody"></tbody>
    </table>
  </div>

  <script>
    async function loadItems() {
      const res = await fetch('/api/items');
      const data = await res.json();
      const tbody = document.getElementById('itemsBody');
      tbody.innerHTML = '';

      if (!Array.isArray(data)) {
        tbody.innerHTML = '<tr><td colspan="7">データ取得失敗</td></tr>';
        return;
      }

      data.forEach(item => {
        const tr = document.createElement('tr');

        const photoHtml = item.photo_urls
          ? item.photo_urls.split(',').filter(Boolean).map(url => '<a href="' + url + '" target="_blank"><img class="thumb" src="' + url + '" /></a>').join('<br>')
          : '';

        tr.innerHTML = \`
          <td>\${item.name || ''}</td>
          <td>\${item.category_l || ''}<br>\${item.category_m || ''}<br>\${item.category_s || ''}</td>
          <td>\${item.location || ''}</td>
          <td>\${item.qty || 0} \${item.unit || ''}</td>
          <td>\${item.status || ''}</td>
          <td>\${photoHtml}</td>
          <td>
            <div class="actions">
              <button onclick="consumePrompt('\${item.item_id}', '\${item.name || ''}')">消費</button>
              <button onclick="archiveItem('\${item.item_id}', '\${item.name || ''}')">アーカイブ</button>
            </div>
          </td>
        \`;

        tbody.appendChild(tr);
      });
    }

    async function createItem() {
      const payload = {
        name: document.getElementById('name').value,
        category_l: document.getElementById('category_l').value,
        category_m: document.getElementById('category_m').value,
        category_s: document.getElementById('category_s').value,
        location: document.getElementById('location').value,
        qty: Number(document.getElementById('qty').value || 0),
        unit: document.getElementById('unit').value,
        threshold: Number(document.getElementById('threshold').value || 0),
        user: document.getElementById('user').value || 'Unknown',
        note: document.getElementById('note').value || 'Node画面から登録',
        addIfSameName: document.getElementById('addIfSameName').checked
      };

      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.error) {
        alert('エラー: ' + data.error);
        return;
      }

      alert('登録しました');
      loadItems();
    }

    async function consumePrompt(itemId, name) {
      const qty = prompt(name + ' をいくつ消費しますか？');
      if (!qty) return;

      const user = prompt('担当者名を入れてください', 'Unknown') || 'Unknown';
      const note = prompt('メモ', '使用・消費') || '使用・消費';

      const res = await fetch('/api/items/use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: itemId,
          consume_qty: Number(qty),
          user,
          note
        })
      });

      const data = await res.json();
      if (data.error) {
        alert('エラー: ' + data.error);
        return;
      }

      alert('消費処理しました');
      loadItems();
    }

    async function archiveItem(itemId, name) {
      const ok = confirm(name + ' をアーカイブしますか？');
      if (!ok) return;

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
        alert('エラー: ' + data.error);
        return;
      }

      alert('アーカイブしました');
      loadItems();
    }

    loadItems();
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
  
  console.log(\`Server is running on port ${PORT}`);
});
