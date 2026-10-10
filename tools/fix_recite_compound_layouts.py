#!/usr/bin/env python3
"""Realign four lines with grouped Quran.com tokens to canonical Quran words.
Uses the existing line segmentation algorithm and page artwork. These generated
boxes still require visual review; no canonical word is dropped to fit a count.
Requires quran-transcript==0.6.4 and opencv-python-headless.
"""
import json,math,re
from collections import defaultdict
from pathlib import Path
from quran_transcript import Aya
import build_ayah_layout as geometry
ROOT=Path(__file__).resolve().parents[1]
CASES={27:'2:181',177:'8:6',254:'13:37',451:'37:130'}
source=json.loads((ROOT/'data/sources/waqf-qurancom-words.json').read_text())['verses']
for number,affected in CASES.items():
    layout=json.loads((ROOT/f'data/ayah-layout-pages/{number}.js').read_text().split(f'["{number}"]=')[1].rstrip(';\n'))
    image=geometry.cv2.imread(str(ROOT/f'assets/pages/{number}.jpg'));height,width=image.shape[:2]
    mask=geometry.ink_mask(image);lines=geometry.detect_line_boxes(image,max(map(int,layout['page']['lines'])))
    targets={seg['l'] for seg in layout['ayat'][affected] if seg.get('words')}
    tokens=defaultdict(list)
    for ref,segs in sorted(layout['ayat'].items(),key=lambda pair:tuple(map(int,pair[0].split(':')))):
        words=Aya(sura_idx=int(ref.split(':')[0]),aya_idx=int(ref.split(':')[1])).get().uthmani_words
        expanded=[];ordinal=0
        for entry in source[ref]:
            pieces=[p for p in entry['ar'].split() if re.search('[ء-يٱ]',p)]
            for piece in pieces:
                ordinal+=1;expanded.append({'ayah':ref,'line':entry['line'],'position':ordinal,'type':'word','text':words[ordinal-1]})
        assert ordinal==len(words),(ref,ordinal,len(words))
        present={w['i'] for seg in segs for w in seg.get('words',[])}
        # Other ayahs on these lines are not compounds. Preserve physical page
        # membership rather than assuming upstream page assignments are exact.
        for token in expanded:
            if ref==affected or token['position'] in present:
                if token['line'] in targets:tokens[token['line']].append(token)
        if len(source[ref]) in present:
            last_line=source[ref][-1]['line']
            if last_line in targets:tokens[last_line].append({'ayah':ref,'line':last_line,'type':'end','position':0,'text':''})
    canonical={};corrections={}
    for line,items in sorted(tokens.items()):
        if affected=='37:130':
            # These two canonical tokens are printed as a connected visual group.
            # Keep both recognition words and reveal the shared box only together.
            combined=[]
            for token in items:
                if token['ayah']==affected and token['position']==3:
                    token={**token,'text':token['text']+' '+next(t['text'] for t in items if t['ayah']==affected and t['position']==4),'positions':[3,4]}
                elif token['ayah']==affected and token['position']==4:continue
                combined.append(token)
            items=combined
        line_box=lines[line]
        spans=geometry.visual_token_boxes(mask,items,line_box,width,height)
        if not spans:raise ValueError(f'Page {number}, line {line}: cannot resolve visual word spans')
        for token,box in zip(items,spans):
            if token['type']!='word':continue
            key=f"{token['ayah']}:{token['position']}"
            corrections[key]=[math.floor(box['x']*width)-2,math.floor(box['y']*height)-3,
                math.ceil((box['x']+box['w'])*width)-math.floor(box['x']*width)+4,
                math.ceil((box['y']+box['h'])*height)-math.floor(box['y']*height)+6]
            if token['ayah']==affected:
                for position in token.get('positions',[token['position']]):
                    canonical.setdefault(affected,[]).append({**box,'i':position,'line':line,'group':token.get('positions',[position])})
                    corrections[f'{affected}:{position}']=corrections[key]
    assert len(canonical[affected])==len(Aya(sura_idx=int(affected.split(':')[0]),aya_idx=int(affected.split(':')[1])).get().uthmani_words)
    result={'note':'Canonical token realignment of grouped metadata; generated word geometry awaits visual review.',
            'source':'data/sources/waqf-qurancom-words.json + tools/build_ayah_layout.py segmentation',
            'canonicalGeometry':canonical,'words':corrections}
    (ROOT/f'data/recite/layout-{number}-corrections.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(f'Corrected {affected} on page {number}: {len(canonical[affected])} canonical words',flush=True)
