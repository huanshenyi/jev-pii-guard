# /// script
# requires-python = ">=3.10"
# dependencies = ["typesafe-sdk>=0.7"]
# ///
"""社内チャットの個人情報ガード (Jev / TypeSafe System One)

流れ:
  1. コード   : 正規表現・社員名簿で個人情報の「候補」を多めに拾う (recall 重視)
  2. Jev      : 候補ごとに「特定個人の情報か (Noul)」「種類 (Choice)」を 1 リクエストで判定
  3. コード   : しきい値ポリシーで マスク / 仮名化 / そのまま / 要レビュー を決めて置換

Jev はテキストを生成しないので、置換後の文字列は必ずコードが作る。

使い方:
  uv run pii_guard.py                       # TYPESAFE_API_KEY が必要
  uv run pii_guard.py --mode mask
  uv run pii_guard.py --offline             # API なしで配線だけ確認 (判定はダミー)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import re
from dataclasses import dataclass, field

MODEL = "jev-1.13.0"  # しきい値を調整したらバージョンを固定する (エイリアスは答えが変わりうる)

# ---------------------------------------------------------------- 1. 候補抽出

@dataclass
class Candidate:
    text: str
    start: int
    end: int
    hint: str               # どの抽出器が拾ったか
    validated: bool = False  # チェックディジット等でコード側が確定できたか


def luhn_ok(digits: str) -> bool:
    nums = [int(d) for d in digits][::-1]
    total = sum(n if i % 2 == 0 else (n * 2 - 9 if n * 2 > 9 else n * 2) for i, n in enumerate(nums))
    return len(nums) >= 13 and total % 10 == 0


def my_number_ok(digits: str) -> bool:
    """マイナンバー(12桁)のチェックディジット検証。"""
    if len(digits) != 12:
        return False
    body, check = digits[:11], int(digits[11])
    s = sum(int(p) * (n + 1 if n <= 6 else n - 5) for n, p in enumerate(reversed(body), start=1))
    r = s % 11
    return check == (0 if r <= 1 else 11 - r)


PATTERNS: list[tuple[str, re.Pattern, int]] = [
    # (hint, pattern, 置換対象にするグループ番号)
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), 0),
    ("phone", re.compile(r"(?<![A-Za-z0-9-])(?:\+81[-\s]?)?0\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}"), 0),
    ("postal", re.compile(r"(?<![A-Za-z0-9-])〒?\d{3}-\d{4}(?![\d-])"), 0),
    ("digits12", re.compile(r"(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"), 0),
    ("card", re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)"), 0),
    ("account", re.compile(r"口座(?:番号)?[^\d]{0,6}(\d{7})(?!\d)"), 1),
    ("birthday", re.compile(r"(?:19|20)\d{2}[年/-]\d{1,2}[月/-]\d{1,2}日?"), 0),
    ("address", re.compile(r"(?:東京都|北海道|(?:京都|大阪)府|[一-龥々]{2,3}県)[一-龥々ぁ-んァ-ヶー0-9０-９丁目番地号\-－]{2,30}"), 0),
    # 敬称つきの人名らしきもの。過検出してよい (判断は Jev に任せる)
    ("name", re.compile(r"([一-龥々]{1,4}(?:[ 　]?[一-龥々ぁ-んァ-ヶ]{1,4})?)(?:さん|様|さま|くん|君|氏|ちゃん)"), 1),
]


def find_candidates(text: str, roster: list[str]) -> list[Candidate]:
    found: list[Candidate] = []
    for hint, pat, group in PATTERNS:
        for m in pat.finditer(text):
            s, e = m.span(group)
            span = text[s:e]
            digits = re.sub(r"\D", "", span)
            validated = (hint == "digits12" and my_number_ok(digits)) or (hint == "card" and luhn_ok(digits))
            found.append(Candidate(span, s, e, hint, validated))
    # 社員名簿にある名前 (敬称なしで呼ばれても拾う)
    for name in roster:
        for m in re.finditer(re.escape(name), text):
            found.append(Candidate(name, m.start(), m.end(), "roster"))

    # 重なりは長い方 / 検証済みの方を残す
    found.sort(key=lambda c: (c.start, -(c.end - c.start), not c.validated))
    kept: list[Candidate] = []
    for c in found:
        if kept and c.start < kept[-1].end:
            if c.validated and not kept[-1].validated:
                kept[-1] = c
            continue
        kept.append(c)
    return kept


# ---------------------------------------------------------------- 2. Jev で判定

PII_TYPES = {
    "person_name": "実在する個人の氏名（社員、顧客、家族など）。",
    "phone": "特定の個人につながる電話番号（携帯、自宅、個人の直通番号）。",
    "email": "特定の個人が使うメールアドレス。",
    "address": "自宅など個人の住所、またはそれに紐づく郵便番号。",
    "birthday": "特定の個人の生年月日。",
    "government_id": "マイナンバー、パスポート番号、運転免許証番号などの公的な番号。",
    "financial": "クレジットカード番号や銀行の口座番号。",
    "not_personal": "個人情報ではないもの：会社の代表電話、共有・窓口用のメールアドレス、オフィスの住所、"
                    "注文番号・チケット番号、商品名、著名人、誕生日ではない日付など。",
}

POLICY = (
    "個人情報とは、特定の個人を識別できる、またはその人に連絡できる情報のことです。"
    "会社全体の連絡先（代表電話、support@ や info@ のアドレス、オフィスの住所）や、"
    "業務上の識別番号（注文番号、請求書番号）は個人情報に含みません。"
)


def build_questions(cands: list[Candidate]):
    from typesafe_sdk import Choice, Noul, NoulCriteria

    qs = {}
    for i, c in enumerate(cands):
        qs[f"pii_{i}"] = Noul(
            instructions=f"`message` の中の `candidates[{i}].text` は、`policy` の定義に照らして、特定の個人の個人情報ですか？",
            criteria=NoulCriteria(
                true="その部分が特定の個人を識別する、またはその人に連絡できる（氏名、個人の電話番号、個人のメールアドレス、自宅住所、生年月日、公的な番号、口座・カード番号）。",
                false="その部分は会社全体の連絡先、業務上の識別番号、一般的な言葉など、特定の個人を指していない。",
            ),
        )
        qs[f"type_{i}"] = Choice(
            instructions=f"`message` の中の `candidates[{i}].text` は、どの種類の情報ですか？",
            criteria=PII_TYPES,
        )
    # 候補漏れのチェック: 拾えていない個人情報があれば人間レビューへ
    qs["uncovered"] = Noul(
        instructions="`message` の中に、`candidates` のどれにも含まれていない、特定の個人の個人情報がありますか？",
        criteria=NoulCriteria(
            true="メッセージ内の個人情報の一部が、候補リストから漏れている。",
            false="メッセージ内の個人情報はすべて候補リストに含まれている、または個人情報がない。",
        ),
    )
    return qs


@dataclass
class Judgment:
    p_pii: float
    pii_type: str
    type_conf: float


def judge_with_jev(message: str, cands: list[Candidate]) -> tuple[list[Judgment], float]:
    from typesafe_sdk import TypeSafeClient

    state = {
        "policy": POLICY,
        "message": message,
        "candidates": [{"text": c.text} for c in cands],
    }
    with TypeSafeClient() as client:
        r = client.system_one(state=state, questions=build_questions(cands), model=MODEL)
    js = [
        Judgment(r.nouls[f"pii_{i}"].noul, r.choices[f"type_{i}"].choice, r.choices[f"type_{i}"].confidence)
        for i in range(len(cands))
    ]
    return js, r.nouls["uncovered"].noul


def judge_offline(message: str, cands: list[Candidate]) -> tuple[list[Judgment], float]:
    """API なしで配線を確かめるためのダミー判定。精度の参考にはならない。"""
    hint_to_type = {"email": "email", "phone": "phone", "postal": "address", "digits12": "government_id",
                    "card": "financial", "account": "financial", "birthday": "birthday",
                    "address": "address", "name": "person_name", "roster": "person_name"}
    out = []
    for c in cands:
        ctx = message[max(0, c.start - 8):c.start]
        shared = "代表" in ctx or c.text.startswith(("support@", "info@"))
        out.append(Judgment(0.05 if shared else 0.9, "not_personal" if shared else hint_to_type[c.hint], 0.9))
    return out, 0.1


# ---------------------------------------------------------------- 3. ポリシーと置換

REPLACE_AT = 0.8   # これ以上なら置換
REVIEW_AT = 0.3    # この範囲は「念のため置換 + 要レビュー」 (迷ったら隠す側に倒す)
UNCOVERED_AT = 0.5

FAKE_NAMES = ["佐藤", "鈴木", "高橋", "伊藤", "渡辺", "山本", "中村", "小林", "加藤", "吉田"]
LABELS = {"person_name": "氏名", "phone": "電話番号", "email": "メール", "address": "住所",
          "birthday": "生年月日", "government_id": "個人番号", "financial": "口座・カード"}
SECRET = os.environ.get("PII_PSEUDONYM_SECRET", "dev-only-secret").encode()


def _h(value: str) -> int:
    return int(hmac.new(SECRET, value.encode(), hashlib.sha256).hexdigest(), 16)


def pseudonym(value: str, pii_type: str) -> str:
    """同じ値はいつも同じ偽値になる (会話の読みやすさを保つ)。秘密鍵なしでは元に戻せない。"""
    h = _h(value)
    if pii_type == "person_name":
        return FAKE_NAMES[h % len(FAKE_NAMES)] + ("" if len(value) <= 2 else "某")
    if pii_type == "phone":
        return f"090-0000-{h % 10000:04d}"
    if pii_type == "email":
        return f"user{h % 100000:05d}@example.com"
    if pii_type == "address":
        return "〒000-0000" if re.fullmatch(r"〒?\d{3}-\d{4}", value) else "東京都架空区1-1-1"
    if pii_type == "birthday":
        return "1900年1月1日"
    return "#" * len(re.sub(r"\D", "", value)) or "####"


@dataclass
class Result:
    redacted: str
    decisions: list[dict] = field(default_factory=list)
    needs_review: bool = False


def guard(message: str, roster: list[str], mode: str = "pseudonym", offline: bool = False) -> Result:
    cands = find_candidates(message, roster)
    # 候補が空でも「候補漏れ」の質問だけは送る (正規表現が何も拾えないときこそ漏れを疑うため)
    judgments, p_uncovered = (judge_offline if offline else judge_with_jev)(message, cands)

    res = Result(message, needs_review=p_uncovered >= UNCOVERED_AT)
    counters: dict[str, int] = {}
    pieces, cursor = [], 0
    for c, j in zip(cands, judgments):
        pii_type = j.pii_type
        if c.validated:  # チェックディジットが通った番号はモデルに関係なく隠す
            action = "replace"
            if pii_type == "not_personal":
                pii_type = "financial" if c.hint == "card" else "government_id"
        elif j.p_pii >= REPLACE_AT:
            action = "replace"
        elif j.p_pii >= REVIEW_AT:
            action = "replace+review"
            res.needs_review = True
        else:
            action = "keep"
        if action != "keep" and pii_type == "not_personal":
            pii_type = {"name": "person_name", "roster": "person_name"}.get(c.hint, "financial")

        if action == "keep":
            new = c.text
        elif mode == "mask":
            counters[pii_type] = counters.get(pii_type, 0) + 1
            new = f"[{LABELS.get(pii_type, '個人情報')}{counters[pii_type]}]"
        else:
            new = pseudonym(c.text, pii_type)

        pieces += [message[cursor:c.start], new]
        cursor = c.end
        res.decisions.append({"span": c.text, "hint": c.hint, "p_pii": round(j.p_pii, 2),
                              "type": pii_type, "action": action, "to": new})
    pieces.append(message[cursor:])
    res.redacted = "".join(pieces)
    return res


# ---------------------------------------------------------------- デモ

ROSTER = ["田中 美咲", "山田"]  # 実運用では社員マスタから

SAMPLES = [
    "田中さんの携帯は090-1234-5678です。急ぎなら直接どうぞ。代表は03-1111-2222。",
    "経費精算の件、山田さんの口座番号 1234567 に振り込んでください。問い合わせは support@example-corp.jp へ。",
    "新入社員の住所は東京都世田谷区桜丘3丁目5番、〒156-0054、生年月日1998年4月12日です。",
    "マイナンバー 1234 5678 9018 を人事に提出済み。注文番号 ORD-2024-000123 は別件です。",
    "明日の定例は14:00から。資料は共有フォルダにあります。",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["pseudonym", "mask"], default="pseudonym")
    ap.add_argument("--offline", action="store_true", help="API を呼ばずダミー判定で動かす")
    args = ap.parse_args()

    for msg in SAMPLES:
        r = guard(msg, ROSTER, mode=args.mode, offline=args.offline)
        print("入力 :", msg)
        print("出力 :", r.redacted, "  ⚠ 要レビュー" if r.needs_review else "")
        for d in r.decisions:
            print(f"   - {d['span']!r:<28} {d['hint']:<9} p={d['p_pii']:<5} {d['type']:<14} {d['action']:<15} -> {d['to']}")
        print()


if __name__ == "__main__":
    main()
