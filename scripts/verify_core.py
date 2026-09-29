#!/usr/bin/env python3
"""Verify every frozen runtime file before starting Core."""
import argparse, hashlib, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def verify(runtime):
    expected=ROOT/'core/runtime/runtime-manifest.json'
    if digest(runtime/'runtime-manifest.json')!=digest(expected): raise ValueError('Runtime manifest differs from the published Core')
    manifest=json.loads(expected.read_text())
    for name,sha in manifest['files_sha256'].items():
        p=(runtime/name).resolve()
        if not p.is_relative_to(runtime.resolve()): raise ValueError('External runtime link: '+name)
        if not p.is_file() or digest(p)!=sha: raise ValueError('Missing/changed runtime file: '+name)
    overlay=ROOT/'core/engineering'
    for name,sha in json.loads((overlay/'manifest.json').read_text())['files_sha256'].items():
        if digest(overlay/name)!=sha:raise ValueError('Changed engineering file: '+name)
    return len(manifest['files_sha256'])
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('runtime',type=Path);args=parser.parse_args()
    print('Verified runtime files:',verify(args.runtime))
