"""Build the Nyra file-icon font and SVG outlines from a pinned OFL source.

Requires fonttools==4.67.0. This is an offline artwork maintenance command;
fontTools and the original font are not extension runtime dependencies.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SOURCE_SHA256 = 'dace262afcee68a5276f200d8026c57221735c0118ab5fda8c2c0d3dc409a8d0'
SOURCE_COMMIT = '69d0549e8fc7ad72e1531734c81237be401ec4fd'
PROJECT = Path(__file__).resolve().parents[1]


def bounds(glyph_set, name):
    pen = BoundsPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.bounds


def build(source_font: Path, source_license: Path, output: Path):
    if hashlib.sha256(source_font.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('source font differs from the pinned Roboto Condensed revision')
    reference = TTFont(PROJECT / 'themes/seti.woff')
    theme = json.loads((PROJECT / 'themes/nyra-seti-icon-theme.json').read_text())
    js = theme['iconDefinitions'][theme['languageIds']['javascript']]
    js_name = reference.getBestCmap()[int(js['fontCharacter'].lstrip('\\'), 16)]
    x0, bottom, x1, top = bounds(reference.getGlyphSet(), js_name)
    em = reference['head'].unitsPerEm
    # Align actual contours to Seti's JS baseline and center, not nominal boxes.
    center = (x0 + x1) / 2
    cap_height = (top - bottom) * .99
    maximum_width = (x1 - x0) * .98
    source = instantiateVariableFont(TTFont(source_font), {'wght': 800}, inplace=True)
    glyph_set = source.getGlyphSet()
    cmap = source.getBestCmap()
    source_cap = bounds(glyph_set, cmap[ord('N')])[3]
    recordings = {}
    for ext, tracking in [('ny', -10), ('ni', -70), ('nk', -55)]:
        pen = RecordingPen()
        offset = 0
        for index, letter in enumerate(ext.upper()):
            name = cmap[ord(letter)]
            if index:
                offset += tracking
            glyph_set[name].draw(TransformPen(pen, (1, 0, 0, 1, offset, 0)))
            offset += glyph_set[name].width
        measure = BoundsPen(glyph_set)
        pen.replay(measure)
        recordings[ext] = (pen, measure.bounds)
    sy = cap_height / source_cap
    sx = min(sy, maximum_width / max(b[2] - b[0] for _, b in recordings.values()))
    glyphs = {'.notdef': TTGlyphPen(None).glyph()}
    for ext, (recording, box) in recordings.items():
        shear = sy * math.tan(math.radians(6))
        measure = BoundsPen(glyph_set)
        recording.replay(TransformPen(measure, (sx, 0, shear, sy, 0, bottom)))
        shift = center - (measure.bounds[0] + measure.bounds[2]) / 2
        pen = TTGlyphPen(glyph_set)
        recording.replay(TransformPen(pen, (sx, 0, shear, sy, shift, bottom)))
        glyphs[ext] = pen.glyph()
    font = FontBuilder(em, isTTF=True)
    font.setupGlyphOrder(list(glyphs))
    font.setupCharacterMap({0xE000 + i: ext for i, ext in enumerate(('ny', 'ni', 'nk'))})
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics({name: (em, getattr(glyph, 'xMin', 0)) for name, glyph in glyphs.items()})
    font.setupHorizontalHeader(ascent=reference['hhea'].ascent, descent=reference['hhea'].descent,
                               lineGap=reference['hhea'].lineGap)
    font.setupNameTable({
        'familyName': 'Nyra File Icons', 'styleName': 'Regular',
        'uniqueFontIdentifier': 'NyraFileIcons-1.000', 'fullName': 'Nyra File Icons',
        'psName': 'NyraFileIcons', 'version': 'Version 1.000',
        'copyright': 'Copyright 2011 The Roboto Project Authors; Nyra icon adaptations.',
        'licenseDescription': 'SIL Open Font License 1.1; see NYRA-FILE-ICONS-OFL.txt.',
        'licenseInfoURL': 'https://openfontlicense.org/',
    })
    font.setupOS2(sTypoAscender=reference['OS/2'].sTypoAscender,
                 sTypoDescender=reference['OS/2'].sTypoDescender,
                 sTypoLineGap=reference['OS/2'].sTypoLineGap,
                 usWinAscent=reference['OS/2'].usWinAscent,
                 usWinDescent=reference['OS/2'].usWinDescent,
                 sCapHeight=round(cap_height), fsType=0)
    font.setupPost()
    font.setupMaxp()
    font.font['head'].created = font.font['head'].modified = 3786912000
    font.font.recalcTimestamp = False
    output.mkdir(parents=True, exist_ok=True)
    font.font.flavor = 'woff'
    font.font.save(output / 'nyra-file-icons.woff')
    (output / 'NYRA-FILE-ICONS-OFL.txt').write_bytes(source_license.read_bytes())
    outlines = output / 'outlines'
    outlines.mkdir(exist_ok=True)
    for ext in ('ny', 'ni', 'nk'):
        pen = SVGPathPen(font.font.getGlyphSet())
        font.font.getGlyphSet()[ext].draw(pen)
        for suffix, color in (('', '#498BA7'), ('-dark', '#519ABA')):
            # Crop the em around its center for 16px image fallback consumers;
            # the font uses the unmodified Seti em and 150% CSS font size.
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" '
                   f'viewBox="0 0 16 16" role="img" aria-label="{ext.upper()} file icon">\n'
                   f'<g transform="translate(-4 20) scale(.024 -.024)">'
                   f'<path fill="{color}" d="{pen.getCommands()}"/></g>\n</svg>\n')
            (outlines / f'file-{ext}{suffix}.svg').write_text(svg)
    report = {'family': 'Nyra File Icons', 'license': 'OFL-1.1',
        'source': {'repository': 'https://github.com/google/fonts', 'commit': SOURCE_COMMIT,
                   'path': 'ofl/robotocondensed/RobotoCondensed[wght].ttf', 'sha256': SOURCE_SHA256},
        'weight': 800, 'optical_slant_degrees': 6, 'units_per_em': em,
        'reference': 'Seti JavaScript actual contour bounds and baseline',
        'glyphs': {ext: {'codepoint': f'E00{i}', 'bounds': bounds(font.font.getGlyphSet(), ext)}
                   for i, ext in enumerate(('ny', 'ni', 'nk'))}}
    (output / 'NYRA-FILE-ICONS-SOURCE.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['glyphs'], indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-font', type=Path, required=True)
    parser.add_argument('--source-license', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    args = parser.parse_args()
    build(args.source_font, args.source_license, args.out_dir)
