#!/usr/bin/env python3
"""Numerically compare browser fbank with Kaldi on streaming and reflected edges.
Requires numpy, kaldi-native-fbank and node (or --node /path/to/node).
"""
import argparse,json,subprocess
from pathlib import Path
import numpy as np
import kaldi_native_fbank as k
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node',default='node');args=parser.parse_args()
root=Path(__file__).resolve().parents[2]
opts=k.FbankOptions();opts.frame_opts.samp_freq=16000;opts.frame_opts.dither=0;opts.frame_opts.snip_edges=False
opts.frame_opts.window_type='povey';opts.mel_opts.num_bins=80;opts.mel_opts.low_freq=20;opts.mel_opts.high_freq=7600
opts.mel_opts.is_librosa=False;opts.mel_opts.use_slaney_mel_scale=False
rng=np.random.default_rng(13);t=np.arange(12345)/16000
signal=(.07*np.sin(2*np.pi*(250*t+700*t*t))+.003*rng.normal(size=len(t))).astype(np.float32)
code="""
const fs=require('fs'),{Fbank}=require('./recite-fbank.js');
const samples=JSON.parse(fs.readFileSync(0,'utf8')),f=new Fbank(),out=[];
for(let i=0;i<samples.length;i+=137)out.push(...f.push(Float32Array.from(samples.slice(i,i+137))));
out.push(...f.push(new Float32Array(0),true));console.log(JSON.stringify(out.map(a=>Array.from(a))));
"""
for name,audio in [('chirp/noise',signal),('silence',np.zeros(3221,dtype=np.float32))]:
    ref=k.OnlineFbank(opts);ref.accept_waveform(16000,audio.tolist());ref.input_finished()
    expected=np.array([ref.get_frame(i) for i in range(ref.num_frames_ready)])
    result=subprocess.run([args.node,'-e',code],input=json.dumps(audio.tolist()),text=True,capture_output=True,cwd=root,check=True)
    actual=np.array(json.loads(result.stdout));assert actual.shape==expected.shape
    error=np.max(np.abs(actual-expected));assert error<.002,error
    print(f'{name}: {len(actual)} frames; maximum log-feature difference {error:.8f}')
