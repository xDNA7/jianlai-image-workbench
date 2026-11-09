#!/usr/bin/env python3
"""Real PostgreSQL/HTTP ledger tests; local providers only, no production config."""
import email.parser, email.policy
import base64, concurrent.futures, io, hashlib, http.server, json, os, pathlib, re, secrets, shutil, socket, struct, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request, zlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
BINARY=pathlib.Path(os.environ.get('JIANLAI_TEST_BINARY','/tmp/jianlai-pg-target/debug/image-workbench-server'))
DB='jianlai_test_business_'+secrets.token_hex(6)
ROLE=DB
PASSWORD=secrets.token_hex(16)
WORK=pathlib.Path(tempfile.mkdtemp(prefix='jianlai-pg-business-',dir='/tmp'))
PROCESSES=[]
LOGS=[]
FAILED=False
VIDEO_BYTES=b"\x00\x00\x00\x20ftypisom"+b"\0"*20

def psql(sql, database=DB):
    return subprocess.check_output(['runuser','-u','postgres','--','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d',database,'-c',sql],text=True,cwd='/tmp').strip()
def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
def png(color=128):return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+bytes([color,64,32])*8)*8))+chunk(b'IEND',b'')
PNG=png()
def gif():
    from PIL import Image
    out=io.BytesIO()
    frames=[Image.new('RGB',(8,8),(i*20,40,80)) for i in range(12)]
    frames[0].save(out,format='GIF',save_all=True,append_images=frames[1:],duration=250,loop=0,optimize=False)
    return out.getvalue()
GIF=gif()
class Provider(http.server.BaseHTTPRequestHandler):
    active=0
    image_requests={}
    edit_requests=[]
    video_polls=[]
    video_requests=[]
    peak=0
    guard=threading.Lock()
    def log_message(self,*args):pass
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        if self.path.endswith('/images/edits'):
            message=email.parser.BytesParser(policy=email.policy.default).parsebytes(
                b'Content-Type: '+self.headers['Content-Type'].encode()+b'\r\nMIME-Version: 1.0\r\n\r\n'+body)
            assert message.is_multipart(),self.headers['Content-Type']
            fields={};images=[];mask=None
            for part in message.iter_parts():
                name=part.get_param('name',header='content-disposition');data=part.get_payload(decode=True)
                if name=='image[]':images.append(data)
                elif name=='mask':mask=data
                else:fields[name]=data.decode()
            assert images,fields
            with Provider.guard:
                Provider.edit_requests.append({'fields':fields,'images':images,'mask':mask})
                sequence=len(Provider.edit_requests)
            animated='GIF_EDIT_TEST' in fields.get('prompt','')
            if animated:
                assert fields['model']=='gpt-image-2.6' and 'output_format' not in fields,fields
            self.send_response(200)
            result={'data':[{'b64_json':base64.b64encode(GIF if animated else png(160+sequence)).decode()}]}
        elif self.path.endswith('/images/generations'):
            value=json.loads(body)
            time.sleep(.7)
            if 'FAIL_TEST' in value.get('prompt',''): self.send_response(400);result={'error':{'message':'invalid prompt'}}
            else:
                prompt=value.get('prompt','')
                with Provider.guard:
                    calls=Provider.image_requests.setdefault(prompt,[]);calls.append(value['n']);attempt=len(calls)
                scenario=next((name for name in ('SHORT_BATCH_TEST','DUPLICATE_BATCH_TEST','FAIL_FILL_TEST','RATE_FILL_TEST') if name in prompt),None)
                status=400 if scenario=='FAIL_FILL_TEST' and attempt>1 else 429 if scenario=='RATE_FILL_TEST' and attempt>1 else 200
                self.send_response(status)
                if status!=200:result={'error':{'message':'content_policy violation' if status==400 else 'rate limited'}}
                else:
                    colors=[128+i for i in range(value['n'])] if not scenario else [128] if attempt==1 or scenario=='DUPLICATE_BATCH_TEST' else [128+attempt+i for i in range(value['n'])]
                    if 'GIF_TEST' in prompt:
                        assert value['model']=='gpt-image-2.6',value['model']
                        assert 'output_format' not in value,value
                        assert value['n']==1,value['n']
                    result={'data':[{'b64_json':base64.b64encode(GIF if 'GIF_TEST' in prompt and 'STATIC_GIF_TEST' not in prompt else png(c)).decode()} for c in colors]}
        elif self.path.endswith('/v2/video_generation'):
            value=json.loads(body)
            with Provider.guard:Provider.video_requests.append(value)
            self.send_response(200);result={'task_id':'mock-video'}
        elif self.path.endswith('/chat/completions'):
            value=json.loads(body)
            if value.get('stream') is True:
                messages=value['messages'];system='\n'.join(item['content'] for item in messages if item['role']=='system')
                video='视频分镜创作助手' in system
                if video:
                    duration=int(re.search(r'本次总时长固定为(\d+)秒',system)[1])
                    plan={'duration':duration,'ratio':'16:9','resolution':'768P','shots':[
                        {'duration':duration//2,'scene':'雨后城市的暖色灯光','camera':'低机位缓慢推进'},
                        {'duration':duration-duration//2,'scene':'窗边的行人和咖啡店','camera':'缓慢抬镜，保持主体连贯'}]}
                else:
                    plan={'prompt':'A rainy city','size':'1024x1024','quality':'medium','count':1,'useReference':False}
                if 'INVALID_STORYBOARD_TEST' in messages[-1]['content']:
                    plan={'duration':10,'shots':[{'duration':0,'scene':'','camera':''}]}
                content='已整理为可编辑方案。\n<<<PLAN>>>\n'+json.dumps(plan,ensure_ascii=False)
                body='data: '+json.dumps({'choices':[{'delta':{'content':content}}]},ensure_ascii=False)+'\n\ndata: [DONE]\n\n'
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers();self.wfile.write(body.encode());return
            self.send_response(200); result={'choices':[{'message':{'content':json.dumps({'title':'测试模板','category':'poster','prompt':'A test poster','tags':[],'parameters':[],'parameterDefaults':{}})}}]}
        else:self.send_response(404);result={}
        self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode())
    def private_video(self, head=False):
        if self.path.startswith('/local-test/results/videos/'):
            self.send_response(403);self.end_headers();return True
        if not self.path.startswith('/private-video/mock.mp4?signature=mock'):return False
        start,end=0,len(VIDEO_BYTES)-1
        if self.headers.get('Range'):
            matched=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers['Range'])
            if not matched:self.send_response(416);self.end_headers();return True
            start=int(matched[1]);end=int(matched[2]) if matched[2] else end
            if start>=len(VIDEO_BYTES) or end<start:
                self.send_response(416);self.send_header('Content-Range',f'bytes */{len(VIDEO_BYTES)}');self.end_headers();return True
            end=min(end,len(VIDEO_BYTES)-1)
        self.send_response(206 if self.headers.get('Range') else 200)
        self.send_header('Content-Type','video/mp4');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
        if self.headers.get('Range'):self.send_header('Content-Range',f'bytes {start}-{end}/{len(VIDEO_BYTES)}')
        self.end_headers()
        if not head:self.wfile.write(VIDEO_BYTES[start:end+1])
        return True
    def stored_image(self, head=False):
        if not self.path.startswith('/local-test/'):return False
        key=self.path.split('?',1)[0].lstrip('/')
        target='oss://mock-bucket/'+key
        path=WORK/('object-'+hashlib.sha256(target.encode()).hexdigest())
        data=path.read_bytes() if path.is_file() else PNG
        mime='image/gif' if data.startswith(b'GIF8') else 'image/webp' if data[8:12]==b'WEBP' else 'image/png'
        self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.end_headers()
        if not head:self.wfile.write(data)
        return True
    def do_HEAD(self):
        if self.path.startswith('/private-video/'):
            self.send_response(403);self.end_headers();return
        if self.private_video(head=True):return
        if self.stored_image(head=True):return
        self.send_response(404);self.end_headers()
    def do_GET(self):
        if self.private_video():return
        if self.path.startswith('/local-test/expired-'):
            self.send_response(410);self.end_headers();return
        if self.stored_image():return
        if self.path=='/mock.mp4':
            self.send_response(200);self.send_header('Content-Type','video/mp4');self.end_headers();self.wfile.write(b'\x00\x00\x00\x20ftypisom'+b'\0'*20);return
        with Provider.guard:
            Provider.active+=1;Provider.peak=max(Provider.peak,Provider.active)
            Provider.video_polls.append(time.monotonic())
        time.sleep(.15)
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'status':'succeeded','content':{'url':f'http://127.0.0.1:{self.server.server_port}/mock.mp4'}}).encode())
        with Provider.guard:Provider.active-=1
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None
OPENER=urllib.request.build_opener(NoRedirect)
def req(port,path,body=None,cookie='',csrf=None,method=None,extra_headers=None):
    headers={'Origin':f'http://127.0.0.1:{port}','Cookie':cookie}
    if body is not None:headers['Content-Type']='application/json'
    if csrf:headers['X-CSRF-Token']=csrf
    if extra_headers:headers.update(extra_headers)
    r=urllib.request.Request(f'http://127.0.0.1:{port}/jianlai'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:res=OPENER.open(r,timeout=30)
    except urllib.error.HTTPError as e:res=e
    data=res.read()
    return res.status, json.loads(data) if data and res.headers.get('Content-Type','').startswith('application/json') else data, res.headers

def start(index,maintenance=False,mode="postgres"):
    data=WORK/f'data{index}';data.mkdir(exist_ok=True)
    port=free_port();config=WORK/f'config{index}.env'
    salt='temporary-local-test-salt';digest=hashlib.scrypt(b'test-password',salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=64*1024*1024).hex()
    config.write_text(f'''DATABASE_MODE=postgres
MAINTENANCE_MODE={int(maintenance)}
DATABASE_URL=postgresql://{ROLE}:{PASSWORD}@127.0.0.1/{DB}
PORT={port}
IMAGE_API_KEY=local-test-only
IMAGE_API_BASE=http://127.0.0.1:{PROVIDER.server_port}/v1
IMAGE_MODELS=gpt-image-2
VIDEO_API_KEY=local-test-only
VIDEO_API_BASE=http://127.0.0.1:{PROVIDER.server_port}
VISION_API_KEY=local-test-only
VISION_API_BASE=http://127.0.0.1:{PROVIDER.server_port}/v1
VISION_MODEL=local-test
CHAT_API_KEY=local-test-only
CHAT_API_BASE=http://127.0.0.1:{PROVIDER.server_port}/v1
CHAT_MODEL=local-test
OSS_PUBLIC_BUCKET=mock-bucket
OSS_PUBLIC_BASE=http://127.0.0.1:{PROVIDER.server_port}
OSS_PUBLIC_PREFIX=local-test
OSSUTIL_BIN={WORK}/oss-mock
ADMIN_PATH=local_test_admin_path_123456
ADMIN_USERNAME=test-admin
ADMIN_PASSWORD_SALT={salt}
ADMIN_PASSWORD_HASH={digest}
CLEANUP_INTERVAL_MS=3600000
''')
    if mode=='sqlite':
        # Exercise the actual default: no DATABASE_MODE and no DATABASE_URL.
        config.write_text('\n'.join(line for line in config.read_text().splitlines() if not line.startswith(('DATABASE_MODE=','DATABASE_URL='))))
    log=open(WORK/f'server{index}.log','ab');LOGS.append(log)
    env={**os.environ,'DATA_DIR':str(data),'APP_ROOT':str(ROOT/'app'),'CONFIG_FILE':str(config),'VISION_CONFIG_FILE':str(WORK/'absent'),'IMAGE_FALLBACK_CONFIG_FILE':''}
    env.pop('PORT',None)
    p=subprocess.Popen([str(BINARY)],env=env,stdout=log,stderr=log);PROCESSES.append(p)
    for _ in range(100):
        try:
            if req(port,'/api/health')[0]==200:
                return port,p
        except (OSError,urllib.error.URLError):pass
        if p.poll() is not None:raise AssertionError(f'server startup failed ({p.returncode})')
        time.sleep(.1)
    raise AssertionError('server startup timeout')
def bootstrap(port):
    code,data,h=req(port,'/api/bootstrap');assert code==200,(code,data)
    return data,h['Set-Cookie'].split(';')[0]
def payload(key=None,prompt='test image'):
    return dict(mode='reference',prompt=prompt,text='',size='1024x1024',quality='auto',compare=False,references=[],requestKey=key or secrets.token_hex(16))
def complete(port,job,cookie):
    for _ in range(200):
        code,data,_=req(port,'/api/jobs/'+job,cookie=cookie)
        assert code==200,(code,data)
        if data['status'] in ('done','failed'):return data
        time.sleep(.1)
    raise AssertionError('generation did not finish')
def check(name):print(name+' passed',flush=True)
try:
    assert BINARY.is_file(),BINARY
    psql(f'CREATE ROLE {ROLE} LOGIN PASSWORD \'{PASSWORD}\'',database='postgres')
    subprocess.check_call(['runuser','-u','postgres','--','createdb','-O',ROLE,DB],cwd='/tmp')
    PROVIDER=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
    threading.Thread(target=PROVIDER.serve_forever,daemon=True).start()
    (WORK/'oss-mock').write_text('#!/usr/bin/env python3\nimport hashlib,json,pathlib,sys,time\nw=pathlib.Path('+repr(str(WORK))+')\nif (w/"slow-oss").exists():time.sleep(.5)\nwith (w/"oss-commands.jsonl").open("a") as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nif "cp" in sys.argv:\n i=sys.argv.index("cp");p=pathlib.Path(sys.argv[i+1])\n if p.is_file():\n  (w/("object-"+hashlib.sha256(sys.argv[i+2].encode()).hexdigest())).write_bytes(p.read_bytes())\n  with (w/"oss-copies.jsonl").open("a") as f:f.write(json.dumps({"target":sys.argv[i+2],"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size})+"\\n")\nif "presign" in sys.argv:print('+repr(f'http://127.0.0.1:{PROVIDER.server_port}/private-video/mock.mp4?signature=mock')+')\n');(WORK/'oss-mock').chmod(0o700)
    port,server=start(0);port2=port
    env={**os.environ,'JIANLAI_TEST_DATABASE_URL':f'postgresql://{ROLE}:{PASSWORD}@127.0.0.1/{DB}','CARGO_TARGET_DIR':os.environ.get('CARGO_TARGET_DIR','/tmp/jianlai-pg-target')}
    subprocess.check_call(['cargo','test','--locked','--quiet','--manifest-path',str(ROOT/'server-rust/Cargo.toml'),'postgres_statement_catalog','--','--ignored'],env=env)
    check('all repository statements prepare against real PostgreSQL')
    one,c1=bootstrap(port);two,c2=bootstrap(port2)
    unchanged=psql('SELECT balance FROM shared_ledger')
    assert req(port,'/api/videos',cookie=c1)[0]==200
    assert req(port,'/api/videos')[0]==401
    boot=req(port,'/api/bootstrap',cookie=c1)[1]
    assert boot['activeVideo'] is None and boot['videoEnabled'] and not boot['videoAccessRequired']
    assert req(port,'/api/history',cookie=c1)[0]==200
    for path,body in [('/api/videos',{}),('/api/chat',{'mode':'video','messages':[]})]:
        assert req(port,path,body,c1,extra_headers={'Origin':'https://foreign.invalid'})[0]==403
    assert psql('SELECT balance FROM shared_ledger')==unchanged
    check('public video uses ordinary account identity, preserves Origin checks and does not change balance')
    assert not list(WORK.glob('data*/state.sqlite'))
    check('postgres starts without SQLite and bootstrap persists account')
    def chat_events(payload):
        code,body,headers=req(port,'/api/chat',payload,c1)
        assert code==200 and headers.get('Content-Type','').startswith('text/event-stream'),(code,body)
        result=[]
        for block in body.decode().split('\n\n'):
            event=next((line[7:] for line in block.splitlines() if line.startswith('event: ')),None)
            data=next((line[6:] for line in block.splitlines() if line.startswith('data: ')),None)
            if event and data:result.append((event,json.loads(data)))
        return result
    untouched=psql('SELECT (SELECT count(*) FROM jobs)::text || \':\' || (SELECT count(*) FROM video_jobs)::text || \':\' || (SELECT balance FROM shared_ledger WHERE id=1)::text')
    for content,seconds,limited in [('做一条雨后城市短片',15,False),('做20秒的城市短片',15,True),('做三十秒的城市短片',15,True),('做1分钟的城市短片',15,True),('做8秒的城市短片',8,False),('不要20秒，改为10秒',10,False),('从20秒缩短到8秒',8,False)]:
        events=chat_events({'mode':'video','messages':[{'role':'user','content':content}]})
        plans=[data for name,data in events if name=='storyboard'];assert len(plans)==1,events
        plan=plans[0];assert plan['duration']==seconds and sum(shot['duration'] for shot in plan['shots'])==seconds,plan
        assert not any(name=='plan' or name=='error' for name,_ in events),events
        if limited:assert '最多一次性生成 15 秒' in plan['notice'],plan
    events=chat_events({'mode':'video','video':{'duration':12},'messages':[{'role':'user','content':'光线再温暖一点'}]})
    assert next(data for name,data in events if name=='storyboard')['duration']==12
    events=chat_events({'mode':'video','messages':[{'role':'user','content':'INVALID_STORYBOARD_TEST'}]})
    assert any(name=='error' for name,_ in events) and not any(name=='storyboard' for name,_ in events),events
    events=chat_events({'messages':[{'role':'user','content':'生成雨后城市图片'}]})
    assert any(name=='plan' for name,_ in events) and not any(name=='storyboard' for name,_ in events),events
    assert req(port,'/api/chat',{'mode':'unexpected','messages':[{'role':'user','content':'bad mode'}]},c1)[0]==400
    assert psql('SELECT (SELECT count(*) FROM jobs)::text || \':\' || (SELECT count(*) FROM video_jobs)::text || \':\' || (SELECT balance FROM shared_ledger WHERE id=1)::text')==untouched
    check('video storyboard defaults to ten seconds, clamps explicit long duration, retains editing context and never creates/bills tasks; image chat contract unchanged')
    sql_null_job='d'*32;json_null_job='c'*32
    psql(f"INSERT INTO jobs(id,account,request_key,status,params,result,created) VALUES('{sql_null_job}','{one['accountId']}','legacy-sql-null-00001','done',NULL,NULL,0),('{json_null_job}','{one['accountId']}','legacy-json-null-0001','done','null'::jsonb,'null'::jsonb,0)")
    assert req(port,'/api/jobs/'+sql_null_job,cookie=c1)[0]==200
    assert req(port,'/api/jobs/'+json_null_job,cookie=c1)[0]==200
    assert psql(f"SELECT params IS NULL AND result IS NULL FROM jobs WHERE id='{sql_null_job}'")=='t'
    assert psql(f"SELECT params='null'::jsonb AND result='null'::jsonb FROM jobs WHERE id='{json_null_job}'")=='t'
    check('legacy SQL NULL and JSON literal null remain distinct through reads')

    p=payload();code,j,_=req(port,'/api/generate',p,c1);assert code==202,(code,j)
    assert j['requestKey']==p['requestKey'],j
    request_lookup='/api/jobs/by-request?requestKey='+p['requestKey']
    recovered=req(port,request_lookup,cookie=c1);assert recovered[0]==200 and recovered[1]['id']==j['id'],recovered
    assert req(port,request_lookup,cookie=c2)[0]==404
    assert req(port,request_lookup)[0]==401
    assert req(port,'/api/jobs/by-request?requestKey=bad',cookie=c1)[0]==400
    assert req(port,'/api/jobs/by-request?requestKey=absent-original-key-00001',cookie=c1)[0]==404
    check('read-only original-key recovery returns only the owning account job without generation or charging')
    dup=req(port2,'/api/generate',p,c1);assert dup[0]==200 and dup[1]['id']==j['id'],dup
    conflict=req(port2,'/api/generate',{**p,'prompt':'different'},c1);assert conflict[0]==409,conflict
    assert req(port,'/api/generate',payload(),c1)[0]==409
    assert req(port,'/api/jobs/'+j['id'],cookie=c2)[0]==404
    done=complete(port,j['id'],c1);assert done['status']=='done' and done['charged']==.3,done
    assert int(psql('SELECT balance FROM shared_ledger'))==49970
    assert int(psql('SELECT COUNT(*) FROM stored_images'))==1
    check('generate + cross-request requestKey idempotency/fingerprint/account isolation + exact billing')
    # Starting another data directory against a running job must fail before
    # migrations or recovery can mutate the first process's reservations.
    pslow=payload(prompt='single process lease test')
    (WORK/'slow-oss').touch()
    code,slow,_=req(port,'/api/generate',pslow,c1);assert code==202,(code,slow)
    before=psql(f"SELECT status||'|'||reserved||'|'||charged FROM jobs WHERE id='{slow['id']}'")
    config=WORK/'config0.env';second_data=WORK/'rejected-second';second_data.mkdir()
    second_env={**os.environ,'DATA_DIR':str(second_data),'APP_ROOT':str(ROOT/'app'),'CONFIG_FILE':str(config),'VISION_CONFIG_FILE':str(WORK/'absent'),'IMAGE_FALLBACK_CONFIG_FILE':''}
    second=subprocess.run([str(BINARY)],env=second_env,capture_output=True,timeout=12)
    assert second.returncode!=0,second.stdout
    # Original keeps processing, and a rejected process cannot prematurely
    # fail/refund it. The only allowed change is its normal completion.
    row=psql(f"SELECT status||'|'||reserved||'|'||charged FROM jobs WHERE id='{slow['id']}'")
    assert row in ('running|30|0','done|0|30'),row
    assert complete(port,slow['id'],c1)['charged']==.3
    (WORK/'slow-oss').unlink()
    psql('UPDATE shared_ledger SET balance=49970')
    check('second primary refuses startup during running work; first bills normally')

    psql(f"UPDATE stored_images SET hidden=TRUE WHERE job='{slow['id']}'")
    history=req(port,'/api/history',cookie=c1);assert history[0]==200 and history[1]['total']==1,history
    psql(f"INSERT INTO stored_images(job,idx,account,file,mime,created,object_url) VALUES('{sql_null_job}',0,'{one['accountId']}','legacy-null','image/png',{int(time.time()*1000)},'http://127.0.0.1:{PROVIDER.server_port}/local-test/legacy.png')")
    assert req(port,'/api/history',cookie=c1)[0]==200
    assert psql(f"SELECT params IS NULL AND result IS NULL FROM jobs WHERE id='{sql_null_job}'")=='t'
    image=f"/api/jobs/{j['id']}/images/0"
    code,original,headers=req(port,image,cookie=c1)
    assert code==200 and original==PNG,(code,headers)
    assert headers['Content-Type']=='image/png' and headers['Cache-Control']=='private, no-store'
    head=req(port,image,cookie=c1,method='HEAD')
    assert head[0]==200 and int(head[2]['Content-Length'])==len(original) and head[1]==b''
    assert req(port,image)[0]==401
    for method in ('GET','HEAD'):
        assert req(port,image,cookie=c2,method=method)[0]==404
    psql(f"UPDATE stored_images SET deleted=TRUE WHERE job='{j['id']}'")
    for method in ('GET','HEAD'):
        assert req(port,image,cookie=c1,method=method)[0]==404
    psql(f"UPDATE stored_images SET deleted=FALSE WHERE job='{j['id']}'")
    assert req(port,image,{},c1,method='DELETE')[0]==200
    for method in ('GET','HEAD'):
        assert req(port,image,cookie=c1,method=method)[0]==404
    day=86400000
    for age in (8,13,14,15):
        created=int(time.time()*1000)-age*day
        psql(f"UPDATE stored_images SET hidden=FALSE,created={created} WHERE job='{j['id']}'; UPDATE jobs SET created={created} WHERE id='{j['id']}'")
        visible=age<14
        for method in ('GET','HEAD'):
            response=req(port,image,cookie=c1,method=method)
            assert response[0]==(200 if visible else 404),(age,method,response[0])
            if visible and method=='GET':
                # The reference/edit flow fetches these original bytes and
                # turns them into a data URL; no separate source-image API.
                assert response[1]==PNG and response[2]['Content-Type']=='image/png'
            assert req(port,image,cookie=c2,method=method)[0]==404
        code,history,_=req(port,'/api/history',cookie=c1)
        assert code==200 and history['retentionDays']==14,(code,history)
        records=[r for r in history['records'] if r['jobId']==j['id']]
        assert len(records)==int(visible),(age,records)
        if visible:assert records[0]['expiresAt']==created+14*day
        code,public,_=req(port,'/api/jobs/'+j['id'],cookie=c1)
        assert code==200 and public['expiresAt']==created+14*day,(age,public)
        assert len(public['images'])==int(visible),(age,public)
        if visible:assert public['images'][0]['expiresAt']==created+14*day
    check('original/reference bytes and HEAD, account/hidden/deleted isolation, 8/13-day visibility and 14/15-day expiry across history/public job')
    code,login,h=req(port,'/api/admin/local_test_admin_path_123456/login',{'username':'test-admin','password':'test-password'});assert code==200,(code,login)
    admin=h['Set-Cookie'].split(';')[0];csrf=login['csrf']
    code,users,_=req(port,'/api/admin/local_test_admin_path_123456/users',cookie=admin)
    assert code==200,(code,users)
    owner=next(u for u in users['users'] if u['id']==one['accountId'])
    visitor=next(u for u in users['users'] if u['id']==two['accountId'])
    assert owner['jobCount']>0 and owner['imageCount']>0 and isinstance(owner['lastCreated'],int),owner
    assert visitor['jobCount']==0 and visitor['imageCount']==0 and visitor['lastCreated'] is None,visitor
    check('administrator users includes a visitor with nullable lastCreated and an owner with works')
    # Directory activity must reflect retained artwork, not newer failed jobs.
    timestamp=int(time.time()*1000)
    cases=[
        ('recent',timestamp-10000,timestamp-10000,False,True),
        ('older-newer-job',timestamp-1000,timestamp-50000,False,False),
        ('failed-only',timestamp,None,False,False),
        ('deleted-only',timestamp-1000,timestamp-1000,True,False),
        ('expired-only',timestamp-31*day,timestamp-31*day,False,False),
        ('same-time',timestamp-10000,timestamp-10000,False,False),
    ]
    fixtures={}
    for index,(label,job_time,image_time,deleted,hidden) in enumerate(cases):
        account='9'*28+f'{index:04x}';job='8'*28+f'{index:04x}'
        fixtures[label]=(account,job,image_time)
        psql(f"INSERT INTO accounts(id) VALUES('{account}'); INSERT INTO jobs(id,account,request_key,status,created) VALUES('{job}','{account}','directory-sort-{index:04d}','{'failed' if image_time is None else 'done'}',{job_time})")
        if image_time is not None:
            psql(f"INSERT INTO stored_images(job,idx,account,file,mime,created,deleted,hidden) VALUES('{job}',0,'{account}','sort-fixture','image/png',{image_time},{str(deleted).upper()},{str(hidden).upper()})")
    code,ordered,_=req(port,'/api/admin/local_test_admin_path_123456/users',cookie=admin)
    assert code==200,(code,ordered)
    ordered=ordered['users']
    assert ordered==sorted(ordered,key=lambda u:(u['lastCreated'] is None,-(u['lastCreated'] or 0),u['id'])),ordered
    for label,(account,job,image_time) in fixtures.items():
        row=next(u for u in ordered if u['id']==account)
        retained=label in ('recent','older-newer-job','same-time')
        assert row['imageCount']==int(retained),(label,row)
        assert row['lastCreated']==(image_time if retained else None),(label,row)
    assert next(i for i,u in enumerate(ordered) if u['id']==fixtures['recent'][0])<next(i for i,u in enumerate(ordered) if u['id']==fixtures['older-newer-job'][0])
    for account,job,_ in fixtures.values():
        psql(f"DELETE FROM stored_images WHERE job='{job}'; DELETE FROM jobs WHERE id='{job}'; DELETE FROM accounts WHERE id='{account}'")
    check('admin directory sorts retained artwork newest first, empty/null last, stable ties; newer failed jobs/deleted/expired images do not win and hidden artwork remains included')
    assert req(port,'/api/admin/local_test_admin_path_123456/recharge',{'amount':'1.00','requestKey':'test-recharge-00001'},admin)[0]==403
    amount={'amount':'1.00','requestKey':'test-recharge-00001'}
    assert req(port,'/api/admin/local_test_admin_path_123456/recharge',amount,admin,csrf)[0]==200
    assert req(port2,'/api/admin/local_test_admin_path_123456/recharge',amount,admin,csrf)[0]==200
    assert int(psql('SELECT balance FROM shared_ledger'))==50070
    assert req(port,'/api/admin/local_test_admin_path_123456/recharge',{**amount,'amount':'2.00'},admin,csrf)[0]==409
    check('administrator login/session/CSRF + cross-request recharge idempotency')
    prefix='/api/admin/local_test_admin_path_123456'
    code,works,_=req(port,prefix+'/users/'+one['accountId']+'/images',cookie=admin)
    assert code==200 and any(i['jobId']==j['id'] for i in works['images']),(code,works)
    assert req(port,prefix+'/users/'+two['accountId']+'/images',cookie=admin)[1]['images']==[]
    assert psql(f"SELECT params IS NULL AND result IS NULL FROM jobs WHERE id='{sql_null_job}'")=='t'
    check('nullable legacy metadata renders user/admin history without rewriting SQL NULL')

    # Admin image reads prefer the stored WebP preview. The OSS mock now
    # preserves actual uploaded bytes instead of returning PNG for every key.
    preview_url=psql(f"SELECT preview_url FROM stored_images WHERE job='{j['id']}' AND idx=0")
    preview_key=preview_url.removeprefix(f'http://127.0.0.1:{PROVIDER.server_port}/')
    preview_file=WORK/('object-'+hashlib.sha256(('oss://mock-bucket/'+preview_key).encode()).hexdigest())
    admin_preview=preview_file.read_bytes()
    assert admin_preview[:4]==b'RIFF' and admin_preview[8:12]==b'WEBP'
    for age in (8,13,14,15,29,30,31):
        created=int(time.time()*1000)-age*day
        psql(f"UPDATE stored_images SET created={created} WHERE job='{j['id']}'")
        code,works,_=req(port,prefix+'/users/'+one['accountId']+'/images',cookie=admin)
        assert code==200,(code,works)
        records=[i for i in works['images'] if i['jobId']==j['id']]
        assert len(records)==int(age<30),(age,records)
        if records:
            assert records[0]['expiresAt']==created+30*day,(age,records)
            assert records[0]['hiddenUser']==(age>=14),(age,records)
        code,original,headers=req(port,prefix+f"/images/{j['id']}/0",cookie=admin)
        assert code==(200 if age<30 else 404),(age,code)
        if age<30:assert original==admin_preview and headers['Content-Type']=='image/webp'
    check('administrator works/original reads retain images for 30 days; hiddenUser starts at 14 days')
    # A dead preview must not hide a retained readable original; if both remote
    # objects fail, use the retained local file without bypassing admin auth.
    psql(f"UPDATE stored_images SET created={int(time.time()*1000)},preview_url='http://127.0.0.1:{PROVIDER.server_port}/local-test/expired-preview',object_url='http://127.0.0.1:{PROVIDER.server_port}/local-test/readable-original' WHERE job='{j['id']}'")
    image_path=prefix+f"/images/{j['id']}/0"
    assert req(port,image_path)[0]==401
    assert req(port,image_path,cookie=admin)[1]==PNG
    local_image=WORK/'data0'/'results'/psql(f"SELECT file FROM stored_images WHERE job='{j['id']}' AND idx=0")
    local_image.parent.mkdir(parents=True,exist_ok=True);local_image.write_bytes(PNG)
    psql(f"UPDATE stored_images SET object_url='http://127.0.0.1:{PROVIDER.server_port}/local-test/expired-original' WHERE job='{j['id']}'")
    assert req(port,image_path,cookie=admin)[1]==PNG
    psql(f"UPDATE stored_images SET preview_url=NULL,object_url=NULL WHERE job='{j['id']}'")
    check('admin expired preview falls back to original then retained local bytes; unauthenticated reads remain denied')

    public_templates=req(port,'/api/templates')[1]
    admin_templates=req(port,prefix+'/templates',cookie=admin)[1]
    assert public_templates==admin_templates
    seed_templates=json.loads((ROOT/'app/public/templates.json').read_text())
    if isinstance(seed_templates,dict):seed_templates=seed_templates['templates']
    source_previews={t['id']:t.get('preview','') for t in seed_templates}
    for item in public_templates['templates']:
        original=source_previews.get(item['id'],'')
        if original.startswith('templates/') and original.endswith(('.png','.jpg','.jpeg','.webp')):
            stem=original.rsplit('.',1)[0].removeprefix('templates/')
            assert item['preview']==f'http://127.0.0.1:{PROVIDER.server_port}/local-test/templates/previews/{stem}.webp',item['id']
    check('public/admin template lists resolve the same runtime OSS previews without frontend asset configuration')

    # Generated templates stay in review until explicitly saved. Upload mode
    # auto-saves a reusable template without charging for image generation.
    author={'mode':'generate','prompt':'test poster','requestKey':'author-local-test-00001'}
    code,task,_=req(port,prefix+'/templates/author',author,admin,csrf);assert code==202,(code,task)
    duplicate=req(port2,prefix+'/templates/author',author,admin,csrf);assert duplicate[0]==200 and duplicate[1]['id']==task['id'],duplicate
    assert req(port,prefix+'/templates/author',{**author,'prompt':'different'},admin,csrf)[0]==409
    for _ in range(100):
        code,draft,_=req(port,prefix+'/templates/author/'+task['id'],cookie=admin)
        if draft['status'] in ('done','failed'):break
        time.sleep(.1)
    assert draft['status']=='done' and draft['charged']==.3 and not draft['saved'],draft
    assert req(port,prefix+'/templates',{'template':draft['template']},admin,csrf)[0]==200
    assert req(port,prefix+'/templates/author/'+task['id'],cookie=admin)[1]['saved']
    upload={'mode':'upload','image':'data:image/png;base64,'+base64.b64encode(PNG).decode(),'requestKey':'author-local-upload-00001'}
    code,task2,_=req(port,prefix+'/templates/author',upload,admin,csrf);assert code==202,(code,task2)
    for _ in range(100):
        code,uploaded,_=req(port,prefix+'/templates/author/'+task2['id'],cookie=admin)
        if uploaded['status'] in ('done','failed'):break
        time.sleep(.1)
    assert uploaded['status']=='done' and uploaded['saved'] and uploaded['charged']==0,uploaded
    assert req(port,prefix+'/templates/'+draft['template']['id'],{},admin,csrf,method='DELETE')[0]==200
    assert req(port,prefix+'/templates/author/'+task['id'],cookie=admin)[1]['deleted']
    assert psql('SELECT balance FROM shared_ledger')=='50040'
    check('template author task, generated review/save/delete and free upload auto-save')
    video={'prompt':'mock video','style':'realistic','duration':4,'ratio':'16:9','resolution':'768P','requestKey':'video-local-test-00001'}
    before_2k=(psql('SELECT balance FROM shared_ledger'),psql('SELECT count(*) FROM video_jobs'),len(Provider.video_requests))
    for reference in [None,'data:image/png;base64,'+base64.b64encode(PNG).decode()]:
        invalid={**video,'resolution':'2K','requestKey':'unsupported-2k-test-'+('image' if reference else 'text')}
        if reference:invalid['image']=reference
        code,rejected,_=req(port,'/api/videos',invalid,c1);assert code==400,(code,rejected)
        lookup='/api/videos/by-request?requestKey='+invalid['requestKey']
        assert req(port,lookup,cookie=c1)[0]==404
        assert req(port,lookup,cookie=c2)[0]==404
    assert (psql('SELECT balance FROM shared_ledger'),psql('SELECT count(*) FROM video_jobs'),len(Provider.video_requests))==before_2k
    check('unsupported 2K rejects both text and image inputs without accepting, charging or calling provider')
    code,v,_=req(port,'/api/videos',video,c1);assert code==202,(code,v)
    duplicate=req(port2,'/api/videos',video,c1);assert duplicate[0]==200 and duplicate[1]['id']==v['id'],duplicate
    by_request='/api/videos/by-request?requestKey='+video['requestKey']
    assert req(port2,by_request,cookie=c1)[1]['id']==v['id']
    assert req(port2,by_request,cookie=c2)[0]==404
    assert req(port,by_request)[0]==401
    assert req(port,'/api/videos/by-request?requestKey=invalid',cookie=c1)[0]==400
    assert req(port,'/api/videos',{**video,'prompt':'different'},c1)[0]==409
    assert req(port,'/api/videos/'+v['id'],cookie=c2)[0]==404
    for _ in range(200):
        code,finished,_=req(port,'/api/videos/'+v['id'],cookie=c1)
        if finished['status'] in ('done','failed'):break
        time.sleep(.1)
    assert finished['status']=='done' and finished['chargedCents']==480 and finished['reservedCents']==0,finished
    assert req(port,'/api/videos',{**video,'style':'clay'},c1)[0]==409
    sent=Provider.video_requests[0]
    assert sent['resolution']=='768P' and sent['duration']==4 and sent['ratio']=='16:9',sent
    prepared=sent['content'][0]['text']
    assert prepared.startswith('mock video\n\n【生成质量规范】\n') and '毛孔' in prepared and '油画笔触' in prepared,prepared
    assert all(key not in sent for key in ['prompt_optimizer','negative_prompt','seed','guidance_scale','fps','extra']),sent
    assert finished['prompt']==prepared
    check('server-prepared real skin prompt reaches provider once; style is fingerprinted and unsupported quality fields are absent')
    restored=req(port2,by_request,cookie=c1)
    assert restored[0]==200 and restored[1]['id']==v['id'] and restored[1]['status']=='done'
    assert req(port, '/api/videos/by-request?requestKey=video-missing-test-00001',cookie=c1)[0]==404
    assert psql('SELECT balance FROM shared_ledger')=='49560'
    assert req(port,'/api/videos',cookie=c1)[1]['records'][0]['id']==v['id']
    assert not list(WORK.glob('data*/video-tmp/*.mp4'))
    media='/api/videos/'+v['id']+'/media'
    assert finished['url']=='api/videos/'+v['id']+'/media'
    assert req(port,media)[0]==401
    assert req(port,media,cookie=c2)[0]==404
    code,media_body,headers=req(port,media,cookie=c1);assert code==200 and media_body==VIDEO_BYTES,(code,media_body)
    assert headers['Cache-Control']=='private, no-store'
    code,media_body,headers=req(port,media,cookie=c1,extra_headers={'Range':'bytes=4-9'})
    assert code==206 and media_body==VIDEO_BYTES[4:10] and headers['Content-Range']==f'bytes 4-9/{len(VIDEO_BYTES)}'
    code,media_body,headers=req(port,media,cookie=c1,method='HEAD');assert code==200 and media_body==b'' and int(headers['Content-Length'])==len(VIDEO_BYTES)
    assert req(port,media,cookie=c1,extra_headers={'Range':'bytes=9999-'})[0]==416
    commands=[json.loads(line) for line in (WORK/'oss-commands.jsonl').read_text().splitlines()]
    uploads=[cmd for cmd in commands if 'cp' in cmd and any('results/videos/'+v['id']+'.mp4' in item for item in cmd)]
    assert uploads and all(cmd[cmd.index('--acl')+1]=='private' and cmd[cmd.index('--cache-control')+1]=='private,no-store' for cmd in uploads),uploads
    try:OPENER.open(f'http://127.0.0.1:{PROVIDER.server_port}/local-test/results/videos/'+v['id']+'.mp4');raise AssertionError('private video became public')
    except urllib.error.HTTPError as error:assert error.code==403
    assert all(cmd[cmd.index('--expires-duration')+1]=='5m' for cmd in commands if 'presign' in cmd and any('results/videos/' in item for item in cmd))
    check('private video object ACL and account-scoped media GET/HEAD/Range/isolation')
    check('video provider/mock OSS full success, idempotency, isolation and exact billing')
    psql('UPDATE shared_ledger SET balance=50070')

    fail=req(port,'/api/generate',payload(prompt='FAIL_TEST'),c1);assert fail[0]==202,fail
    failed=complete(port,fail[1]['id'],c1);assert failed['status']=='failed' and failed['charged']==0,failed
    assert int(psql('SELECT balance FROM shared_ledger'))==50070
    assert int(psql("SELECT COALESCE(SUM(reserved),0) FROM jobs WHERE status IN ('running','queued')"))==0
    check('provider rejection releases reservation without charging')
    for scenario,expected_count,reason in [('SHORT_BATCH_TEST',2,''),('DUPLICATE_BATCH_TEST',1,'重复'),('FAIL_FILL_TEST',1,'400'),('RATE_FILL_TEST',1,'429')]:
        before=int(psql('SELECT balance FROM shared_ledger'))
        batch={**payload(prompt=scenario),'compare':True}
        accepted=req(port,'/api/generate',batch,c1);assert accepted[0]==202,accepted
        finished=complete(port,accepted[1]['id'],c1)
        assert finished['status']=='done' and len(finished['images'])==expected_count and finished['charged']==expected_count*.3,finished
        assert finished['count']==2 and (reason in finished['error'] if reason else not finished['error']),finished
        assert psql(f"SELECT reserved::text||'|'||charged::text FROM jobs WHERE id='{finished['id']}'")==f'0|{expected_count*30}'
        assert int(psql('SELECT balance FROM shared_ledger'))==before-expected_count*30
        calls=[values for prompt,values in Provider.image_requests.items() if scenario in prompt]
        assert calls==[[2,1]],calls
        duplicate=req(port,'/api/generate',batch,c1)
        assert duplicate[0]==200 and duplicate[1]['id']==finished['id'],duplicate
        assert [values for prompt,values in Provider.image_requests.items() if scenario in prompt]==[[2,1]]
        assert int(psql(f"SELECT count(*) FROM stored_images WHERE job='{finished['id']}'"))==expected_count
    psql('UPDATE shared_ledger SET balance=50070')
    check('F06 short batch fills only missing output; duplicate/rejection/429 retain partial delivery with exact idempotent billing')
    (WORK/'slow-oss').touch()
    hidden_job=req(port,'/api/generate',{**payload(),'compare':True},c1);assert hidden_job[0]==202,hidden_job
    for _ in range(100):
        partial=req(port,'/api/jobs/'+hidden_job[1]['id'],cookie=c1)[1]
        if partial['status']=='running' and len(partial.get('images',[]))==1:break
        time.sleep(.05)
    assert partial['status']=='running' and len(partial.get('images',[]))==1,partial
    assert req(port,f"/api/jobs/{hidden_job[1]['id']}/images/0",{},c1,method='DELETE')[0]==200
    settled=complete(port,hidden_job[1]['id'],c1)
    assert settled['status']=='done' and settled['charged']==.6,settled
    assert psql(f"SELECT hidden::text||'|'||deleted::text FROM stored_images WHERE job='{hidden_job[1]['id']}' AND idx=0")=='true|false'
    assert psql('SELECT balance FROM shared_ledger')=='50010'
    (WORK/'slow-oss').unlink()
    psql('UPDATE shared_ledger SET balance=50070')
    check('hiding a journaled image during generation preserves hidden flag and full delivery charge')

    # Eight accounts and four units available. The global row
    # lock must prevent overspending while independent PostgreSQL transactions also contend on the ledger.
    identities=[bootstrap(port if i%2==0 else port2)[1] for i in range(8)]
    psql('UPDATE shared_ledger SET balance=120')
    blocker=subprocess.Popen(['runuser','-u','postgres','--','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d',DB,'-c','BEGIN;SELECT balance FROM shared_ledger WHERE id=1 FOR UPDATE;SELECT pg_sleep(1);COMMIT'],cwd='/tmp',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(50):
        if int(psql("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep'"))>0:break
        time.sleep(.01)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        results=list(executor.map(lambda pair:req(port if pair[0]%2==0 else port2,'/api/generate',payload(),pair[1]),enumerate(identities)))
    assert blocker.wait(timeout=5)==0
    accepted=[(r[1]['id'],identities[i],port if i%2==0 else port2) for i,r in enumerate(results) if r[0]==202]
    assert len(accepted)==4,[(r[0],r[1]) for r in results]
    assert all(r[0] in (202,402) for r in results),results
    for job,cookie,origin in accepted:assert complete(origin,job,cookie)['status']=='done'
    assert psql('SELECT balance FROM shared_ledger')=='0'
    assert psql("SELECT COALESCE(SUM(reserved),0) FROM jobs WHERE status IN ('queued','running')")=='0'
    check('concurrent reservation locks shared ledger, prevents overspending')
    # Persist a delivered image and interrupted reservation, then boot again.
    for process in PROCESSES:process.terminate();process.wait(timeout=10)
    now=int(time.time()*1000);job='e'*32;account=one['accountId']
    psql(f"""UPDATE shared_ledger SET balance=1000;
INSERT INTO jobs(id,account,request_key,status,phase,reserved,created,params,result) VALUES('{job}','{account}','recovery-test-00001','running','saving',30,{now},'{{"prompt":"recovery"}}','{{}}');
INSERT INTO stored_images(job,idx,account,file,mime,created,object_url,preview_url,hidden) VALUES('{job}',0,'{account}','missing-local','image/png',{now},'https://mock.invalid/original','https://mock.invalid/preview',TRUE);
INSERT INTO video_jobs(id,account,request_key,fingerprint,status,phase,created,reserved,prompt,duration,ratio,resolution) VALUES('{'f'*32}','{account}','video-boot-test-0001','f','queued','queued',{now},480,'test',4,'16:9','768P');""")
    def snapshot():
        tables=psql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        return [psql(f"SELECT COALESCE(jsonb_agg(r ORDER BY r::text),'[]'::jsonb) FROM (SELECT to_jsonb(t) AS r FROM {table} t) x") for table in tables]
    before=snapshot();port,server=start(0,maintenance=True)
    health=req(port,'/api/health');assert health[0]==200 and health[1]['database']=='postgres' and health[1]['maintenance']
    for endpoint,content in [('/api/bootstrap',None),('/api/templates',None),('/api/history',None),('/api/generate',payload()),(prefix+'/login',{'username':'test-admin','password':'test-password'}),(prefix+'/recharge',amount),('/manage/local_test_admin_path_123456',None)]:
        assert req(port,endpoint,content,c1)[0]==503,endpoint
    assert req(port,'/')[0]==200
    time.sleep(.5)
    assert before==snapshot(),'maintenance changed database rows'
    server.terminate();server.wait(timeout=10)
    check('maintenance health/static only; API, admin, recovery and workers make no writes')
    port,server=start(0)
    recovered=req(port,'/api/jobs/'+job,cookie=c1);assert recovered[0]==200 and recovered[1]['charged']==.3,recovered
    assert psql('SELECT balance FROM shared_ledger')=='970'
    assert psql(f"SELECT hidden FROM stored_images WHERE job='{job}'")=='t'
    assert recovered[1]['images']==[]
    assert psql("SELECT reserved FROM video_jobs WHERE id='"+'f'*32+"'")=='0'
    server.terminate();server.wait(timeout=10);port,server=start(0)
    assert psql('SELECT balance FROM shared_ledger')=='970'
    check('restart journals remote images once, releases video hold without minting money')
    server.terminate();server.wait(timeout=10)
    psql('UPDATE shared_ledger SET balance=10000')
    resumed_ids=[f'{i:032x}' for i in range(1,8)]
    for index,video_id in enumerate(resumed_ids):
        psql(f"INSERT INTO video_jobs(id,account,request_key,fingerprint,status,phase,created,started,reserved,prompt,duration,ratio,resolution,provider_id) VALUES('{video_id}','{account}','resume-many-{index:08d}','f','running','running',{now},{now},480,'test',4,'16:9','768P','mock-video-{index}')")
    Provider.peak=0
    port,server=start(0)
    # Seven resumed jobs need two four-slot batches. Each batch sleeps ten
    # seconds before its first provider poll, plus download/publish/settlement.
    resume_deadline=time.monotonic()+60
    while True:
        active=int(psql("SELECT COUNT(*) FROM video_jobs WHERE status IN ('queued','running')"))
        if active==0:break
        assert time.monotonic()<resume_deadline,{'active':active,'videos':psql("SELECT json_agg(json_build_object('status',status,'charged',charged,'error',error)) FROM video_jobs")}
        time.sleep(.1)
    assert psql("SELECT COUNT(*) FROM video_jobs WHERE status='done' AND charged=480")== '8'
    assert psql('SELECT balance FROM shared_ledger')=='6640'
    assert 1<=Provider.peak<=4,Provider.peak
    server.terminate();server.wait(timeout=10);port,server=start(0)
    assert psql('SELECT balance FROM shared_ledger')=='6640'
    check('seven interrupted videos all resume through normal bounded workers and charge once')
    # Kill the only leased PostgreSQL session. The old pool may not silently
    # reconnect, and therefore cannot write after a new primary takes over.
    before=psql('SELECT balance FROM shared_ledger');jobs_before=psql('SELECT COUNT(*) FROM jobs')
    blocker=subprocess.Popen(['runuser','-u','postgres','--','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-d',DB,'-c','BEGIN;SELECT balance FROM shared_ledger WHERE id=1 FOR UPDATE;SELECT pg_sleep(3);COMMIT'],cwd='/tmp',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(50):
        if int(psql("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep'"))>0:break
        time.sleep(.01)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        writing=executor.submit(req,port,'/api/generate',payload(),c1)
        for _ in range(50):
            if int(psql("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='jianlai-primary' AND wait_event_type='Lock'"))>0:break
            time.sleep(.01)
        else:raise AssertionError('primary transaction never waited on independent ledger lock')
        psql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{DB}' AND usename='{ROLE}' AND application_name='jianlai-primary'")
        try:response=writing.result(timeout=10);assert response[0]>=500,response
        except (OSError,urllib.error.URLError):pass
    assert blocker.wait(timeout=5)==0
    for _ in range(100):
        if server.poll() is not None:break
        time.sleep(.1)
    assert server.poll() is not None,'primary survived lost lease session'
    assert psql('SELECT balance FROM shared_ledger')==before
    assert psql('SELECT COUNT(*) FROM jobs')==jobs_before
    port,server=start(0)
    assert req(port,'/api/health')[0]==200
    assert psql('SELECT balance FROM shared_ledger')==before
    check('lost lease session fails closed without pool reconnect; new primary can take over')

    fallback_config=WORK/'missing-database.env';fallback_config.write_text('DATABASE_MODE=postgres\n')
    no_fallback=WORK/'no-fallback';no_fallback.mkdir()
    env={**os.environ,'DATA_DIR':str(no_fallback),'APP_ROOT':str(ROOT/'app'),'CONFIG_FILE':str(fallback_config),'VISION_CONFIG_FILE':str(WORK/'absent'),'IMAGE_FALLBACK_CONFIG_FILE':''}
    result=subprocess.run([str(BINARY)],env=env,capture_output=True,timeout=10)
    assert result.returncode!=0 and b'DATABASE_MODE=postgres requires DATABASE_URL' in result.stderr
    assert not (no_fallback/'state.sqlite').exists()
    sqlite_port,sqlite_server=start(9,mode='sqlite')
    assert req(sqlite_port,'/api/health')[1]['database']=='sqlite'
    local,cookie=bootstrap(sqlite_port)
    generated=req(sqlite_port,'/api/generate',payload(),cookie);assert generated[0]==202,generated
    assert complete(sqlite_port,generated[1]['id'],cookie)['charged']==.3
    import sqlite3
    with sqlite3.connect(WORK/'data9/state.sqlite') as conn:
        assert conn.execute('SELECT balance FROM shared_ledger').fetchone()[0]==49970
        assert 'fingerprint' in [r[1] for r in conn.execute('PRAGMA table_info(author_tasks)')]
    check('explicit PG missing URL fails closed; default SQLite rollback path still generates/bills')
    sqlite_server.terminate();sqlite_server.wait(timeout=10)
    timestamp=int(time.time()*1000)
    with sqlite3.connect(WORK/'data9/state.sqlite') as conn:
        for index in range(7):
            conn.execute("INSERT INTO video_jobs(id,account,requestKey,fingerprint,status,phase,created,started,reserved,prompt,duration,ratio,resolution,provider_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(f'{index+101:032x}',local['accountId'],f'sqlite-resume-{index:08d}','f','running','running',timestamp,timestamp,480,'test',4,'16:9','768P',f'mock-sqlite-{index}'))
    Provider.peak=0;Provider.video_polls=[]
    sqlite_port,sqlite_server=start(9,mode='sqlite')
    # The prior 200x100ms budget ended at the second batch's earliest poll,
    # before its I/O and settlement. Wait for terminal state within a stated
    # budget, preserving exact billing assertions and diagnostic state.
    resume_started=time.monotonic();resume_deadline=resume_started+60
    while True:
        with sqlite3.connect(WORK/'data9/state.sqlite') as conn:
            active=conn.execute("SELECT COUNT(*) FROM video_jobs WHERE status IN ('queued','running')").fetchone()[0]
            rows=conn.execute('SELECT status,charged,error FROM video_jobs ORDER BY id').fetchall()
        if active==0:break
        assert time.monotonic()<resume_deadline,{'active':active,'videos':rows}
        time.sleep(.1)
    print('SQLite resumed seven videos in %.2fs (60s terminal-state budget); provider poll offsets %s'%(time.monotonic()-resume_started,[round(t-Provider.video_polls[0],2) for t in Provider.video_polls]),flush=True)
    with sqlite3.connect(WORK/'data9/state.sqlite') as conn:
        balance=conn.execute('SELECT balance FROM shared_ledger').fetchone()[0]
        resumed=conn.execute('SELECT status,charged,error FROM video_jobs ORDER BY id').fetchall()
        assert balance==46610,{'balance':balance,'videos':resumed}
        assert conn.execute("SELECT COUNT(*) FROM video_jobs WHERE status='done' AND charged=480").fetchone()[0]==7,resumed
    assert 1<=Provider.peak<=4,Provider.peak
    check('retained SQLite also resumes seven videos through normal four worker slots')

    # Run after the existing exact ledger assertions so new GIF deliveries do
    # not change their historical accounting baseline.
    gif_request=payload(prompt='GIF_TEST 循环动图')
    gif_request['animation']={'fps':4,'durationSeconds':3,'frames':12}
    before=int(psql('SELECT balance FROM shared_ledger'))
    code,created,_=req(port,'/api/generate',gif_request,c1);assert code==202,(code,created)
    duplicate=req(port,'/api/generate',gif_request,c1)
    assert duplicate[0]==200 and duplicate[1]['id']==created['id'],duplicate
    done=complete(port,created['id'],c1)
    assert done['status']=='done' and done['charged']==.3,done
    assert done['error']=='',done
    image=done['images'][0]
    assert image['type']=='image/gif' and image['downloadUrl'].endswith('.gif'),image
    assert image['animation']=={'frames':12,'durationMs':3000,'fps':4.0,'width':8,'height':8},image
    assert int(psql('SELECT balance FROM shared_ledger'))==before-30
    stored=json.loads(psql(f"SELECT json_build_object('mime',mime,'url',object_url) FROM stored_images WHERE job='{created['id']}'"))
    assert stored['mime']=='image/gif' and stored['url'].endswith('.gif'),stored
    copies=[json.loads(line) for line in (WORK/'oss-copies.jsonl').read_text().splitlines()]
    original=next(copy for copy in copies if created['id'] in copy['target'] and copy['target'].endswith('.gif'))
    assert original['sha256']==hashlib.sha256(GIF).hexdigest() and original['bytes']==len(GIF),original
    assert req(port,'/api/jobs/'+created['id'],cookie=c2)[0]==404
    history=req(port,'/api/history',cookie=c1)[1]['records']
    assert next(row for row in history if row['jobId']==created['id'])['type']=='image/gif'
    check('GIF HTTP delivery preserves original bytes/MIME/extension and actual metadata; duplicate request charges once and account isolation holds')
    gif_job_id=created['id']
    static_request=payload(prompt='STATIC_GIF_TEST 循环动图')
    static_request['animation']={'fps':4,'durationSeconds':3,'frames':12}
    before=int(psql('SELECT balance FROM shared_ledger'))
    code,created,_=req(port,'/api/generate',static_request,c1);assert code==202,(code,created)
    done=complete(port,created['id'],c1)
    assert done['status']=='done' and done['charged']==.3 and '静态图片' in done['error'],done
    assert done['images'][0]['type']=='image/png' and done['images'][0]['animation'] is None,done
    assert int(psql('SELECT balance FROM shared_ledger'))==before-30
    calls=[calls for prompt,calls in Provider.image_requests.items() if 'STATIC_GIF_TEST' in prompt]
    assert calls==[[1]],calls
    check('static fallback is delivered and billed once with an explicit warning and no automatic paid retry')

    # Read the authenticated original, then feed each actual output into the
    # next edit. Distinct bytes make stale-reference regressions observable.
    def original_bytes(job,cookie=c1):
        code,data,headers=req(port,f'/api/jobs/{job}/images/0',cookie=cookie)
        assert code==200 and isinstance(data,bytes),(code,data)
        return data,headers
    before=int(psql('SELECT balance FROM shared_ledger'))
    code,source,_=req(port,'/api/generate',payload(prompt='EDIT_CHAIN_SOURCE'),c1)
    assert code==202,(code,source)
    assert complete(port,source['id'],c1)['status']=='done'
    reference,_=original_bytes(source['id'])
    assert reference==PNG
    assert req(port,f"/api/jobs/{source['id']}/images/0",cookie=c2)[0]==404
    seen=[reference]
    for step in (1,2):
        edit=payload(prompt=f'EDIT_CHAIN_STEP_{step}')
        edit['references']=['data:image/png;base64,'+base64.b64encode(reference).decode()]
        code,created,_=req(port,'/api/generate',edit,c1);assert code==202,(code,created)
        done=complete(port,created['id'],c1)
        assert done['status']=='done' and done['charged']==.3,done
        reference,headers=original_bytes(created['id'])
        assert reference not in seen and headers.get_content_type()=='image/png'
        received=Provider.edit_requests[-1]
        assert received['images']==[seen[-1]] and received['mask'] is None,received
        assert received['fields']['n']=='1',received['fields']
        calls=len(Provider.edit_requests)
        repeated=req(port,'/api/generate',edit,c1)
        assert repeated[0]==200 and repeated[1]['id']==created['id'],repeated
        assert len(Provider.edit_requests)==calls
        seen.append(reference)
    assert int(psql('SELECT balance FROM shared_ledger'))==before-90
    check('authenticated original -> edit -> edit uses latest real bytes, charges one image per job and preserves request-key idempotency/account isolation')

    # GIF editing uses its decoded first frame as a static reference to create
    # a new animation; this deliberately does not claim frame-by-frame editing.
    from PIL import Image
    gif_bytes,headers=original_bytes(gif_job_id)
    assert gif_bytes==GIF and headers.get_content_type()=='image/gif'
    first_frame=io.BytesIO()
    with Image.open(io.BytesIO(gif_bytes)) as animated:
        animated.seek(0);animated.convert('RGBA').save(first_frame,format='PNG')
    first_frame=first_frame.getvalue()
    edit=payload(prompt='GIF_EDIT_TEST 首帧静态参考重新生成动图')
    edit['references']=['data:image/png;base64,'+base64.b64encode(first_frame).decode()]
    edit['animation']={'fps':4,'durationSeconds':3,'frames':12}
    before=int(psql('SELECT balance FROM shared_ledger'))
    code,created,_=req(port,'/api/generate',edit,c1);assert code==202,(code,created)
    done=complete(port,created['id'],c1)
    assert done['status']=='done' and done['charged']==.3 and done['error']=='',done
    assert Provider.edit_requests[-1]['images']==[first_frame]
    image=done['images'][0]
    assert image['type']=='image/gif' and image['animation']=={'frames':12,'durationMs':3000,'fps':4.0,'width':8,'height':8},image
    assert original_bytes(created['id'])[0]==GIF
    assert int(psql('SELECT balance FROM shared_ledger'))==before-30
    check('GIF authenticated bytes -> first-frame PNG reference -> newly generated GIF preserves animation metadata and single-image billing')

    legacy_video={'prompt':'legacy pending video','duration':4,'ratio':'16:9','resolution':'768P','requestKey':'legacy-video-style-compat-001'}
    before=int(psql('SELECT balance FROM shared_ledger'))
    code,legacy,_=req(port,'/api/videos',legacy_video,c1);assert code==202,(code,legacy)
    duplicate=req(port,'/api/videos',{**legacy_video,'style':'auto','stylePrompt':''},c1)
    assert duplicate[0]==200 and duplicate[1]['id']==legacy['id'],duplicate
    for _ in range(200):
        code,finished,_=req(port,'/api/videos/'+legacy['id'],cookie=c1)
        if finished['status'] in ('done','failed'):break
        time.sleep(.1)
    assert finished['status']=='done' and finished['chargedCents']==480,finished
    assert int(psql('SELECT balance FROM shared_ledger'))==before-480
    check('legacy video payload and explicit auto style reconcile one original job and charge once')

    print('PostgreSQL business HTTP integration: ALL PASSED',flush=True)
except BaseException:
    FAILED=True
    print("Failure evidence retained at "+str(WORK),file=sys.stderr)
    for log in LOGS:log.flush()
    for path in WORK.glob('server*.log'):
        print(path.name+':\n'+path.read_text()[-4000:],file=sys.stderr)
    raise
finally:
    for p in PROCESSES:
        if p.poll() is None:p.terminate();p.wait(timeout=10)
    for f in LOGS:f.close()
    subprocess.run(['runuser','-u','postgres','--','dropdb','--if-exists',DB],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    psql(f'DROP ROLE IF EXISTS {ROLE}',database='postgres')
    if not FAILED:shutil.rmtree(WORK)
