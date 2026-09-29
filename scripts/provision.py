#!/usr/bin/env python3
"""Install separately supplied artifacts from a LOCAL JSON manifest (never downloads)."""
import argparse, hashlib, json, shutil, subprocess
from pathlib import Path
from verify_core import verify
ROOT=Path(__file__).resolve().parents[1]
IMAGE='sha256:222c7906258dc4f034f2b90db3c647713a9f1a0e4f2df569f8f40d302bb7bca5'
ARCHIVE_SHA='019c314216bda6f936f2a4fab09bad70603a2b48917181bd8230af116967c1dc'
def main():
 p=argparse.ArgumentParser();p.add_argument('manifest',type=Path);p.add_argument('--link',action='store_true',help='Use local directory links instead of copying large datasets');a=p.parse_args()
 info=json.loads(a.manifest.read_text())
 def source(key):
  path=Path(info[key]);return (a.manifest.resolve().parent/path).resolve() if not path.is_absolute() else path.resolve()
 runtime=source('runtime');print('Verifying Core:',verify(runtime),flush=True)
 for key,rel in [('runtime','artifacts/core-runtime'),('asset_store','asset-store'),('annotation_gallery','artifacts/annotation-gallery')]:
  src=source(key);dst=ROOT/rel
  if not src.is_dir():raise SystemExit('Missing directory: '+str(src))
  if dst.exists():raise SystemExit('Destination already exists; refusing to overwrite: '+str(dst))
  dst.parent.mkdir(parents=True,exist_ok=True)
  if a.link:dst.symlink_to(src,target_is_directory=True)
  else:shutil.copytree(src,dst,symlinks=False)
 supplemental=source('supplemental')
 for src in supplemental.rglob('*'):
  if not src.is_file():continue
  rel=src.relative_to(supplemental)
  # The public mock console retains synthetic examples, unrelated to actual inference.
  if str(rel).startswith('vinedetect_web/public/mock/'):continue
  dst=ROOT/('artifacts/ocr/'+src.name) if src.suffix=='.traineddata' else ROOT/rel
  if dst.exists():raise SystemExit('Refusing to overwrite: '+str(dst))
  dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
 dst=ROOT/'artifacts/database.dump'
 if dst.exists():raise SystemExit('Database dump destination exists')
 shutil.copyfile(source('database_dump'),dst)
 if subprocess.run(['docker','image','inspect',IMAGE],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
  archive=source('docker_archive')
  with archive.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
  if actual!=ARCHIVE_SHA:raise SystemExit('Frozen Docker archive checksum mismatch')
  subprocess.run(['docker','load','-i',str(archive)],check=True)
 subprocess.run(['docker','image','inspect',IMAGE],check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['docker','tag',IMAGE,'vinedetect-core:c4'],check=True)
 print('Artifacts ready. Run setup.py, then import_database.py artifacts/database.dump.')
if __name__=='__main__':main()
