#!/usr/bin/env python3
"""Download the small Alafasy page-3 reference set for local ASR integration QA.
Test recordings stay under Git-ignored tmp/; they are not app assets.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
folder=ROOT/'tmp/recite/reference-page3';folder.mkdir(parents=True,exist_ok=True)
def fetch(ayah):
    name=f'002{ayah:03}.mp3';target=folder/name
    if not target.exists():
        subprocess.run(['curl','--fail','--location','--silent','--show-error','--max-time','60',
                        'https://everyayah.com/data/Alafasy_128kbps/'+name,'-o',str(target)],check=True)
    return name
with ThreadPoolExecutor(max_workers=4) as pool:
    for name in pool.map(fetch,range(6,17)):print(name)
