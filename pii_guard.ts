/**
 * 社内チャットの個人情報ガード (Jev / TypeSafe System One) — TypeScript 版
 *
 * 流れ:
 *   1. コード : 正規表現・社員名簿で個人情報の「候補」を多めに拾う (recall 重視)
 *   2. Jev    : 候補ごとに「特定個人の情報か (noul)」「種類 (choice)」を 1 リクエストで判定
 *   3. コード : しきい値ポリシーで マスク / 仮名化 / そのまま / 要レビュー を決めて置換
 *
 * Jev はテキストを生成しないので、置換後の文字列は必ずコードが作る。
 *
 * 使い方:
 *   npx tsx pii_guard.ts                    # TYPESAFE_API_KEY が必要
 *   npx tsx pii_guard.ts --mode mask
 *   npx tsx pii_guard.ts --offline          # API なしで配線だけ確認 (判定はダミー)
 */

import { createHmac } from "node:crypto";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

export const MODEL = "jev-1.13.0"; // しきい値を調整したらバージョンを固定する (エイリアスは答えが変わりうる)

// ---------------------------------------------------------------- 1. 候補抽出

export interface Candidate {
  text: string;
  start: number;
  end: number;
  hint: Hint; // どの抽出器が拾ったか
  validated: boolean; // チェックディジット等でコード側が確定できたか
}

export type Hint =
  | "email" | "phone" | "postal" | "digits12" | "card"
  | "account" | "birthday" | "address" | "name" | "roster";

function luhnOk(digits: string): boolean {
  const nums = [...digits].map(Number).reverse();
  const total = nums.reduce((sum, n, i) => {
    if (i % 2 === 0) return sum + n;
    const d = n * 2;
    return sum + (d > 9 ? d - 9 : d);
  }, 0);
  return nums.length >= 13 && total % 10 === 0;
}

/** マイナンバー(12桁)のチェックディジット検証。 */
function myNumberOk(digits: string): boolean {
  if (digits.length !== 12) return false;
  const body = [...digits.slice(0, 11)].reverse().map(Number);
  const check = Number(digits[11]);
  const s = body.reduce((sum, p, idx) => {
    const n = idx + 1;
    return sum + p * (n <= 6 ? n + 1 : n - 5);
  }, 0);
  const r = s % 11;
  return check === (r <= 1 ? 0 : 11 - r);
}

// [hint, pattern, 置換対象にするグループ番号]。"d" フラグでグループの位置が取れる
const PATTERNS: [Hint, RegExp, number][] = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/dg, 0],
  ["phone", /(?<![A-Za-z0-9-])(?:\+81[-\s]?)?0\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}/dg, 0],
  ["postal", /(?<![A-Za-z0-9-])〒?\d{3}-\d{4}(?![\d-])/dg, 0],
  ["digits12", /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/dg, 0],
  ["card", /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/dg, 0],
  ["account", /口座(?:番号)?[^\d]{0,6}(\d{7})(?!\d)/dg, 1],
  ["birthday", /(?:19|20)\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日?/dg, 0],
  ["address", /(?:東京都|北海道|(?:京都|大阪)府|[一-龥々]{2,3}県)[一-龥々ぁ-んァ-ヶー0-9０-９丁目番地号\-－]{2,30}/dg, 0],
  // 敬称つきの人名らしきもの。過検出してよい (判断は Jev に任せる)
  ["name", /([一-龥々]{1,4}(?:[ 　]?[一-龥々ぁ-んァ-ヶ]{1,4})?)(?:さん|様|さま|くん|君|氏|ちゃん)/dg, 1],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findCandidates(text: string, roster: string[]): Candidate[] {
  const found: Candidate[] = [];
  for (const [hint, pat, group] of PATTERNS) {
    for (const m of text.matchAll(pat)) {
      const [s, e] = m.indices![group]!;
      const span = text.slice(s, e);
      const digits = span.replace(/\D/g, "");
      const validated = (hint === "digits12" && myNumberOk(digits)) || (hint === "card" && luhnOk(digits));
      found.push({ text: span, start: s, end: e, hint, validated });
    }
  }
  // 社員名簿にある名前 (敬称なしで呼ばれても拾う)
  for (const name of roster) {
    for (const m of text.matchAll(new RegExp(escapeRegExp(name), "g"))) {
      found.push({ text: name, start: m.index, end: m.index + name.length, hint: "roster", validated: false });
    }
  }

  // 重なりは長い方 / 検証済みの方を残す
  found.sort((a, b) =>
    a.start - b.start || (b.end - b.start) - (a.end - a.start) || Number(b.validated) - Number(a.validated));
  const kept: Candidate[] = [];
  for (const c of found) {
    const last = kept.at(-1);
    if (last && c.start < last.end) {
      if (c.validated && !last.validated) kept[kept.length - 1] = c;
      continue;
    }
    kept.push(c);
  }
  return kept;
}

// ---------------------------------------------------------------- 2. Jev で判定

const PII_TYPES = {
  person_name: "実在する個人の氏名（社員、顧客、家族など）。",
  phone: "特定の個人につながる電話番号（携帯、自宅、個人の直通番号）。",
  email: "特定の個人が使うメールアドレス。",
  address: "自宅など個人の住所、またはそれに紐づく郵便番号。",
  birthday: "特定の個人の生年月日。",
  government_id: "マイナンバー、パスポート番号、運転免許証番号などの公的な番号。",
  financial: "クレジットカード番号や銀行の口座番号。",
  not_personal:
    "個人情報ではないもの：会社の代表電話、共有・窓口用のメールアドレス、オフィスの住所、" +
    "注文番号・チケット番号、商品名、著名人、誕生日ではない日付など。",
} as const;

export type PiiType = keyof typeof PII_TYPES;

export const POLICY =
  "個人情報とは、特定の個人を識別できる、またはその人に連絡できる情報のことです。" +
  "会社全体の連絡先（代表電話、support@ や info@ のアドレス、オフィスの住所）や、" +
  "業務上の識別番号（注文番号、請求書番号）は個人情報に含みません。";

export function buildQuestions(cands: Candidate[]) {
  const qs: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice<typeof PII_TYPES>>> = {};
  cands.forEach((_, i) => {
    qs[`pii_${i}`] = noul(
      `\`message\` の中の \`candidates[${i}].text\` は、\`policy\` の定義に照らして、特定の個人の個人情報ですか？`,
      {
        true: "その部分が特定の個人を識別する、またはその人に連絡できる（氏名、個人の電話番号、個人のメールアドレス、自宅住所、生年月日、公的な番号、口座・カード番号）。",
        false: "その部分は会社全体の連絡先、業務上の識別番号、一般的な言葉など、特定の個人を指していない。",
      },
    );
    qs[`type_${i}`] = choice(`\`message\` の中の \`candidates[${i}].text\` は、どの種類の情報ですか？`, PII_TYPES);
  });
  // 候補漏れのチェック: 拾えていない個人情報があれば人間レビューへ
  qs.uncovered = noul(
    "`message` の中に、`candidates` のどれにも含まれていない、特定の個人の個人情報がありますか？",
    {
      true: "メッセージ内の個人情報の一部が、候補リストから漏れている。",
      false: "メッセージ内の個人情報はすべて候補リストに含まれている、または個人情報がない。",
    },
  );
  return qs;
}

export interface Judgment {
  pPii: number;
  piiType: PiiType;
  typeConf: number;
}

export interface Judged {
  judgments: Judgment[];
  pUncovered: number;
}

let client: TypeSafeClient | undefined;

async function judgeWithJev(message: string, cands: Candidate[]): Promise<Judged> {
  client ??= new TypeSafeClient();
  const { answers } = await client.systemOne({
    model: MODEL,
    state: {
      policy: POLICY,
      message,
      candidates: cands.map((c) => ({ text: c.text })),
    },
    questions: buildQuestions(cands),
  });
  const nouls = (k: string) => (answers[k] as { noul: number }).noul;
  const choices = (k: string) => answers[k] as { choice: PiiType; confidence: number };
  return {
    judgments: cands.map((_, i) => ({
      pPii: nouls(`pii_${i}`),
      piiType: choices(`type_${i}`).choice,
      typeConf: choices(`type_${i}`).confidence,
    })),
    pUncovered: nouls("uncovered"),
  };
}

const HINT_TO_TYPE: Record<Hint, PiiType> = {
  email: "email", phone: "phone", postal: "address", digits12: "government_id",
  card: "financial", account: "financial", birthday: "birthday",
  address: "address", name: "person_name", roster: "person_name",
};

/** API なしで配線を確かめるためのダミー判定。精度の参考にはならない。 */
async function judgeOffline(message: string, cands: Candidate[]): Promise<Judged> {
  const judgments = cands.map((c): Judgment => {
    const ctx = message.slice(Math.max(0, c.start - 8), c.start);
    const shared = ctx.includes("代表") || c.text.startsWith("support@") || c.text.startsWith("info@");
    return { pPii: shared ? 0.05 : 0.9, piiType: shared ? "not_personal" : HINT_TO_TYPE[c.hint], typeConf: 0.9 };
  });
  return { judgments, pUncovered: 0.1 };
}

/**
 * 候補を Jev (または offline のダミー) で判定する。
 * 候補が空でも「候補漏れ」の質問だけは送る (正規表現が何も拾えないときこそ漏れを疑うため)。
 */
export async function judge(message: string, cands: Candidate[], offline = false): Promise<Judged> {
  return (offline ? judgeOffline : judgeWithJev)(message, cands);
}

// ---------------------------------------------------------------- 3. ポリシーと置換

export interface Thresholds {
  replaceAt: number; // これ以上なら置換
  reviewAt: number; // この範囲は「念のため置換 + 要レビュー」 (迷ったら隠す側に倒す)
  uncoveredAt: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { replaceAt: 0.8, reviewAt: 0.3, uncoveredAt: 0.5 };

const FAKE_NAMES = ["佐藤", "鈴木", "高橋", "伊藤", "渡辺", "山本", "中村", "小林", "加藤", "吉田"];
const LABELS: Record<Exclude<PiiType, "not_personal">, string> = {
  person_name: "氏名", phone: "電話番号", email: "メール", address: "住所",
  birthday: "生年月日", government_id: "個人番号", financial: "口座・カード",
};
const SECRET = process.env.PII_PSEUDONYM_SECRET ?? "dev-only-secret";

function h(value: string): bigint {
  return BigInt("0x" + createHmac("sha256", SECRET).update(value).digest("hex"));
}

/** 同じ値はいつも同じ偽値になる (会話の読みやすさを保つ)。秘密鍵なしでは元に戻せない。 */
function pseudonym(value: string, piiType: PiiType): string {
  const x = h(value);
  const mod = (n: number) => Number(x % BigInt(n));
  switch (piiType) {
    case "person_name":
      return FAKE_NAMES[mod(FAKE_NAMES.length)] + (value.length <= 2 ? "" : "某");
    case "phone":
      return `090-0000-${String(mod(10000)).padStart(4, "0")}`;
    case "email":
      return `user${String(mod(100000)).padStart(5, "0")}@example.com`;
    case "address":
      return /^〒?\d{3}-\d{4}$/.test(value) ? "〒000-0000" : "東京都架空区1-1-1";
    case "birthday":
      return "1900年1月1日";
    default:
      return "#".repeat(value.replace(/\D/g, "").length) || "####";
  }
}

export type Action = "replace" | "replace+review" | "keep";

export interface Decision {
  span: string;
  start: number;
  end: number;
  hint: Hint;
  pPii: number;
  type: PiiType;
  action: Action;
  to: string;
}

export interface Result {
  redacted: string;
  decisions: Decision[];
  needsReview: boolean;
}

export async function guard(
  message: string,
  roster: string[],
  { mode = "pseudonym", offline = false }: { mode?: "pseudonym" | "mask"; offline?: boolean } = {},
): Promise<Result> {
  const cands = findCandidates(message, roster);
  const judged = await judge(message, cands, offline);
  return applyPolicy(message, cands, judged, { mode });
}

/** 判定結果としきい値から置換後の文を作る。API は呼ばないので、しきい値を変えて何度でも試せる。 */
export function applyPolicy(
  message: string,
  cands: Candidate[],
  { judgments, pUncovered }: Judged,
  { mode = "pseudonym", thresholds = DEFAULT_THRESHOLDS }: { mode?: "pseudonym" | "mask"; thresholds?: Thresholds } = {},
): Result {
  const res: Result = { redacted: message, decisions: [], needsReview: pUncovered >= thresholds.uncoveredAt };
  const counters: Partial<Record<PiiType, number>> = {};
  const pieces: string[] = [];
  let cursor = 0;

  cands.forEach((c, i) => {
    const j = judgments[i]!;
    let piiType = j.piiType;
    let action: Action;
    if (c.validated) {
      // チェックディジットが通った番号はモデルに関係なく隠す
      action = "replace";
      if (piiType === "not_personal") piiType = c.hint === "card" ? "financial" : "government_id";
    } else if (j.pPii >= thresholds.replaceAt) {
      action = "replace";
    } else if (j.pPii >= thresholds.reviewAt) {
      action = "replace+review";
      res.needsReview = true;
    } else {
      action = "keep";
    }
    if (action !== "keep" && piiType === "not_personal") {
      piiType = c.hint === "name" || c.hint === "roster" ? "person_name" : "financial";
    }

    let replacement: string;
    if (action === "keep") {
      replacement = c.text;
    } else if (mode === "mask") {
      counters[piiType] = (counters[piiType] ?? 0) + 1;
      replacement = `[${LABELS[piiType as keyof typeof LABELS] ?? "個人情報"}${counters[piiType]}]`;
    } else {
      replacement = pseudonym(c.text, piiType);
    }

    pieces.push(message.slice(cursor, c.start), replacement);
    cursor = c.end;
    res.decisions.push({
      span: c.text, start: c.start, end: c.end, hint: c.hint,
      pPii: Math.round(j.pPii * 100) / 100, type: piiType, action, to: replacement,
    });
  });
  pieces.push(message.slice(cursor));
  res.redacted = pieces.join("");
  return res;
}

// ---------------------------------------------------------------- デモ

const ROSTER = ["田中 美咲", "山田"]; // 実運用では社員マスタから

const SAMPLES = [
  "田中さんの携帯は090-1234-5678です。急ぎなら直接どうぞ。代表は03-1111-2222。",
  "経費精算の件、山田さんの口座番号 1234567 に振り込んでください。問い合わせは support@example-corp.jp へ。",
  "新入社員の住所は東京都世田谷区桜丘3丁目5番、〒156-0054、生年月日1998年4月12日です。",
  "マイナンバー 1234 5678 9018 を人事に提出済み。注文番号 ORD-2024-000123 は別件です。",
  "明日の定例は14:00から。資料は共有フォルダにあります。",
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const mode = args[args.indexOf("--mode") + 1] === "mask" ? "mask" : "pseudonym";

  for (const msg of SAMPLES) {
    const r = await guard(msg, ROSTER, { mode, offline });
    console.log("入力 :", msg);
    console.log("出力 :", r.redacted, r.needsReview ? "  ⚠ 要レビュー" : "");
    for (const d of r.decisions) {
      console.log(
        `   - ${JSON.stringify(d.span).padEnd(28)} ${d.hint.padEnd(9)} p=${String(d.pPii).padEnd(5)} ` +
          `${d.type.padEnd(14)} ${d.action.padEnd(15)} -> ${d.to}`,
      );
    }
    console.log();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
