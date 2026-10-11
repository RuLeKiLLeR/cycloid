#!/usr/bin/env bash
# Regenerate _template/cycloid_reference.docx.
#
# The reference docx is a hybrid of (a) pandoc's default style set — which
# provides working Table, Heading, TOC, list, and code styles — and (b) the
# Cycloid letterhead's header (logo) and footer (address line +
# confidentiality marker). Without this hybrid, pandoc-generated docx
# files lose all table column structure because the letterhead's bare
# styles.xml does not declare a Table style.
#
# Re-run this script when either the letterhead changes or pandoc is
# upgraded enough to ship new defaults.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LETTERHEAD="${SCRIPT_DIR}/cycloid_letterhead.docx"
OUTPUT="${SCRIPT_DIR}/cycloid_reference.docx"

if ! command -v pandoc >/dev/null 2>&1; then
  echo "error: pandoc not found in PATH" >&2
  exit 1
fi
if [[ ! -f "${LETTERHEAD}" ]]; then
  echo "error: missing ${LETTERHEAD}" >&2
  exit 1
fi

PANDOC_DEFAULT="$(mktemp -t pandoc-default.XXXXXX.docx)"
trap 'rm -f "${PANDOC_DEFAULT}"' EXIT
pandoc --print-default-data-file reference.docx > "${PANDOC_DEFAULT}"

python3 - "${LETTERHEAD}" "${PANDOC_DEFAULT}" "${OUTPUT}" <<'PY'
import sys, zipfile, re
letterhead, pandoc_default, output = sys.argv[1:4]

# Pandoc's default styles, numbering, and settings drive table / TOC / heading
# rendering. The letterhead's are used for the header (logo), footer (address),
# and media — we keep those intact.
with zipfile.ZipFile(pandoc_default) as zpd:
    styles = zpd.read("word/styles.xml").decode("utf-8")
    numbering = zpd.read("word/numbering.xml")
    settings = zpd.read("word/settings.xml")

# Pagination fixes for tables under headings:
#   * Pages and Word honor `keepNext` on Heading 2 so strictly that, when the
#     table that follows is taller than the remaining space on the page, the
#     heading and table both get pushed — but the heading often ends up alone
#     with a huge gap. Removing keepNext from Heading 2 lets the heading sit
#     at the natural break and the table flow into the next page.
#   * Adding pageBreakBefore to Heading 1 means each top-level Section starts
#     on its own page. This replaces the unreliable `\newpage` markers in the
#     source markdown.
def patch_style(xml, style_id, transform):
    pattern = re.compile(rf'(<w:style[^>]*w:styleId="{style_id}"[^>]*>)(.*?)(</w:style>)', re.DOTALL)
    def repl(m):
        return m.group(1) + transform(m.group(2)) + m.group(3)
    return pattern.sub(repl, xml, count=1)

def remove_keep_next(body):
    return re.sub(r'\s*<w:keepNext\s*/>', '', body)

def add_page_break_before(body):
    # Insert <w:pageBreakBefore/> at the top of <w:pPr> if not already present.
    if 'pageBreakBefore' in body:
        return body
    return re.sub(r'(<w:pPr>)', r'\1<w:pageBreakBefore />', body, count=1)

def strip_keep(body):
    body = re.sub(r'\s*<w:keepNext\s*/>', '', body)
    body = re.sub(r'\s*<w:keepLines\s*/>', '', body)
    return body

# Strip keepNext / keepLines aggressively. Pages renders these settings
# pessimistically: when a heading sits with keepNext or keepLines above a
# table, and the table doesn't fit the remaining page space, Pages orphans
# the heading at the top of the previous page and pushes the entire table
# to the next page, leaving a large blank. Since every Section starts with
# pageBreakBefore on Heading 1, headings can't orphan at the bottom of a
# page, so we don't need keepNext or keepLines for layout safety.
for hid in ("Heading1", "Heading2", "Heading3", "Heading4", "Heading5",
            "Heading6", "Heading7", "Heading8", "Heading9", "Title", "Subtitle"):
    styles = patch_style(styles, hid, strip_keep)

styles = patch_style(styles, "Heading1", add_page_break_before)

swaps = {
    "word/styles.xml":    styles.encode("utf-8"),
    "word/numbering.xml": numbering,
    "word/settings.xml":  settings,
}

with zipfile.ZipFile(letterhead) as zin, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        data = swaps.get(info.filename, zin.read(info.filename))
        zout.writestr(info, data)

print(f"Wrote {output}")
PY
