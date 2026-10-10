#!/usr/bin/env python3
"""Build canonical phonetic references and Madani word geometry for Recite.
Use --all to build 604 compact page files and the verse/word index. Arabic and
word numbers are preserved. Requires quran-transcript==0.6.4.
"""
import argparse,json,math
from functools import lru_cache
from pathlib import Path
from quran_transcript import Aya,MoshafAttributes,quran_phonetizer
ROOT=Path(__file__).resolve().parents[1]
moshaf=MoshafAttributes(rewaya='hafs',madd_monfasel_len=4,madd_mottasel_len=4,madd_mottasel_waqf=4,madd_aared_len=4)
@lru_cache(maxsize=None)
def get_aya(s,a):return Aya(sura_idx=s,aya_idx=a).get()
@lru_cache(maxsize=120000)
def phone_string(text,chapter):return quran_phonetizer(text,moshaf,sura_idx=chapter).phonemes
@lru_cache(maxsize=20000)
def parts(text,chapter):
    out=quran_phonetizer(text,moshaf,sura_idx=chapter)
    assert len(out.mappings)==len(text)
    words,start=[],0
    for word in text.split(' '):
        pos=[p.pos for p in out.mappings[start:start+len(word)] if not p.deleted]
        assert pos,word
        words.append(out.phonemes[min(p[0] for p in pos):max(p[1] for p in pos)])
        start+=len(word)+1
    return words

notice='/* Arabic: Tanzil Uthmani 1.1, © 2007–2024 Tanzil Project.\n   Verbatim source preserved. Notice: TRANSCRIPT-LICENSE. https://tanzil.net/ */\n'
def build_page(number,positions,titles):
    if number==1:
        ayat=[get_aya(1,i) for i in range(1,8)]
        layout=None
    else:
        raw=(ROOT/f'data/ayah-layout-pages/{number}.js').read_text()
        layout=json.loads(raw.split(f'["{number}"]=')[1].rstrip(';\n'))
        refs=sorted((ref for ref,segs in layout['ayat'].items() if any(seg.get('words') for seg in segs)),key=lambda ref:tuple(map(int,ref.split(':'))))
        ayat=[get_aya(*map(int,ref.split(':'))) for ref in refs]
    sura=ayat[0].sura_idx


    if number==1:
        manual=json.loads((ROOT/'data/recite/layout-1.json').read_text());width,height=486,738
        corrections={}
        boxes=manual['boxes'];medallions=manual['medallions'];conceal=[12,84,462,584]
        cues=[0,1,2,3];title='Al-Fatiha';subtitle='Page 1 · Begin with Bismillah.'
    else:
        audit=ROOT/f'data/recite/layout-{number}-corrections.json'
        audited=json.loads(audit.read_text()) if audit.exists() else {}
        corrections=audited.get('words',{})
        def locate(ref):
            located=({w['i']:(w,w['line']) for w in audited['canonicalGeometry'][ref]}
                     if ref in audited.get('canonicalGeometry',{}) else
                     {w['i']:(w,seg['l']) for seg in layout['ayat'][ref] for w in seg.get('words',[])})
            for i,(word,line) in list(located.items()):
                rect=corrections.get(f'{ref}:{i}')
                if rect:
                    located[i]=({**word,'x':(rect[0]+2)/width,'y':(rect[1]+3)/height,
                                'w':(rect[2]-4)/width,'h':(rect[3]-6)/height},line)
            return located
        width,height=layout['page']['w'],layout['page']['h'];boxes=[];medallions=[];lastwords=[]
        for a in ayat:
            located=locate(f'{a.sura_idx}:{a.aya_idx}')
            for i in sorted(located):
                w,line=located[i]
                x=math.floor(w['x']*width)-2;y=math.floor(w['y']*height)-3
                right=math.ceil((w['x']+w['w'])*width)+2;bottom=math.ceil((w['y']+w['h'])*height)+3
                boxes.append([x,y,right-x,bottom-y])
            lastwords.append((located[max(located)][0],located[max(located)][1],max(located)==len(a.uthmani_words)))
        # Preserve the gaps occupied by verse medallions, based on adjoining word boxes.
        for idx,(word,line,is_end) in enumerate(lastwords):
            if not is_end:continue
            nextwords=locate(refs[idx+1]) if idx+1<len(refs) else {}
            left=15
            if nextwords and nextwords[min(nextwords)][1]==line:
                nxt=nextwords[min(nextwords)][0];left=math.ceil((nxt['x']+nxt['w'])*width)+2
            right=math.floor(word['x']*width)-2
            band=layout['page']['lines'][str(line)]
            if right>left:medallions.append([left,math.floor(band['y']*height),right-left,math.ceil(band['h']*height)])
        medallions=audited.get('medallions',medallions)
        bands=list(layout['page']['lines'].values())
        top=math.floor(min(b['y'] for b in bands)*height)
        bottom=math.ceil(max(b['y']+b['h'] for b in bands)*height)
        conceal=[14,top,width-28,bottom-top];cues=[0,1,2]
        title=next(a['s_en'] for a in titles if a['s']==sura)
        subtitle=f'Page {number} · Ayat {ayat[0].aya_idx}–{ayat[-1].aya_idx}. Begin at the outlined word.'

    words=[]
    # Connected variants include the following ayah within each chapter. Geometry
    # can include only part of an ayah; keep original indices rather than renumber.
    connected={}
    for chapter in dict.fromkeys(a.sura_idx for a in ayat):
        chapter_ayat=[a for a in ayat if a.sura_idx==chapter]
        last=chapter_ayat[-1]
        following=get_aya(chapter,last.aya_idx+1).uthmani if f'{chapter}:{last.aya_idx+1}' in positions else ''
        phones=iter(parts(' '.join([*(a.uthmani for a in chapter_ayat),*([following] if following else [])]),chapter))
        for a in chapter_ayat:
            for i in range(1,len(a.uthmani_words)+1):connected[f'{chapter}:{a.aya_idx}:{i}']=next(phones)
    for a in ayat:
        present=None if layout is None else set(locate(f'{a.sura_idx}:{a.aya_idx}'))
        for i,(ar,paused) in enumerate(zip(a.uthmani_words,parts(a.uthmani,a.sura_idx)),1):
            if present is not None and i not in present:continue
            key=f'{a.sura_idx}:{a.aya_idx}:{i}'
            variants=list(dict.fromkeys([connected[key],paused,phone_string(ar,a.sura_idx)]))
            rect=corrections.get(key,boxes[len(words)])
            words.append(dict(ref=f'{a.sura_idx}:{a.aya_idx}',word=i,ar=ar,box=rect,phones=variants,g=positions[f'{a.sura_idx}:{a.aya_idx}']+i-1))
            if layout is not None:
                group=locate(f'{a.sura_idx}:{a.aya_idx}')[i][0].get('group')
                if group and len(group)>1:words[-1]['revealGroup']=[positions[f'{a.sura_idx}:{a.aya_idx}']+n-1 for n in group]
    assert len(words)==len(boxes)
    if number!=1:
        # Diacritic boxes occasionally extend beyond the detected text band.
        # Cover the union, so a hidden word cannot leak ink at the band's edge.
        left=min(conceal[0],min(w['box'][0] for w in words))
        top=min(conceal[1],min(w['box'][1] for w in words))
        right=max(conceal[0]+conceal[2],max(w['box'][0]+w['box'][2] for w in words))
        bottom=max(conceal[1]+conceal[3],max(w['box'][1]+w['box'][3] for w in words))
        conceal=[left,top,right-left,bottom-top]
    context_before=[]
    if ayat[0].aya_idx>1:
        previous=get_aya(ayat[0].sura_idx,ayat[0].aya_idx-1)
        joined=parts(previous.uthmani+' '+ayat[0].uthmani,previous.sura_idx)
        paused=parts(previous.uthmani,previous.sura_idx)
        for i,ar in enumerate(previous.uthmani_words,1):
            context_before.append(dict(ref=f'{previous.sura_idx}:{previous.aya_idx}',word=i,ar=ar,g=positions[f'{previous.sura_idx}:{previous.aya_idx}']+i-1,
                phones=list(dict.fromkeys([joined[i-1],paused[i-1],phone_string(ar,previous.sura_idx)]))))
    fixture=dict(page=number,width=width,height=height,image=f'assets/pages/{number}.jpg',title=title,subtitle=subtitle,
     cues=cues,conceal=conceal,medallions=medallions,words=words,contextBefore=context_before,
     source='quran-transcript 0.6.4; Hafs, connected/ayah-stop/word-start-stop variants',
     geometryStatus='audited' if number in [1,3] else 'generated; visual review pending',
     modelSha256='31755836528da336a6192121cd7bc82cb41752dddb65566fd000b89c8686da6b',modelBytes=72705392,
     tokensBytes=2346,tokensGitBlob='5b0ed53f48819bac097568c596c668aa14d21f50',
     deployedTokensSha256='63e2554dd99b3e7931b5ab36dac696f631a38f254efd8e5f91fa2325998a1e69')
    return fixture

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--page',type=int,choices=range(1,605),default=3)
    parser.add_argument('--all',action='store_true')
    parser.add_argument('--pages',type=int,nargs='+',choices=range(1,605))
    args=parser.parse_args()
    titles=json.JSONDecoder().raw_decode((ROOT/'data/quran-data.js').read_text().split('window.QURAN_AYAT=')[1])[0]
    positions={};verse_index=[];total=0
    for item in titles:
        ref=f"{item['s']}:{item['a']}"
        aya=get_aya(item['s'],item['a']);positions[ref]=total
        verse_index.append(dict(ref=ref,s=item['s'],a=item['a'],start=total,end=total+len(aya.uthmani_words),page=item['page'],name=item['s_en']))
        total+=len(aya.uthmani_words)
    rows={v['ref']:v for v in verse_index};index={};seen=set()
    tokens=(ROOT/'assets/models/recite/tokens-prompter.txt').read_text()
    alphabet=set(''.join(line.rsplit(' ',1)[0] for line in tokens.splitlines() if not line.endswith(' 250')))
    target=ROOT/'data/recite/pages';target.mkdir(parents=True,exist_ok=True)
    numbers=range(1,605) if args.all else (args.pages or [args.page])
    for number in numbers:
        fixture=build_page(number,positions,titles)
        indices=[word['g'] for word in fixture['words']]
        if indices!=list(range(indices[0],indices[-1]+1)):raise ValueError(f'Non-contiguous word geometry on page {number}')
        for word in fixture['words']:
            if not word['phones'] or any(not phone or set(phone)-alphabet-set(' \n') for phone in word['phones']):
                raise ValueError(f"Invalid model phonemes: {word['ref']}:{word['word']}")
            if word['g'] in seen:raise ValueError(f"Duplicated word geometry: {word['ref']}:{word['word']}")
            seen.add(word['g']);row=rows[word['ref']]
            row['firstPage']=min(row.get('firstPage',number),number);row['lastPage']=max(row.get('lastPage',number),number)
        index[str(number)]=dict(start=fixture['words'][0]['g'],end=fixture['words'][-1]['g']+1,refs=list(dict.fromkeys(w['ref'] for w in fixture['words'])),words=len(fixture['words']))
        (target/f'{number}.json').write_text(json.dumps(fixture,ensure_ascii=False,separators=(',',':'))+'\n')
        if number in [1,3,4]:
            (ROOT/f'data/recite/page-{number}.js').write_text(notice+'window.RECITE_PAGES=window.RECITE_PAGES||{};\n'+f'window.RECITE_PAGES[{number}] = '+json.dumps(fixture,ensure_ascii=False,indent=2)+';\n'+('window.RECITE_PAGE=window.RECITE_PAGES[3];\n' if number==3 else ''))
        if number%20==0 or not args.all:print(f'Built page {number}: {len(fixture["words"])} words',flush=True)
    if args.all:
        if seen!=set(range(total)):
            missing=sorted(set(range(total))-seen)
            raise ValueError(f'Missing word geometry: {missing[:20]} ({len(missing)} total). Catalog not written.')
        catalog=dict(version=2,wordCount=total,ayahs=verse_index,pages=index,model={k:fixture[k] for k in ['modelSha256','modelBytes','tokensBytes','tokensGitBlob','deployedTokensSha256']})
        (ROOT/'data/recite/catalog.js').write_text(notice+'window.RECITE_CATALOG='+json.dumps(catalog,ensure_ascii=False,separators=(',',':'))+';\n')
        (ROOT/'data/recite/catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,separators=(',',':'))+'\n')
        print(f'Built {len(index)} pages, {len(verse_index)} ayahs, {total} unique words.',flush=True)
if __name__=='__main__':main()
