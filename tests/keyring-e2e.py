import os,subprocess,tempfile,pathlib,time,statistics
binary=os.environ.get('BETTERGIT_BINARY',str(pathlib.Path(__file__).resolve().parents[1]/'target/debug/bettergit'))
def run(args,root,**kw):
 try: return subprocess.check_output(args,cwd=root,stderr=subprocess.PIPE,**kw)
 except subprocess.CalledProcessError as error:
  print(error.stderr.decode());raise
with tempfile.TemporaryDirectory(prefix='bettergit-e2e-') as d:
 root=pathlib.Path(d)/'source';root.mkdir()
 run(['git','init','-q'],root)
 run(['git','config','commit.gpgsign','false'],root)
 run(['git','config','user.name','Test'],root);run(['git','config','user.email','test@example.test'],root)
 (root/'.access.yml').write_text('version: 1\norg: test\nrules:\n  - path: .env\n    mode: value\n    allow: [github-team:infra]\n    stub: .env.example\n')
 (root/'.env.example').write_text('TOKEN=mock\n')
 run(['git','add','.access.yml','.env.example'],root);run(['git','commit','-qm','policy and public stub'],root)
 run([binary,'init'],root)
 info=root/'.git/info/attributes'
 info.write_text(info.read_text()+'custom -diff\n')
 run([binary,'init'],root)
 assert 'custom -diff' in info.read_text()
 signer=run([binary,'group-signing-key','github-team:infra'],root).decode().strip()
 policy=(root/'.access.yml').read_text()
 (root/'.access.yml').write_text(policy+f'    signing_key: {signer}\n')
 run([binary,'init'],root)
 (root/'.env').write_text('TOKEN=secret\n');(root/'app').mkdir();(root/'app/.env').write_text('TOKEN=nested\n')
 run(['git','add','.gitattributes','.env','app/.env'],root)
 for name in ['.env','app/.env']:
  blob=run(['git','show',':'+name],root)
  assert b'ENC[v2:' in blob
  fixture=pathlib.Path(d)/'encrypted'
  fixture.write_bytes(blob)
  run([binary,'check','--require-signing-key','--',name,str(fixture)],root)
 run(['git','add','.access.yml'],root)
 run(['git','commit','-qm','encrypted'],root)
 assert not run(['git','status','--porcelain'],root)
 before=run(['git','rev-parse','HEAD:.env'],root)
 run(['git','add','.env'],root)
 assert before==run(['git','rev-parse',':.env'],root)
 clone=pathlib.Path(d)/'clone';run(['git','clone','-q',str(root),str(clone)],root)
 assert b'ENC[v2:' in (clone/'.env').read_bytes()
 run([binary,'init'],clone)
 assert (clone/'.env').read_text()=='TOKEN=mock\n'
 status=run(['git','status','--porcelain'],clone)
 assert not status, repr(status)
 clone_policy=(clone/'.access.yml').read_text()
 (clone/'.access.yml').write_text(clone_policy.replace('    stub: .env.example\n',''))
 for name in ['.env','app/.env']:
  (clone/name).write_bytes(run(['git','show',':'+name],clone))
 run([binary,'init'],clone)
 assert b'ENC[v2:' in (clone/'.env').read_bytes()
 assert not run(['git','status','--porcelain','--','.env','app/.env'],clone)
 (clone/'.access.yml').write_text(clone_policy)
 run([binary,'init'],clone)
 run(['git','checkout-index','-f','--all'],clone)
 assert (clone/'.env').read_text()=='TOKEN=mock\n', repr((clone/'.env').read_text())
 run(['git','add','.env'],clone)
 assert run(['git','rev-parse',':.env'],clone)==before
 (clone/'.env').write_text('TOKEN=unauthorized-change\n')
 assert subprocess.run(['git','add','.env'],cwd=clone,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
 # The same local identity still needs a properly contextualized group grant.
 origin='git@github.com:test/repo.git'
 run(['git','remote','add','origin',origin],root)
 run(['git','remote','set-url','origin',origin],clone)
 recipient=run([binary,'public-key'],root).decode().strip()
 fingerprint=run([binary,'group-public-key','github-team:infra'],root).decode().strip()
 envelope=pathlib.Path(d)/'good.age'
 run([binary,'grant','github-team:infra',recipient,str(envelope)],root)
 unpinned=subprocess.run([binary,'import','github-team:infra',str(envelope)],cwd=clone,capture_output=True)
 assert unpinned.returncode!=0 and b'run pin-group' in unpinned.stderr
 run([binary,'pin-group','github-team:infra',fingerprint],clone)
 run([binary,'import','github-team:infra',str(envelope)],clone)
 (clone/'.env').write_text('TOKEN=mock\n')
 run([binary,'init'],clone)
 assert (clone/'.env').read_text()=='TOKEN=mock\n'
 run(['git','checkout-index','-f','--','.env'],clone)
 assert (clone/'.env').read_text()=='TOKEN=secret\n'
 # A key holder can intentionally change a value to the public stub value.
 (root/'.env').write_text('TOKEN=mock\n')
 run(['git','add','.env'],root)
 assert run(['git','rev-parse',':.env'],root)!=before
 attacker=pathlib.Path(d)/'other';attacker.mkdir()
 run(['git','init','-q'],attacker);run(['git','remote','add','origin',origin],attacker)
 (attacker/'.access.yml').write_text(policy)
 run([binary,'init'],attacker)
 bad=pathlib.Path(d)/'bad.age'
 run([binary,'grant','github-team:infra',recipient,str(bad)],attacker)
 assert subprocess.run([binary,'import','github-team:infra',str(bad)],cwd=clone,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
 assert run([binary,'group-public-key','github-team:infra'],clone).decode().strip()==fingerprint
 print('PASS: real Git + isolated Secret Service, nested policy paths, stable index, fresh clone stubs, unauthorized edit refusal, pinned import substitution refusal')
