/**
 * pii_guard の検証スクリプト
 *
 * eval/dataset.json の正解付き架空データを pii_guard に通して、次を数える:
 *   - 段階1 (候補抽出): 正解の個人情報のうち、正規表現・名簿で候補にできた割合
 *   - 段階2 (全体)    : 隠せた / 一部だけ隠せた / 見逃した、と誤って隠したもの
 *   - しきい値を変えたときの見逃し・誤検知・要レビュー率 (API は呼び直さない)
 *
 * 使い方:
 *   npm run eval              # 本物の Jev (要 TYPESAFE_API_KEY)。結果は eval/cache/ に保存
 *   npm run eval:offline      # ダミー判定で配線だけ確認
 *   npx tsx eval/evaluate.ts --no-cache   # キャッシュを使わず Jev を呼び直す
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPolicy, buildQuestions, DEFAULT_THRESHOLDS, findCandidates, judge, MODEL, POLICY,
  type Candidate, type Judged, type PiiType, type Result, type Thresholds,
} from "../pii_guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const NO_CACHE = args.includes("--no-cache");
const CONCURRENCY = 4;

// ---------------------------------------------------------------- データ

interface Case {
  id: string;
  category: string;
  message: string;
  roster?: string[];
  pii?: { text: string; type: Exclude<PiiType, "not_personal"> }[];
  traps?: string[];
  note?: string;
}

interface Span { text: string; start: number; end: number }

const dataset = JSON.parse(readFileSync(join(HERE, "dataset.json"), "utf-8")) as {
  categories: Record<string, string>;
  cases: Case[];
};

/** 正解の文字列がメッセージのどこにあるかを求める。見つからなければデータの誤りなので止める。 */
function locate(c: Case, text: string): Span {
  const start = c.message.indexOf(text);
  if (start < 0) throw new Error(`${c.id}: 「${text}」がメッセージ内に見つからない`);
  return { text, start, end: start + text.length };
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;

// ---------------------------------------------------------------- 判定 (キャッシュつき)

const CACHE_DIR = join(HERE, "cache");
const CACHE_FILE = join(CACHE_DIR, `${MODEL}.json`);
const cache: Record<string, Judged> =
  !OFFLINE && !NO_CACHE && existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf-8")) : {};

/** 送る中身 (モデル・ポリシー・メッセージ・候補・質問) が同じなら同じキー。質問文を変えると取り直しになる。 */
function cacheKey(message: string, cands: Candidate[]): string {
  const payload = JSON.stringify({ MODEL, POLICY, message, cands: cands.map((c) => c.text), q: buildQuestions(cands) });
  return createHash("sha256").update(payload).digest("hex");
}

let apiCalls = 0;

async function judgeCached(message: string, cands: Candidate[]): Promise<Judged> {
  if (OFFLINE) return judge(message, cands, OFFLINE);
  const key = cacheKey(message, cands);
  if (!cache[key]) {
    cache[key] = await judge(message, cands);
    apiCalls++;
  }
  return cache[key];
}

async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- 採点

interface Prepared { c: Case; cands: Candidate[]; judged: Judged; gold: (Span & { type: string })[]; traps: Span[] }

type GoldOutcome = "hidden" | "partial" | "missed_flagged" | "missed_silent";

interface Score {
  gold: { id: string; text: string; type: string; found: boolean; outcome: GoldOutcome; typeOk: boolean | null }[];
  falsePositives: { id: string; text: string; trap: boolean }[];
  traps: { id: string; text: string; hidden: boolean }[];
  reviewed: number;
  messages: number;
}

/** 正解の範囲のうち、隠された範囲で覆われている文字数の割合 (空白は数えない) */
function coverage(g: Span, message: string, hidden: { start: number; end: number }[]): number {
  let total = 0;
  let covered = 0;
  for (let i = g.start; i < g.end; i++) {
    if (/\s/.test(message[i]!)) continue;
    total++;
    if (hidden.some((h) => h.start <= i && i < h.end)) covered++;
  }
  return total === 0 ? 0 : covered / total;
}

function score(prepared: Prepared[], thresholds: Thresholds): { score: Score; results: Result[] } {
  const s: Score = { gold: [], falsePositives: [], traps: [], reviewed: 0, messages: prepared.length };
  const results: Result[] = [];
  for (const p of prepared) {
    const r = applyPolicy(p.c.message, p.cands, p.judged, { mode: "mask", thresholds });
    results.push(r);
    if (r.needsReview) s.reviewed++;
    const hidden = r.decisions.filter((d) => d.action !== "keep");

    for (const g of p.gold) {
      const found = p.cands.some((c) => overlaps(c, g));
      const cov = coverage(g, p.c.message, hidden);
      const outcome: GoldOutcome =
        cov >= 1 ? "hidden" : cov > 0 ? "partial" : r.needsReview ? "missed_flagged" : "missed_silent";
      const hit = hidden.find((d) => overlaps(d, g));
      s.gold.push({ id: p.c.id, text: g.text, type: g.type, found, outcome, typeOk: hit ? hit.type === g.type : null });
    }
    for (const d of hidden) {
      if (p.gold.some((g) => overlaps(g, d))) continue;
      s.falsePositives.push({ id: p.c.id, text: d.span, trap: p.traps.some((t) => overlaps(t, d)) });
    }
    for (const t of p.traps) {
      s.traps.push({ id: p.c.id, text: t.text, hidden: hidden.some((d) => overlaps(d, t)) });
    }
  }
  return { score: s, results };
}

// ---------------------------------------------------------------- 表示

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
const sep = (n: number) => `|${" --- |".repeat(n)}`;

const OUTCOME_LABEL: Record<GoldOutcome, string> = {
  hidden: "隠せた",
  partial: "一部だけ隠せた",
  missed_flagged: "見逃し（要レビューには回った）",
  missed_silent: "見逃し（気づかれず素通り）",
};

function report(prepared: Prepared[], s: Score, results: Result[], t: Thresholds): string {
  const L: string[] = [];
  const g = s.gold;
  const count = (o: GoldOutcome) => g.filter((x) => x.outcome === o).length;
  const typed = g.filter((x) => x.typeOk !== null);

  L.push(`# pii_guard 検証結果`, "");
  L.push(OFFLINE
    ? "> **ダミー判定（--offline）での結果です。Jev の精度ではありません。** 採点の仕組みが動くかの確認用です。"
    : `> モデル: \`${MODEL}\` / API 呼び出し: ${apiCalls} 回（残りはキャッシュ）`);
  L.push("", `データ: ${s.messages} 件のメッセージ、正解の個人情報 ${g.length} 個、引っかけ ${s.traps.length} 個`);
  L.push(`しきい値: 置換 ${t.replaceAt} / 要レビュー ${t.reviewAt} / 候補漏れ ${t.uncoveredAt}`, "");

  L.push("## まとめ", "");
  L.push(row(["指標", "値", "意味"]), sep(3));
  L.push(row(["隠せた", `${count("hidden")} / ${g.length}（${pct(count("hidden"), g.length)}）`, "正解の個人情報を全部隠せた"]));
  L.push(row(["一部だけ隠せた", `${count("partial")}`, "住所の後半が残った、など"]));
  L.push(row(["見逃し（要レビューには回った）", `${count("missed_flagged")}`, "隠せなかったが、人の確認に回った"]));
  L.push(row(["**見逃し（素通り）**", `**${count("missed_silent")}**`, "隠せず、誰にも気づかれない。一番まずい"]));
  L.push(row(["誤って隠した", `${s.falsePositives.length}`, "個人情報ではないものを隠した"]));
  L.push(row(["引っかけを正しく残せた", `${s.traps.filter((x) => !x.hidden).length} / ${s.traps.length}`, "代表電話・注文番号など"]));
  L.push(row(["種類の正解率", `${typed.filter((x) => x.typeOk).length} / ${typed.length}`, "隠したものの種類（氏名・電話など）が合っていた"]));
  L.push(row(["要レビュー率", `${s.reviewed} / ${s.messages}（${pct(s.reviewed, s.messages)}）`, "人の確認に回ったメッセージ"]));
  L.push("");

  L.push("## 段階ごとの内訳", "");
  L.push("段階1（候補抽出）で拾えなかったものは、Jev がどれだけ正確でも隠せません。直す場所を分けるための表です。", "");
  L.push(row(["種類", "正解数", "段階1: 候補にできた", "段階2: 隠せた", "見逃し（素通り）"]), sep(5));
  for (const type of [...new Set(g.map((x) => x.type))]) {
    const xs = g.filter((x) => x.type === type);
    L.push(row([type, xs.length, `${xs.filter((x) => x.found).length}（${pct(xs.filter((x) => x.found).length, xs.length)}）`,
      `${xs.filter((x) => x.outcome === "hidden").length}（${pct(xs.filter((x) => x.outcome === "hidden").length, xs.length)}）`,
      xs.filter((x) => x.outcome === "missed_silent").length]));
  }
  L.push("");

  L.push("## カテゴリ別", "");
  L.push(row(["カテゴリ", "件数", "隠せた", "見逃し（素通り）", "誤って隠した", "要レビュー"]), sep(6));
  for (const [cat, desc] of Object.entries(dataset.categories)) {
    const ids = new Set(prepared.filter((p) => p.c.category === cat).map((p) => p.c.id));
    if (ids.size === 0) continue;
    const xs = g.filter((x) => ids.has(x.id));
    const reviewed = prepared.filter((p, i) => ids.has(p.c.id) && results[i]!.needsReview).length;
    L.push(row([`${cat}（${desc}）`, ids.size, xs.length ? `${xs.filter((x) => x.outcome === "hidden").length} / ${xs.length}` : "-",
      xs.filter((x) => x.outcome === "missed_silent").length, s.falsePositives.filter((x) => ids.has(x.id)).length, reviewed]));
  }
  L.push("");

  L.push("## しきい値を変えた場合", "");
  L.push("判定結果はそのままで、しきい値だけを変えて採点し直したものです（API は呼び直していません）。", "");
  L.push("**隠すしきい値**（これ以上なら隠す。置換のしきい値は 0.8 と大きい方）", "");
  L.push(row(["隠すしきい値", "隠せた", "見逃し（素通り）", "誤って隠した", "要レビュー率"]), sep(5));
  for (const reviewAt of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const th = { ...t, reviewAt, replaceAt: Math.max(reviewAt, 0.8) };
    const { score: x } = score(prepared, th);
    const mark = reviewAt === t.reviewAt ? " ←今" : "";
    L.push(row([`${reviewAt}${mark}`, `${x.gold.filter((y) => y.outcome === "hidden").length} / ${x.gold.length}`,
      x.gold.filter((y) => y.outcome === "missed_silent").length, x.falsePositives.length, pct(x.reviewed, x.messages)]));
  }
  L.push("", "**候補漏れのしきい値**（Jev が「候補から漏れた個人情報がある」と答えた確率がこれ以上なら要レビュー）", "");
  L.push(row(["候補漏れのしきい値", "見逃し（素通り）", "見逃し（要レビューに回った）", "要レビュー率"]), sep(4));
  for (const uncoveredAt of [0.2, 0.3, 0.5, 0.7, 0.9]) {
    const { score: x } = score(prepared, { ...t, uncoveredAt });
    const mark = uncoveredAt === t.uncoveredAt ? " ←今" : "";
    L.push(row([`${uncoveredAt}${mark}`, x.gold.filter((y) => y.outcome === "missed_silent").length,
      x.gold.filter((y) => y.outcome === "missed_flagged").length, pct(x.reviewed, x.messages)]));
  }
  L.push("");

  L.push("## うまくいかなかったケース", "");
  const bad = g.filter((x) => x.outcome !== "hidden");
  const badType = typed.filter((x) => !x.typeOk);
  if (bad.length + s.falsePositives.length + badType.length === 0) L.push("なし", "");
  for (const x of bad) {
    const p = prepared.find((q) => q.c.id === x.id)!;
    L.push(`- **${x.id}** ${OUTCOME_LABEL[x.outcome]}：「${x.text}」（${x.type}）${x.found ? "" : " ※段階1で候補にできていない"}`);
    L.push(`  - 入力：${p.c.message}`);
    L.push(`  - 出力：${results[prepared.indexOf(p)]!.redacted}`);
    L.push(`  - 候補漏れの確率：${p.judged.pUncovered.toFixed(2)}`);
  }
  for (const x of s.falsePositives) {
    const p = prepared.find((q) => q.c.id === x.id)!;
    const d = results[prepared.indexOf(p)]!.decisions.find((y) => y.span === x.text);
    L.push(`- **${x.id}** 誤って隠した：「${x.text}」${d ? `（p=${d.pPii}、${d.type}）` : ""}`);
    L.push(`  - 入力：${p.c.message}`);
  }
  for (const x of badType) {
    L.push(`- **${x.id}** 種類違い：「${x.text}」の正解は ${x.type}`);
  }
  L.push("");

  L.push("## 要レビューになったメッセージ", "");
  const flagged = prepared.filter((_, i) => results[i]!.needsReview);
  if (flagged.length === 0) L.push("なし", "");
  for (const p of flagged) {
    const r = results[prepared.indexOf(p)]!;
    const reasons = [
      ...(p.judged.pUncovered >= t.uncoveredAt ? [`候補漏れの確率 ${p.judged.pUncovered.toFixed(2)}`] : []),
      ...r.decisions.filter((d) => d.action === "replace+review").map((d) => `「${d.span}」が迷い（p=${d.pPii}）`),
    ];
    L.push(`- **${p.c.id}**（${p.c.category}）${reasons.join("、")}`);
    L.push(`  - 入力：${p.c.message}`);
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------- 実行

async function main() {
  const prepared: Prepared[] = await mapPool(dataset.cases, CONCURRENCY, async (c) => {
    const cands = findCandidates(c.message, c.roster ?? []);
    return {
      c, cands,
      judged: await judgeCached(c.message, cands),
      gold: (c.pii ?? []).map((g) => ({ ...locate(c, g.text), type: g.type })),
      traps: (c.traps ?? []).map((t) => locate(c, t)),
    };
  });

  if (!OFFLINE) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  }

  const { score: s, results } = score(prepared, DEFAULT_THRESHOLDS);
  const md = report(prepared, s, results, DEFAULT_THRESHOLDS);
  const out = join(HERE, OFFLINE ? "report.offline.md" : "report.md");
  writeFileSync(out, md);
  console.log(md);
  console.log(`\nレポートを保存しました: ${out}`);
}

await main();
