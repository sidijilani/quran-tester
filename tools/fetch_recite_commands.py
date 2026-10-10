#!/usr/bin/env python3
"""Download static voice-command weights/runtime for the client-only app.
Audio recordings and timings are fetched directly by the browser at runtime.
"""
import hashlib,io,json,subprocess,tarfile,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def download(url,path=None):
    cmd=['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','240',url]
    if path is None:return subprocess.run(cmd,check=True,capture_output=True).stdout
    temp=path.with_name(path.name+'.part')
    try:
        subprocess.run(cmd+['-o',str(temp)],check=True);temp.replace(path)
    finally:temp.unlink(missing_ok=True)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

vendor=ROOT/'assets/vendor/vosk-browser-0.0.8';vendor.mkdir(parents=True,exist_ok=True)
weights=ROOT/'assets/models/commands';weights.mkdir(parents=True,exist_ok=True)
urls={
    'vosk.js':'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js',
    'LICENSE':'https://raw.githubusercontent.com/ccoreilly/vosk-browser/master/COPYING',
    'NOTICE':'https://raw.githubusercontent.com/ccoreilly/vosk-browser/master/NOTICE'}
for name,url in urls.items():
    if not (vendor/name).exists():download(url,vendor/name)
archive=weights/'vosk-model-small-en-us-0.15.tar.gz'
url='https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip'
if not archive.exists():
    # Convert upstream ZIP to Vosk-browser's documented tar.gz structure.
    with zipfile.ZipFile(io.BytesIO(download(url))) as original, tarfile.open(archive,'w:gz') as packed:
        for entry in original.infolist():
            if entry.is_dir():continue
            parts=Path(entry.filename).parts
            if '..' in parts or len(parts)<2:raise ValueError('Unexpected archive path')
            data=original.read(entry)
            info=tarfile.TarInfo('model/'+'/'.join(parts[1:]));info.size=len(data);info.mode=0o644
            packed.addfile(info,io.BytesIO(data))
(weights/'LICENSE').write_bytes((vendor/'LICENSE').read_bytes())
(weights/'provenance.json').write_text(json.dumps({'source':url,'license':'Apache-2.0',
    'archive':archive.name,'bytes':archive.stat().st_size,'sha256':digest(archive),
    'runtime':{'source':urls['vosk.js'],'sha256':digest(vendor/'vosk.js')}},indent=2)+'\n')
print('Local command model and browser runtime ready.',flush=True)
