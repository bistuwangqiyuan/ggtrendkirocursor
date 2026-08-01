#!/usr/bin/env python3
"""
Build the CJK font the PDF renderer embeds.

WHY A SUBSET, AND WHY IT IS COMMITTED
A PDF has to carry its own fonts, and the reports are bilingual: an English-only
font turns every Chinese report into a page of empty boxes. Full CJK fonts are
~9 MB because they cover 20k+ ideographs, most of which no business plan will
ever contain. This cuts Noto Sans SC down to the characters that actually occur —
GB2312 level 1, the 3,755 ideographs that make up the overwhelming majority of
modern Simplified Chinese text, plus Latin, digits and both punctuation sets.

The result is committed rather than generated during the Netlify build, for two
reasons: the build must not depend on downloading a font from a third party, and
Python is not part of the deployment toolchain. This script exists so the asset is
reproducible and auditable — run it and the bytes should match.

Licence: Noto Sans SC is SIL OFL 1.1, which permits redistribution of modified
(subset) versions. The licence text is written out next to the font.

Usage:
    python scripts/build-pdf-font.py
Requires: fonttools (pip install fonttools brotli), network access once.
"""

import io
import pathlib
import sys
import urllib.request
import zipfile

# public/ rather than src/: the same file is then both a static asset the browser
# can fetch and, via netlify.toml `included_files`, a file the SSR function can
# read from its own bundle. One copy, two delivery paths.
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "public" / "fonts"
OUT_FONT = OUT_DIR / "NotoSansSC-subset.ttf"
OUT_LICENSE = OUT_DIR / "OFL.txt"

# The variable-weight source in google/fonts (OFL). A single instance is
# extracted from it below, so only one download is needed.
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf"
LICENSE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt"

# Report text is body copy: one regular weight. Headings use size and colour
# instead of a second embedded weight, which would double the committed asset for
# a small typographic gain.
WEIGHT = 400


def gb2312_ideographs() -> set[str]:
    """
    Every ideograph GB2312 can encode: 6,763 characters, both frequency levels.

    Level 1 alone (the common 3,755) would be half the bytes, but the text being
    rendered is not ordinary prose — it is machine-written business analysis full
    of proper nouns, place names and technical terms, which is exactly where level
    2 characters live. A missing glyph in a document someone paid for is worse
    than 800 KB, so the whole encodable set goes in.

    Derived from the codec rather than a hard-coded list, so it is verifiable.
    """
    chars = set()
    for cp in range(0x4E00, 0xA000):
        ch = chr(cp)
        try:
            ch.encode("gb2312")
        except UnicodeEncodeError:
            continue
        chars.add(ch)
    return chars


def charset() -> set[str]:
    chars = set(chr(c) for c in range(0x20, 0x7F))  # ASCII printable
    chars |= set("°±×÷—–…‘’“”•·€£¥§©®™→←↑↓≈≤≥≠")
    chars |= set(chr(c) for c in range(0x3000, 0x3040))  # CJK punctuation
    chars |= set(chr(c) for c in range(0xFF00, 0xFF61))  # fullwidth forms
    chars |= set("￥　")
    chars |= gb2312_ideographs()
    return chars


def main() -> int:
    try:
        from fontTools import subset
        from fontTools.varLib import instancer
        from fontTools.ttLib import TTFont
    except ImportError:
        print("fonttools is required: pip install fonttools brotli", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"downloading {FONT_URL}")
    raw = urllib.request.urlopen(FONT_URL, timeout=180).read()
    print(f"  {len(raw) / 1_048_576:.1f} MB")

    # A .ttf served as a zip would be a redirect page, not a font; fail loudly
    # rather than committing garbage.
    if raw[:4] not in (b"\x00\x01\x00\x00", b"true", b"ttcf", b"OTTO"):
        if raw[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                name = next(n for n in zf.namelist() if n.endswith(".ttf"))
                raw = zf.read(name)
        else:
            print(f"unexpected download (starts with {raw[:8]!r})", file=sys.stderr)
            return 1

    font = TTFont(io.BytesIO(raw))
    if "fvar" in font:
        print(f"instancing wght={WEIGHT}")
        font = instancer.instantiateVariableFont(font, {"wght": WEIGHT}, inplace=True)

    chars = charset()
    print(f"subsetting to {len(chars)} characters")
    options = subset.Options()
    options.layout_features = ["kern", "liga", "locl", "ccmp"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)

    font.save(OUT_FONT)
    size = OUT_FONT.stat().st_size
    print(f"wrote {OUT_FONT} ({size / 1_048_576:.2f} MB)")

    print(f"downloading licence -> {OUT_LICENSE}")
    OUT_LICENSE.write_bytes(urllib.request.urlopen(LICENSE_URL, timeout=60).read())
    return 0


if __name__ == "__main__":
    sys.exit(main())
