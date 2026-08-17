#!/usr/bin/env python3
"""
Regenerate the Traditional Chinese catalogues (`zh-TW.json`) from the Simplified
ones (`zh.json`) with OpenCC `s2twp`, then apply the Taiwan phrasing overrides
that OpenCC gets wrong.

Why this exists:
    #6546 produced the zh-TW catalogues from an ad-hoc OpenCC invocation plus a
    hand-applied glossary, so nothing in the repo could reproduce them and the
    phrasing residue found in #6555 had nowhere canonical to be fixed. This
    script is that place: the override tables below are the source of truth for
    every term where OpenCC's output is not what a Taiwanese reader expects.

Why Python rather than `opencc-js`:
    The shipped catalogues were produced by Python OpenCC. `opencc-js` is a
    separate implementation with no guarantee of identical output, so porting
    the generator would churn ~2000 values to buy nothing. The drift guard in
    `tests/i18n-zh-tw-catalogue.test.mts` does use `opencc-js`, which is safe for
    a different reason: it converts the Simplified SOURCE and compares, so it
    never depends on the Taiwan phrase layer where the two implementations can
    diverge. See that file's header for why the round trip proposed in #6555
    cannot work in either direction.

Two kinds of override, because two kinds of error:
    PHRASE_OVERRIDES  Applied to every value. Only for terms whose replacement
                      is unconditional in this product's vocabulary.
    KEY_OVERRIDES     Applied to one catalogue entry BEFORE the phrase rules,
                      which pre-empts them: the per-entry rule rewrites the
                      substring first, so the global rule finds nothing left to
                      match. It is not an opt-out flag — there is no way to say
                      "skip the global rule here", only to spell out the
                      replacement this entry wants instead, and that replacement
                      must not itself contain a phrase-rule source or the global
                      rule would fire on it anyway (asserted in
                      tests/i18n-zh-tw-catalogue.test.mts). Needed where the
                      correct Traditional form depends on the sentence: `訪問` is
                      both "access" (存取) and "visit" (造訪), and only the string
                      itself says which.

Usage:
    pip install opencc-python-reimplemented==0.1.7
    python3 scripts/convert-zh-tw.py            # rewrite both catalogues
    python3 scripts/convert-zh-tw.py --check    # exit 1 if either is stale

    npm run locales:zh-tw                       # the same two, as repo scripts
    npm run locales:zh-tw:check

Output is byte-identical to the committed catalogues, so `--check` is a real
staleness gate rather than a formatting diff. Verified against
opencc-python-reimplemented 0.1.7; a different OpenCC build may shift terms that
no override pins, which `--check` will surface.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from opencc import OpenCC
except ImportError:  # pragma: no cover - dependency hint, not logic
    sys.exit(
        "opencc is required: pip install opencc-python-reimplemented\n"
        "(the PyPI name `opencc` is a different, unrelated package)"
    )

REPO_ROOT = Path(__file__).resolve().parent.parent

CATALOGUES = (
    ("src", REPO_ROOT / "src/locales"),
    ("pro-test", REPO_ROOT / "pro-test/src/locales"),
)

# Applied to every value, longest match first. Each entry is a term OpenCC
# renders in a form that is either wrong or Mainland-preferred in Taiwan.
PHRASE_OVERRIDES = {
    # --- Mainland vocabulary s2twp leaves alone (#6546 glossary) ---
    "實時": "即時",
    "攝像頭": "攝影機",
    "賬戶": "帳戶",
    # --- Mainland vocabulary s2twp leaves alone (#6555 section A) ---
    "自定義": "自訂",
    "小部件": "小工具",
    "小元件": "小工具",
    # `s2twp` expands 权限 to 許可權, which is not a word in Taiwan.
    "許可權": "權限",
    # 高级 means advanced/premium throughout this product, never "high-order",
    # which is the only sense 高階 carries in Taiwan.
    "高階": "進階",
    # Default sense in this product is data/API access. Entries meaning "visit"
    # opt out via KEY_OVERRIDES.
    "訪問": "存取",
    # --- OpenCC picked the wrong Traditional character for an ambiguous one ---
    # 历 -> 曆 (calendar) instead of 歷 (history), triggered by the preceding 长.
    "曆史": "歷史",
    # 发 -> 髮 (hair) instead of 發 (happen), triggered by the preceding 断.
    "髮生": "發生",
    # 只 -> 隻, the measure word for animals. Taiwan counts funds with 檔.
    "隻基金": "檔基金",
}

# Applied before PHRASE_OVERRIDES, so an entry can opt out of a global rule.
# Keyed by catalogue name, then by dotted path (array elements as `key[0]`).
KEY_OVERRIDES = {
    "src": {
        # "visit <url>", not data access.
        "modals.settingsWindow.worldMonitor.register.description": {
            "請訪問": "請造訪",
        },
        # "IN {{count}} DAYS". OpenCC keeps 后 because 天后 is a word in its own
        # right (a deity, a diva) — here it is 天 + 后 meaning "days after".
        "popups.techEvent.days.inDays": {
            "天后": "天後",
        },
    },
    "pro-test": {
        # "Is this only for conflict monitoring?" — 只 as "only", not a measure word.
        "faq.q5": {
            "這隻": "這只",
        },
    },
}

# Longest first so a rule can never eat the prefix of a longer one.
_PHRASE_RULES = sorted(PHRASE_OVERRIDES.items(), key=lambda kv: -len(kv[0]))


def apply_overrides(value: str, path: str, key_rules: dict) -> str:
    """Apply the per-entry rules, then the global ones, to one converted value."""
    for src, dst in key_rules.get(path, {}).items():
        value = value.replace(src, dst)
    for src, dst in _PHRASE_RULES:
        value = value.replace(src, dst)
    return value


def convert_tree(node, converter: OpenCC, key_rules: dict, path: str = ""):
    """Convert every string value, leaving keys and non-string leaves untouched."""
    if isinstance(node, dict):
        return {
            key: convert_tree(val, converter, key_rules, f"{path}.{key}" if path else key)
            for key, val in node.items()
        }
    if isinstance(node, list):
        return [
            convert_tree(val, converter, key_rules, f"{path}[{index}]")
            for index, val in enumerate(node)
        ]
    if isinstance(node, str):
        return apply_overrides(converter.convert(node), path, key_rules)
    return node


def render(data) -> str:
    """Match the formatting of every other catalogue in the repo."""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the command line, rejecting anything not defined here.

    Membership tests over `sys.argv` accept typos silently: `--chek` was not
    `--check`, so the script took the write path, rewrote both catalogues and
    exited 0 — a staleness gate turning into a writer on a one-character slip,
    reported as success. argparse exits 2 on an unrecognised argument instead.
    """
    parser = argparse.ArgumentParser(
        prog="scripts/convert-zh-tw.py",
        description=(
            "Regenerate the Traditional Chinese catalogues from the Simplified "
            "ones with OpenCC s2twp plus the Taiwan phrasing overrides."
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 if either catalogue differs from this script's output",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    check_only = parse_args(argv).check
    converter = OpenCC("s2twp")
    stale = []

    for name, locales_dir in CATALOGUES:
        source = locales_dir / "zh.json"
        target = locales_dir / "zh-TW.json"
        data = json.loads(source.read_text(encoding="utf-8"))
        expected = render(convert_tree(data, converter, KEY_OVERRIDES.get(name, {})))

        if check_only:
            actual = target.read_text(encoding="utf-8") if target.exists() else ""
            if actual != expected:
                stale.append(target.relative_to(REPO_ROOT).as_posix())
            continue

        target.write_text(expected, encoding="utf-8", newline="\n")
        print(f"wrote {target.relative_to(REPO_ROOT).as_posix()}")

    if check_only:
        if stale:
            print("stale, regenerate with `python3 scripts/convert-zh-tw.py`:")
            for path in stale:
                print(f"  {path}")
            return 1
        print("zh-TW catalogues are up to date")

    return 0


if __name__ == "__main__":
    sys.exit(main())
