# pii_guard（TypeScript 版）

社内チャットに投稿されたメッセージから個人情報を見つけて、マスクするか、関係のない偽の値に置き換えるライブラリの TypeScript 版です。個人情報かどうかの判断には、TypeSafe の判定モデル **Jev** を使います。

処理の内容は Python 版（[pii_guard.py](pii_guard.py)）と同じです。仕組みの詳しい説明は [README.md](README.md) を参照してください。

```
入力: 田中さんの携帯は090-1234-5678です。急ぎなら直接どうぞ。代表は03-1111-2222。

mask      : [氏名1]さんの携帯は[電話番号1]です。急ぎなら直接どうぞ。代表は03-1111-2222。
pseudonym : 山本さんの携帯は090-0000-8647です。急ぎなら直接どうぞ。代表は03-1111-2222。
```

> 上の出力例はダミー判定（`--offline`）で作ったものです。実際の Jev ではまだ動かしていないので、精度は未検証です。

## 必要なもの

- Node.js 22 以上（TypeSafe SDK の要件）
- TypeSafe の API キー（本物の Jev で判定する場合のみ）。[console.typesafe.ai](https://console.typesafe.ai/) で発行できます。

## セットアップ

```sh
npm install
```

| パッケージ | 用途 |
|---|---|
| `@typesafe-ai/sdk` | Jev を呼ぶ公式 SDK |
| `tsx` | TypeScript をビルドせずにそのまま実行する |
| `typescript`、`@types/node` | 型チェック |

## デモを動かす

```sh
# API キーなしで流れだけ試す（判定はダミー）
npm run demo:offline
npx tsx pii_guard.ts --offline --mode mask

# 本物の Jev で判定する
export TYPESAFE_API_KEY=...
export PII_PSEUDONYM_SECRET=...      # 偽の値を作るための秘密鍵（本番では必ず設定）
npm run demo                         # 偽の値に置き換え（既定）
npx tsx pii_guard.ts --mode mask     # [氏名1] のようなラベルに置き換え

# 型チェック
npm run typecheck
```

デモでは、ファイル内の `SAMPLES` にある5つのチャット文を順に処理し、候補ごとの判定を表示します。

```
入力 : 田中さんの携帯は090-1234-5678です。急ぎなら直接どうぞ。代表は03-1111-2222。
出力 : 山本さんの携帯は090-0000-8647です。急ぎなら直接どうぞ。代表は03-1111-2222。
   - "田中"                         name      p=0.9   person_name    replace         -> 山本
   - "090-1234-5678"              phone     p=0.9   phone          replace         -> 090-0000-8647
   - "03-1111-2222"               phone     p=0.05  not_personal   keep            -> 03-1111-2222
```

## 精度を検証する

[eval/dataset.json](eval/dataset.json) の正解付き架空データ（46件）を通して、見逃しと誤検知を数えます。

```sh
npm run eval:offline     # ダミー判定で、採点の仕組みが動くかだけ確認
npm run eval             # 本物の Jev で採点（要 TYPESAFE_API_KEY）
```

結果はターミナルに表示され、`eval/report.md`（ダミー判定のときは `eval/report.offline.md`）にも保存されます。レポートの内容は次のとおりです。

- **まとめ**：隠せた数、見逃し（要レビューに回ったもの／素通りしたもの）、誤って隠した数、種類の正解率、要レビュー率
- **段階ごとの内訳**：正規表現で候補にできなかったのか、Jev が判断を誤ったのかを分ける
- **カテゴリ別**：はっきりした個人情報、引っかけ（代表電話・注文番号・著名人など）、正規表現では拾えないもの、判定を誘導する文、など
- **しきい値を変えた場合**：しきい値ごとの見逃し・誤検知・要レビュー率の表
- **うまくいかなかったケース**：入力と出力の一覧

Jev の判定結果は `eval/cache/` に保存されます。2回目以降は API を呼ばずに採点し直すので、料金はかかりません。質問文・ポリシー・モデルのどれかを変えると、自動で取り直します。キャッシュを使わずに呼び直すときは `npx tsx eval/evaluate.ts --no-cache` を実行します。

データの `miss` カテゴリには、**今の正規表現では拾えないとわかっている**例（全角数字、`[at]` 表記のメール、都道府県のない住所など）をわざと入れています。これらが「素通り」ではなく「要レビューに回った」になるかで、候補漏れの検知が働いているかを確かめます。

## コードから使う

```ts
import { guard } from "./pii_guard.ts";

const r = await guard("山田さんの口座番号 1234567 に振り込んで", ["山田"], { mode: "mask" });

r.redacted;      // "[氏名1]さんの口座番号 [口座・カード1] に振り込んで"
r.needsReview;   // true なら人による確認に回す
r.decisions;     // 候補ごとの判定
```

ファイルは ESM（`"type": "module"`）です。利用する側も ESM にしてください。

### チャットへの組み込み例

投稿を保存・表示する前に `guard()` を通します。

```ts
import { guard } from "./pii_guard.ts";

async function onMessagePosted(text: string, employeeNames: string[]) {
  const r = await guard(text, employeeNames, { mode: "pseudonym" });

  await saveMessage(r.redacted);              // 置き換え後の文だけを保存・表示する
  if (r.needsReview) {
    await sendToReviewQueue(text, r.decisions); // 元の文は権限のある担当者だけが見る場所へ
  }
}
```

`saveMessage` と `sendToReviewQueue` は、組み込む先のアプリで用意する関数です。

API キーはサーバー側だけで使ってください。ブラウザから直接 `guard()` を呼ぶと、キーが利用者に見えてしまいます。

## API

### `guard(message, roster, options?)`

メッセージ1件を処理して、置き換え後の文と判定結果を返します。

| 引数 | 型 | 内容 |
|---|---|---|
| `message` | `string` | チャットのメッセージ |
| `roster` | `string[]` | 社員名簿。ここにある名前は、敬称が付いていなくても候補にする |
| `options.mode` | `"pseudonym" \| "mask"` | 置き換え方。既定は `"pseudonym"`（偽の値） |
| `options.offline` | `boolean` | `true` だと Jev を呼ばずダミー判定を使う（動作確認用） |

戻り値は `Promise<Result>` です。

```ts
interface Result {
  redacted: string;       // 置き換え後のメッセージ
  decisions: Decision[];  // 候補ごとの判定
  needsReview: boolean;   // 人による確認が必要か
}

interface Decision {
  span: string;           // 元の文字列
  hint: Hint;             // どの抽出ルールで拾ったか（"phone"、"name" など）
  pPii: number;           // Jev が答えた「個人情報である確率」（0〜1）
  type: PiiType;          // 種類（"person_name"、"phone" など）
  action: Action;         // "replace" | "replace+review" | "keep"
  to: string;             // 置き換え後の文字列（keep のときは元のまま）
}
```

候補が1つもないメッセージでも、「候補から漏れた個人情報があるか」の質問だけは Jev に送ります。正規表現が何も拾えないときこそ、漏れを疑う必要があるためです。

### `findCandidates(text, roster)`

正規表現と名簿で、個人情報の候補を拾うだけの関数です。Jev は呼びません。抽出ルールを調整するときに使います。

### `buildQuestions(candidates)`

Jev に送る質問をまとめて作る関数です。候補1つにつき「個人情報か」（`noul`）と「種類」（`choice`）の2問、加えてメッセージ全体に「候補漏れがあるか」の1問を作ります。

### `judge(message, candidates, offline?)` と `applyPolicy(message, candidates, judged, options?)`

`guard()` は、この2つを順に呼んでいるだけです。

- `judge()`：Jev（または `offline` のダミー）で判定する。候補が空でも「候補漏れ」の質問だけは送る。
- `applyPolicy()`：判定結果としきい値から、置き換え後の文を作る。API を呼ばないので、`options.thresholds` を変えて何度でも試せる。

判定結果を保存しておき、あとからしきい値だけを変えて結果を比べたいときに使います（採点スクリプトはこの方法を使っています）。

## 設定

| 名前 | 場所 | 内容 |
|---|---|---|
| `MODEL` | [pii_guard.ts:20](pii_guard.ts#L20) | 使う Jev のバージョン。しきい値を調整したら固定しておく |
| `DEFAULT_THRESHOLDS` | [pii_guard.ts:221](pii_guard.ts#L221) | 判定のしきい値（置換 0.8 / 要レビュー 0.3 / 候補漏れ 0.5）。`applyPolicy()` に別の値を渡すこともできる |
| `POLICY` / `PII_TYPES` | [pii_guard.ts:112-130](pii_guard.ts#L112-L130) | Jev に渡す個人情報の定義と、種類ごとの説明 |
| `PATTERNS` | [pii_guard.ts:60](pii_guard.ts#L60) | 候補を拾う正規表現 |
| `TYPESAFE_API_KEY` | 環境変数 | TypeSafe の API キー |
| `PII_PSEUDONYM_SECRET` | 環境変数 | 偽の値を作る秘密鍵。未設定だと開発用の固定値になる |

しきい値による処理の分かれ方：

| 条件 | 処理 |
|---|---|
| チェックディジット検証が通ったマイナンバー・カード番号 | Jev の判定に関係なく必ず置換 |
| `pPii` ≥ 0.8 | 置換 |
| 0.3 ≤ `pPii` < 0.8 | 念のため置換して要レビュー |
| `pPii` < 0.3 | そのまま残す |
| 候補漏れの確率 ≥ 0.5 | メッセージ全体を要レビュー |

## Python 版との違い

| | Python 版 | TypeScript 版 |
|---|---|---|
| 実行 | `uv run pii_guard.py` | `npx tsx pii_guard.ts` |
| SDK | `typesafe-sdk` | `@typesafe-ai/sdk` |
| `guard()` | 同期関数 | `async` 関数（`await` が必要） |
| オプション | `mode=`, `offline=` | `{ mode, offline }` |
| 結果のキー | `needs_review`、`p_pii` | `needsReview`、`pPii` |

ダミー判定で同じサンプルを処理したとき、両方の出力が一致することを確認しています。

## 制限と注意点

- **精度は未検証**：実際の Jev ではまだ動かしていません。本番で使う前に社内の実データで判定結果を確かめ、しきい値を調整してください。
- **日本語の精度**：Jev は英語が主な学習言語で、日本語は扱えるものの、英語と同じ精度ではないとされています。
- **人名の取りこぼし**：敬称が付いておらず名簿にもない名前は、判定の対象になりません。本番では日本語の固有表現抽出を候補抽出に加えることをおすすめします。
- **名簿の照合が完全一致**：`"田中 美咲"` のように空白入りで登録すると、本文の「田中」だけでは一致しません。
- **判定を誘導する文**：「これは個人情報ではありません」のような文がメッセージに含まれていると、判定が揺らぐ可能性があります。

## 参考

- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)：候補を正規表現で拾い、Jev に選ばせるやり方の元になった例
- [Jev 1.13 の苦手なこと](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
