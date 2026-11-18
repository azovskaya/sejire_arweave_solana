"""Reopen real exports and check content and geometry in PDF points (72 per inch).

Usage: python3 scripts/check-layout-pdfs.py /tmp/sejire-layout
Requires PyMuPDF. All measurements come from the saved files, independent of
the TypeScript layout calculations. Each fixture contains only synthetic data.
"""
import argparse
import bisect
import collections
import json
import re
from pathlib import Path

import fitz


def normalized(text):
    return "".join(text.split())


def near_color(value, target):
    # jsPDF rounds some RGB values to two decimals before serializing them.
    return value is not None and max(abs(a * 255 - b) for a, b in zip(value, target)) < 3


def contains(rect, child, epsilon=0.35):
    return (child.x0 >= rect.x0 - epsilon and child.y0 >= rect.y0 - epsilon
            and child.x1 <= rect.x1 + epsilon and child.y1 <= rect.y1 + epsilon)


def pdf_lines(page):
    # get_text() normally clips at the MediaBox, which could hide a real bug.
    # get_texttrace() exposes even off-page glyphs in PDF painting order.
    for span in page.get_texttrace():
        rows = {}
        for codepoint, glyph, origin, box in span["chars"]:
            row = rows.setdefault(round(origin[1], 2), [])
            row.append((chr(codepoint), fitz.Rect(box)))
        for row in rows.values():
            text = "".join(c for c, _ in row)
            if not text.strip():
                continue
            box = fitz.Rect(row[0][1])
            for _, char_box in row[1:]:
                box |= char_box
            yield {"text": text, "box": box, "seq": span["seqno"], "size": span["size"]}


def read_cells(kind, drawings, page):
    """Identify the printed card/list geometry and paint order from vector paths."""
    cells = []
    for d in drawings:
        if d["type"] != "fs":
            continue
        r = d["rect"]
        paint = d["fill"]
        if kind == "classic" and near_color(paint, (255, 253, 248)):
            cells.append((d["seqno"], r, None))
        elif kind == "cascade" and (near_color(paint, (255, 250, 242))
                                    or near_color(paint, (248, 228, 196))):
            cells.append((d["seqno"], r, None))
        elif kind == "manuscript" and near_color(paint, (252, 243, 220)):
            # Both the generation label and the wide cartouche are painted separately.
            cells.append((d["seqno"], r, None))
        elif kind == "registry" and (near_color(paint, (186, 148, 88))
                                     or near_color(paint, (158, 112, 52))):
            # Generation labels are distinct from the ornament belts on the page.
            if 50 < r.width < 130 and 8 < r.height < 40 and 80 < r.y0 < page.rect.height - 80:
                cells.append((d["seqno"], r, None))

    if kind == "registry" and cells:
        # Alternating fills (including self) extend exactly across the printed
        # register's rows. Label centers determine which row a name belongs to.
        bands = [d["rect"] for d in drawings if d["type"] == "f" and
                 (near_color(d["fill"], (222, 200, 158)) or near_color(d["fill"], (210, 178, 120)))]
        if not bands:
            raise AssertionError("registry missing row bands")
        exemplar = bands[0]
        rows = []
        for seq, label, _ in cells:
            cy = (label.y0 + label.y1) / 2
            rows.append((seq, label, fitz.Rect(label.x1, cy - exemplar.height / 2,
                                                exemplar.x1, cy + exemplar.height / 2)))
        return rows
    return cells


DETAIL_TITLES = {"Полные записи", "Толық жазбалар", "Full entries"}
DETAIL_KEYS = {"Номера в скобках — записи на следующих листах",
               "Жақшадағы нөмірлер — келесі беттердегі жазбалар",
               "Bracketed numbers refer to entries on the following pages"}
FOLIO = re.compile(r"^(лист|бет|sheet|плакат|poster|постер) [0-9]+ */ *[0-9]+( · .+)?$", re.I)
GENERATION = ["Өзі", "Әке", "Ата", "Арғы ата", "Баба", "Тек ата", "Түп ата"]


def crosses_card(a, b, bounds):
    # Clip the connector parametrically against the card interior. Endpoints
    # touching a card's edge are intended; strokes through its body are not.
    r = bounds + (0.6, 0.6, -0.6, -0.6)
    low, high = 0.0, 1.0
    for origin, delta, first, last in ((a.x, b.x-a.x, r.x0, r.x1), (a.y, b.y-a.y, r.y0, r.y1)):
        if abs(delta) < 1e-8:
            if not first < origin < last:
                return False
        else:
            t0, t1 = sorted(((first-origin)/delta, (last-origin)/delta))
            low, high = max(low, t0), min(high, t1)
    return high > low


def validate(out, spec, store):
    findings = collections.Counter()
    examples = {}
    def flag(category, example):
        findings[category] += 1
        if category not in examples:
            examples[category] = str(example)[:180]

    persons = store["draft"]["persons"]
    kind = spec["format"]
    name_text, poster_rows = [], []
    details, current_ref = {}, None
    n_cells, text_count, edges = 0, 0, 0
    with fitz.open(out / spec["filename"]) as doc:
        pages = len(doc)
        for number, page in enumerate(doc, 1):
            lines = list(pdf_lines(page))
            text_count += len(lines)
            if not lines:
                flag("empty_page", number)
            drawings = page.get_drawings()
            cells = read_cells(kind, drawings, page)
            n_cells += len(cells)
            seqs = [seq for seq, _, _ in cells]
            cells_text = collections.defaultdict(list)
            is_detail = not cells and lines and lines[0]["text"] in DETAIL_TITLES
            previous_detail = None
            # The brand lives in the footer outside the ornamental frame.
            inside = fitz.Rect(page.rect)
            if kind == "classic":
                inside += (9.4 * 72 / 25.4,) * 2 + (-9.4 * 72 / 25.4,) * 2
            else:
                inside += (5 * 72 / 25.4,) * 2 + (-5 * 72 / 25.4,) * 2
            for i, (_, card, _) in enumerate(cells):
                if not contains(inside, card):
                    flag("card_outside_frame", (number, card))
                for _, other, _ in cells[i+1:]:
                    overlap = card & other
                    if overlap.width > 0.5 and overlap.height > 0.5:
                        flag("overlapping_cards", (number, card, other))
            if kind == "classic":
                for d in drawings:
                    if d["type"] != "s" or not near_color(d["color"], (150, 130, 100)):
                        continue
                    for op in d["items"]:
                        if op[0] != "l":
                            continue
                        _, a, b = op
                        edges += 1
                        if a not in inside or b not in inside:
                            flag("connector_outside_frame", (number, a, b))
                        if any(crosses_card(a, b, r) for _, r, _ in cells):
                            flag("connector_crosses_card", (number, a, b))
            for line in lines:
                rect, text = line["box"], line["text"]
                if not contains(page.rect, rect):
                    flag("text_outside_page", (number, text[:45], rect))
                # Running matter is measured against the MediaBox above and
                # excluded only from the corresponding text/cell assertions.
                if is_detail:
                    if text in DETAIL_TITLES and rect.y0 < 85:
                        continue
                    if rect.y0 > page.rect.height - 50 and (
                        FOLIO.fullmatch(text) or re.fullmatch(r"\[[0-9]+\](?:[–-]\[[0-9]+\])?", text)
                    ):
                        continue
                    if previous_detail is not None:
                        overlap = rect & previous_detail
                        if overlap.width > 1 and overlap.height > line["size"] * 0.18:
                            flag("overlapping_detail_text", (number, text[:45]))
                    previous_detail = rect
                    heading = re.match(r"^\[([0-9]+)\] ", text)
                    if heading:
                        current_ref = int(heading[1])
                        details[current_ref] = []
                    elif current_ref is not None:
                        details[current_ref].append(normalized(text))
                name_text.append(normalized(text))
                if rect.y0 > page.rect.height - 17 and text in "SEJIRE":
                    continue
                if FOLIO.fullmatch(text) or text in DETAIL_KEYS:
                    if any(not (rect & c[1]).is_empty for c in cells):
                        flag("caption_overlaps_cell", (number, text))
                    continue
                if cells and not contains(inside, rect):
                    flag("text_outside_frame", (number, text[:45], rect))
                j = bisect.bisect_right(seqs, line["seq"]) - 1
                if j < 0:
                    continue
                _, cell, row = cells[j]
                if row is not None and cells_text[j]:
                    cell = row  # after the generation label, the actual name/date column
                if not contains(cell, rect):
                    flag("text_outside_cell", (number, text[:45], rect, cell))
                for prev in cells_text[j]:
                    overlap = rect & prev["box"]
                    # Tolerate a small overlap of nominal font metrics; reject
                    # substantive overlap of two separate printed lines.
                    if overlap.width > 1 and overlap.height > min(line["size"], prev["size"]) * 0.18:
                        flag("overlapping_cell_text", (number, prev["text"][:36], text[:36], overlap))
                cells_text[j].append(line)
            for j in range(len(cells)):
                if j not in cells_text:
                    flag("empty_cell", (number, j))
            if kind == "manuscript":
                for j in range(0, len(cells) - 1, 2):
                    poster_rows.append(cells_text[j] + cells_text[j + 1])
            elif kind in ("registry", "cascade"):
                poster_rows.extend(cells_text[j] for j in range(len(cells)))
    if kind != "classic":
        # Chart labels and names must follow the chosen paternal path from the
        # oldest relative to the focus, including across poster page breaks.
        expected = list(reversed(spec["expected"]))
        if len(poster_rows) != len(expected):
            flag("wrong_paternal_card_count", (len(poster_rows), len(expected)))
        for idx, (row, pid) in enumerate(zip(poster_rows, expected)):
            distance = len(expected) - 1 - idx
            label = GENERATION[distance] if distance < len(GENERATION) else f"{distance+1}-ші ата"
            if not row or row[0]["text"] != label:
                flag("wrong_generation_label", (idx, label))
            body = "".join(normalized(line["text"]) for line in row[1:])
            sources = [body] + ["".join(details.get(int(ref), [])) for ref in re.findall(r"\[([0-9]+)\]", body)]
            if not any(normalized(persons[pid]["name"]) in item for item in sources):
                flag("wrong_or_incomplete_card_name", (idx, pid))
    if n_cells == 0:
        flag("no_chart_cells", kind)
    raw = "".join(name_text)
    expected_names = {normalized(persons[i]["name"]) for i in spec["expected"]}
    for name in expected_names:
        if name not in raw:
            flag("missing_full_name", name)
    # Several distinct relatives in one fixture share a name. Only flag names
    # that are absent from the requested ancestry or explicitly limited export.
    expected_ids = set(spec["expected"])
    for p in persons.values():
        if p["id"] in expected_ids:
            continue
        # A short natural name can appear inside another relative's patronymic.
        # Negative assertions use unique fixture markers or named disconnected records.
        if re.match(r"^[ТГ][0-9]+ ", p["name"]) or p["name"] in ("Посторонняя запись", "Удалённая запись"):
            if normalized(p["name"]) in raw:
                flag("unexpected_name", p["name"])
    clan = store["meta"].get("clanName") or ""
    if kind != "classic" and clan.strip() and normalized(clan) not in raw:
        flag("missing_full_clan", clan)
    return {"filename": spec["filename"], "pages": pages, "peopleExpected": len(spec["expected"]),
            "distinctNamesExpected": len(expected_names), "cellsMeasured": n_cells, "connectorSegments": edges, "textLines": text_count,
            "findings": dict(sorted(findings.items())), "examples": examples}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("directory", type=Path)
    args = p.parse_args()
    out = args.directory
    manifest = json.loads((out / "layout-manifest.json").read_text())
    stores = {f["id"]: json.loads((out / f["jsonFile"]).read_text())["store"] for f in manifest["fixtures"]}
    results, totals = [], collections.Counter()
    for spec in manifest["files"]:
        result = validate(out, spec, stores[spec["fixture"]])
        results.append(result)
        totals.update(result["findings"])
        print(result["filename"], json.dumps(result["findings"], ensure_ascii=False))
    report = {"fixtures": manifest["fixtures"], "fileCount": len(results),
              "pageCount": sum(r["pages"] for r in results),
              "passingFiles": sum(not r["findings"] for r in results),
              "findings": dict(totals), "files": results}
    (out / "layout-results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("files:", report["fileCount"], "pages:", report["pageCount"],
          "passing:", report["passingFiles"], "findings:", dict(totals))
    raise SystemExit(bool(totals))


if __name__ == "__main__":
    main()
