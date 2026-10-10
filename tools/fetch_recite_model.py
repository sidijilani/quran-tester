#!/usr/bin/env python3
"""Fetch Prompter's public model copy, verifying Quran Lab's v3.1 SHA-256.
No Hugging Face credentials or gated endpoint are used. The retained NPL 1.2
applies; this feature must stay free and ad-free. Large weights are Git-ignored.
"""
import hashlib,json,re,shutil,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];DEST=ROOT/'assets/models/recite'
MODEL_URL='https://prompter.alketab.app/models/quran_phoneme_zipformer.onnx?v=31755836'
WORKER_URL='https://prompter.alketab.app/assets/decoder.worker-D4jMQMQ1.js'
MODEL_SHA='31755836528da336a6192121cd7bc82cb41752dddb65566fd000b89c8686da6b'
TOKENS_SHA='63e2554dd99b3e7931b5ab36dac696f631a38f254efd8e5f91fa2325998a1e69'

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()

DEST.mkdir(parents=True,exist_ok=True);target=DEST/'zipformer_p_arabic_v3.1.int8.onnx'
if not target.exists() or target.stat().st_size!=72705392 or digest(target)!=MODEL_SHA:
    temp=target.with_suffix('.onnx.part')
    try:
        subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','240',MODEL_URL,'-o',str(temp)],check=True)
        if temp.stat().st_size!=72705392 or digest(temp)!=MODEL_SHA:raise ValueError('Unexpected model size or SHA-256; download rejected.')
        temp.replace(target)
    finally:temp.unlink(missing_ok=True)
# The committed, pinned data table normally avoids any worker download.
table=DEST/'tokens-prompter.txt'
if table.exists() and digest(table)==TOKENS_SHA:
    tokens=table.read_bytes()
else:
    # Extract only the distributed symbol table as data; never execute downloaded JS.
    source=subprocess.run(['curl','--fail','--location','--silent','--show-error','--max-time','30',WORKER_URL],check=True,capture_output=True).stdout.decode('utf-8')
    match=re.search(r'([A-Za-z_$]+)=`([^`]*<blank>)`\.split\(`\.`\)',source)
    if not match:raise ValueError('Public token table not found; update source after review.')
    symbols=match[2].split('.')
    if len(symbols)!=251 or symbols[250]!='<blank>':raise ValueError('Unexpected CTC token table.')
    tokens=('\n'.join(f'{s} {i}' for i,s in enumerate(symbols))+'\n').encode()
    if hashlib.sha256(tokens).hexdigest()!=TOKENS_SHA:raise ValueError('Token table checksum changed; rejected.')
(DEST/'tokens-prompter.txt').write_bytes(tokens)
shutil.copyfile(ROOT/'data/recite/MODEL-LICENSE',DEST/'LICENSE')
(DEST/'provenance.json').write_text(json.dumps(dict(
 model=dict(file=target.name,url=MODEL_URL,bytes=72705392,sha256=MODEL_SHA,
 upstream='https://huggingface.co/Quran-Lab/zipformer_p-arabic-v3',revision='3da514fc833b22c902ee466a7710cf399896f2f0'),
 tokens=dict(file='tokens-prompter.txt',url=WORKER_URL,sha256=TOKENS_SHA,
 note='251 distributed symbols serialized as symbol + space + ID; this is not the original HF tokens.txt byte stream.'),
 license='Quran-Lab No-Profit License 1.2'),indent=2)+'\n')
print(f'Verified {target.name}: 72,705,392 bytes, SHA-256 {MODEL_SHA}')
print('Verified 251-entry deployed token table. License retained. Ready on localhost.')
