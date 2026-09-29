#!/usr/bin/env python3
"""Restore a separately supplied dump into an EMPTY Compose database."""
import argparse, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def compose(*args,**kw):return subprocess.run(['docker','compose',*args],cwd=ROOT,check=True,**kw)
def sql(statement):
    return compose('exec','-T','postgres','sh','-ec','psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA',input=statement,text=True,capture_output=True).stdout.strip()
def main():
    p=argparse.ArgumentParser();p.add_argument('dump',type=Path);a=p.parse_args()
    if not a.dump.is_file():raise SystemExit('Dump file not found')
    compose('up','-d','--wait','postgres')
    count=sql("SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');")
    if count!='0':raise SystemExit('Refusing to restore over a nonempty database.')
    with a.dump.open('rb') as f:
        compose('exec','-T','postgres','sh','-ec','pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"',stdin=f)
    sql("SELECT format('ALTER DATABASE %I SET search_path TO svoe_vino, public', current_database()) " + chr(92) + "gexec")
    print('Database restored. No existing data was replaced.')
if __name__=='__main__':main()
