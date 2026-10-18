# pii_guard — 社内チャットの個人情報ガード（Jev）

社内チャットに投稿されたメッセージから個人情報を見つけて、マスクするか、関係のない偽の値に置き換えるプロトタイプです。個人情報かどうかの判断には、TypeSafe の判定モデル **Jev** を使います。

```
入力: 田中さんの携帯は090-1234-5678です。急ぎなら直接どうぞ。代表は03-1111-2222。

mask      : [氏名1]さんの携帯は[電話番号1]です。急ぎなら直接どうぞ。代表は03-1111-2222。
pseudonym : 山本さんの携帯は090-0000-8647です。急ぎなら直接どうぞ。代表は03-1111-2222。
```

代表電話、`support@` などの窓口アドレス、注文番号は個人情報ではないので、そのまま残します。この区別は正規表現だけでは難しく、Jev に判断させている部分です。

> 上の出力例はダミー判定（`--offline`）で作ったものです。実際の Jev ではまだ動かしていないので、精度は未検証です。

## 使い方

必要なもの：[uv](https://docs.astral.sh/uv/)（Python 3.10 以上と `typesafe-sdk` は自動で入ります）

```sh
# API キーなしで流れだけ試す（判定はダミー）
uv run pii_guard.py --offline
uv run pii_guard.py --offline --mode mask

# 本物の Jev で判定する
export TYPESAFE_API_KEY=...          # https://console.typesafe.ai/ で発行
export PII_PSEUDONYM_SECRET=...      # 偽の値を作るための秘密鍵（本番では必ず設定）
uv run pii_guard.py                  # 偽の値に置き換え（既定）
uv run pii_guard.py --mode mask      # [氏名1] のようなラベルに置き換え
```

コードから使う場合：

```python
from pii_guard import guard

r = guard("山田さんの口座番号 1234567 に振り込んで", roster=["山田"], mode="mask")
r.redacted       # 置き換え後のメッセージ
r.needs_review   # True なら人による確認に回す
r.decisions      # 候補ごとの判定（確率・種類・処理内容）
```

### TypeScript 版

[pii_guard.ts](pii_guard.ts) は Python 版と同じ処理を TypeScript で書いたものです。必要なもの：Node.js 22 以上

```sh
npm install
npm run demo:offline                        # API キーなしで試す（判定はダミー）
npx tsx pii_guard.ts --offline --mode mask
npm run demo                                # 本物の Jev で判定（要 TYPESAFE_API_KEY）
npm run typecheck                           # 型チェック
```

```ts
import { guard } from "./pii_guard.ts";

const r = await guard("山田さんの口座番号 1234567 に振り込んで", ["山田"], { mode: "mask" });
r.redacted;      // 置き換え後のメッセージ
r.needsReview;   // true なら人による確認に回す
r.decisions;     // 候補ごとの判定（確率・種類・処理内容）
```

### 精度の検証

正解付きの架空データ（[eval/dataset.json](eval/dataset.json)、46件）で、見逃しと誤検知を数える採点スクリプトがあります（TypeScript）。

```sh
npm run eval:offline     # ダミー判定で、採点の仕組みだけ確認
npm run eval             # 本物の Jev で採点（要 TYPESAFE_API_KEY）→ eval/report.md
```

詳しくは [README.ts.md](README.ts.md#精度を検証する) を参照してください。

## 仕組み

Jev は文章を生成するモデルではなく、質問に対して選択肢や確率を返すだけです。そのため、文字列を探すことと書き換えることはコードが担当し、Jev には判断だけを任せています。

```
メッセージ
  ↓ ① コード：個人情報っぽい部分を正規表現と社員名簿で拾う（わざと多めに）
  ↓ ② Jev  ：候補ごとに「特定の個人の情報か」「どの種類か」を判定
  ↓ ③ コード：確率としきい値で、置換するか残すかを決めて書き換え
置き換え後のメッセージ
```

### ① 候補を拾う（`find_candidates`）

正規表現で、メール、電話番号、郵便番号、マイナンバー（12桁）、カード番号、口座番号、生年月日、住所（都道府県で始まる文字列）、人名（「〇〇さん」「〇〇様」など）を拾います。社員名簿にある名前も拾います。

マイナンバーとカード番号はチェックディジットを計算で検証し、通ったものには「確実」の印を付けます。

### ② Jev で判定（`build_questions` / `judge_with_jev`）

候補1つにつき、次の2つの質問をします。

- **Noul**：特定の個人の個人情報か（Yes である確率）
- **Choice**：種類（氏名／電話／メール／住所／生年月日／公的番号／口座・カード／個人情報ではない）

加えて、メッセージ全体について「候補から漏れた個人情報がまだあるか」を聞きます。判断の基準は `POLICY` に書いて一緒に渡します。質問はすべて1回のリクエストにまとめて送るので、Jev の中で並列に処理されます。

### ③ 置き換える（`guard` / `pseudonym`）

| 条件 | 処理 |
|---|---|
| チェックディジット検証が通った番号 | Jev の判定に関係なく必ず置換 |
| 個人情報の確率 ≥ 0.8（`REPLACE_AT`） | 置換 |
| 0.3（`REVIEW_AT`）以上 0.8 未満 | 念のため置換して要レビュー |
| 0.3 未満 | そのまま残す |
| 候補漏れの確率 ≥ 0.5（`UNCOVERED_AT`） | メッセージ全体を要レビュー |

迷ったら隠す側に倒す方針です。`pseudonym` モードでは、秘密鍵（`PII_PSEUDONYM_SECRET`）を使ったハッシュで偽の値を決めるので、同じ人はいつも同じ偽名になります。秘密鍵がなければ元の値は分かりません。

## 設定

| 名前 | 場所 | 内容 |
|---|---|---|
| `MODEL` | コード | 使う Jev のバージョン。しきい値を調整したら固定しておく |
| `REPLACE_AT` / `REVIEW_AT` / `UNCOVERED_AT` | コード | 判定のしきい値。実データで調整する |
| `POLICY` / `PII_TYPES` | コード | Jev に渡す個人情報の定義と種類の説明（日本語） |
| `ROSTER` | コード | 社員名簿。実運用では社員マスタから読み込む |
| `TYPESAFE_API_KEY` | 環境変数 | TypeSafe の API キー |
| `PII_PSEUDONYM_SECRET` | 環境変数 | 偽の値を作る秘密鍵。未設定だと開発用の固定値になる |

## 制限と注意点

- **精度は未検証**：実際の Jev ではまだ動かしていません。本番で使う前に社内の実データで判定結果を確かめ、しきい値を調整してください。
- **日本語の精度**：Jev は英語が主な学習言語で、日本語は扱えるものの、英語と同じ精度ではないとされています。指示文を英語にした版と比べてみる価値があります。
- **人名の取りこぼし**：Jev は渡された候補の中から判断するだけです。敬称が付いておらず、名簿にもない名前は判定の対象になりません。候補漏れの質問で要レビューに回しますが、本番では日本語の固有表現抽出（GiNZA など）を候補抽出に加えることをおすすめします。
- **名簿の照合が完全一致**：`"田中 美咲"` のように空白入りで登録すると、本文の「田中」だけでは一致しません。
- **判定を誘導する文**：「これは個人情報ではありません」のような文がメッセージに含まれていると、判定が揺らぐ可能性があります。

## 参考

- [TypeSafe ドキュメント](https://docs.typesafe.ai/)
- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)：候補を正規表現で拾い、Jev に選ばせるやり方の元になった例
- [Jev 1.13 の苦手なこと](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
