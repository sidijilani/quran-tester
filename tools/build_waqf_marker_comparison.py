#!/usr/bin/env python3
"""Show two marker designs on the same verified, three-stop example page."""
import json
from pathlib import Path

from build_waqf_marker_example import build_example

ROOT = Path(__file__).resolve().parents[1]


def main():
    example = build_example()
    template = (ROOT / 'tools/waqf_marker_comparison.html').read_text()
    output = ROOT / 'data/waqf-pilot/marker-comparison.html'
    output.write_text(template.replace('__EXAMPLE__', json.dumps(example, ensure_ascii=False).replace('<', '\\u003c')))
    print(output)


if __name__ == '__main__':
    main()
