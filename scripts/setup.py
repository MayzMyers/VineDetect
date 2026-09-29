#!/usr/bin/env python3
"""Create local credentials. Never overwrite an existing environment file."""
from pathlib import Path
import getpass, secrets, subprocess
ROOT=Path(__file__).resolve().parents[1]
def main():
    target=ROOT/'.env'
    if target.exists(): raise SystemExit('.env already exists; keep or edit it explicitly.')
    password=getpass.getpass('New admin password (at least 12 characters): ')
    if len(password)<12: raise SystemExit('Use at least 12 characters.')
    if password!=getpass.getpass('Repeat password: '): raise SystemExit('Passwords do not match.')
    subprocess.run(['docker','compose','build','api'],cwd=ROOT,check=True,env=__import__('os').environ | {'ADMIN_PASSWORD_HASH':'setup','JWT_SECRET':'setup','INTERNAL_API_KEY':'setup','POSTGRES_PASSWORD':'setup'})
    hashed=subprocess.check_output(['docker','compose','run','--rm','--no-deps','-T','api','python','-c','import sys; from pwdlib import PasswordHash; print(PasswordHash.recommended().hash(sys.stdin.read()))'],input=password,text=True,cwd=ROOT,env=__import__('os').environ | {'ADMIN_PASSWORD_HASH':'setup','JWT_SECRET':'setup','INTERNAL_API_KEY':'setup','POSTGRES_PASSWORD':'setup'}).strip()
    values={'POSTGRES_PASSWORD':secrets.token_hex(24),'JWT_SECRET':secrets.token_hex(32),'INTERNAL_API_KEY':secrets.token_hex(32),'ADMIN_PASSWORD_HASH':"'"+hashed+"'",'ANNOTATOR_PASSWORD_HASH':"'"+hashed+"'",'ML_SERVICE_PASSWORD_HASH':"'"+hashed+"'",'HOST_UID':str(__import__('os').getuid()),'HOST_GID':str(__import__('os').getgid())}
    lines=[line.split('=',1)[0]+'='+values[line.split('=',1)[0]] if line.split('=',1)[0] in values else line for line in (ROOT/'.env.example').read_text().splitlines()]
    with target.open('x') as f:f.write('\n'.join(lines)+'\n')
    target.chmod(0o600)
    (ROOT/'exports').mkdir(exist_ok=True)
    print('Created .env. Keep this file private.')
if __name__=='__main__':main()
