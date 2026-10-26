// Operator benchmark: synthetic tasks, with explicit deterministic/live-model labels.
// No model is called unless --mode live-model and --claude-cli are supplied.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const options={mode:'deterministic',coreCli:join(repoRoot,'dist/cli.js'),modelRoute:'operator-unspecified'};
for(let i=2;i<process.argv.length;i++){
  const key={'--mode':'mode','--core-cli':'coreCli','--flow-cli':'flowCli','--workspace-cli':'workspaceCli','--claude-cli':'claudeCli','--model-route':'modelRoute','--artifacts-dir':'artifactsDir'}[process.argv[i]];
  if(!key||!process.argv[i+1])throw Error('Unknown/missing benchmark option: '+process.argv[i]);
  options[key]=process.argv[++i];
}
if(!['deterministic','live-model'].includes(options.mode)||!options.flowCli||!options.workspaceCli||options.mode==='live-model'&&!options.claudeCli)throw Error('Supply --flow-cli JS --workspace-cli JS; live-model also requires --claude-cli PATH');
const parent=resolve(options.artifactsDir??tmpdir());await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'zigma-ops-benchmark-'));
const repository=join(root,'repository');await mkdir(repository);
const slash=p=>p.replaceAll('\\','/');
function git(...args){return execFileSync('git',args,{cwd:repository,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
git('init','-b','main');git('config','user.email','ops-benchmark@example.test');git('config','user.name','Operations benchmark');git('config','core.autocrlf','false');
const prompt=join(root,'current-prompt.txt'),worker=join(root,'workload.cjs');
const workerSource=String.raw`
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const phase=process.argv[2];
const valid=e=>{
 if(typeof e!=='string'||e.length>2000||/(^|[^=!<>])=($|[^=])/.test(e))throw Error('Only a bounded Boolean expression is permitted');
 let rest=e.replace(/Number\.(isSafeInteger|isInteger|isFinite|MAX_SAFE_INTEGER)/g,'A').replace(/\bvalue\b/g,'A').replace(/\btypeof\b/g,'').replace(/(["'])number\1/g,'').replace(/\btrue\b|\bfalse\b/g,'').replace(/\bA\b/g,'').replace(/[0-9\s()!<>=&|.+-]/g,'');
 if(rest)throw Error('Expression outside pure capability list');
 const samples=[-3,-1,-0,0,1,3.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,-Infinity,null,undefined,true,false,'0','1',{},[],[1]];
 for(const value of samples){const actual=vm.runInNewContext('('+e+')',{value},{timeout:50,contextCodeGeneration:{strings:false,wasm:false}});if(actual!==(Number.isSafeInteger(value)&&value>=0))throw Error('Independent counter predicate check failed');}
 return e;
};
try{
 if(phase==='prepare'){
  const variant=process.argv[3];const old={fraction:'typeof value === "number" && value >= 0',negative:'Number.isSafeInteger(value)',coercion:'!isNaN(value) && value >= 0'}[variant];if(!old)throw Error('Unknown fixture');
  fs.writeFileSync(process.argv[4],'Repair this synthetic counter predicate. It must accept ONLY nonnegative safe integer NUMBERS, including zero. Existing expression: '+old+'. Return canonical JSON with ALL FOUR top-level keys {"summary":"brief","outputs":{"expression":"corrected pure Boolean expression using only value, Number.isSafeInteger/isInteger/isFinite/MAX_SAFE_INTEGER, typeof, number literals and Boolean/comparison operators"},"artifacts":[],"signals":[]}. No tools, no markdown, no test claims. This is a bounded synthetic benchmark, not a real repository repair.');
 }else if(phase==='deterministic')fs.writeFileSync('candidate.json',JSON.stringify({expression:valid('Number.isSafeInteger(value) && value >= 0')}));
 else if(phase==='proposal'){
  const run=process.argv[3];const state=JSON.parse(fs.readFileSync(path.join(run,'state.json'),'utf8'));const attempt=state.jobs.work.attempt;
  const report=JSON.parse(fs.readFileSync(path.join(run,'jobs/work/attempts',String(attempt),'steps/propose/report.json'),'utf8'));
  fs.writeFileSync('candidate.json',JSON.stringify({expression:valid(report.outputs.expression)}));
 }else if(phase==='accept'){
  const candidate=JSON.parse(fs.readFileSync(path.join(process.env.ZIGMA_OPS_WORKSPACE,'candidate.json'),'utf8'));valid(candidate.expression);process.stdout.write(JSON.stringify({status:'pass',reason:'20 synthetic counter values checked independently'}));
 }else throw Error('Unknown workload phase');
}catch(error){if(phase==='accept')process.stdout.write(JSON.stringify({status:'fail',reason:error.message}));else console.error(error.message);process.exitCode=10;}
`;
// String.raw preserves regex escapes; the embedded CommonJS source needs one slash.
await writeFile(worker,workerSource.replaceAll('\\\\','\\'));
const bin=join(root,'bin');await mkdir(bin);
async function shim(name,target){
 target=resolve(target);
 if(process.platform==='win32'){
  const path=join(bin,name+'.cmd');await writeFile(path,`@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);return path;
 }
 await chmod(target,0o755);return target;
}
const flowCommand=await shim('zigma-flow',options.flowCli),workspaceCommand=await shim('zigma-workspace',options.workspaceCli);
await mkdir(join(repository,'.zigma-flow'));
const emptyMcp=join(root,'empty-mcp.json'),settings=join(root,'claude-settings.json');
await writeFile(emptyMcp,JSON.stringify({mcpServers:{}}));await writeFile(settings,JSON.stringify({disableAllHooks:true}));
const config={tool_version:'0.8.18',active_run:null,agent:{backend:'claude-code',parallelism:1,backends:{}}};
if(options.mode==='live-model')config.agent.backends['claude-code']={command:resolve(options.claudeCli),args:['-p','--tools','','--setting-sources','','--strict-mcp-config','--mcp-config',emptyMcp,'--settings',settings,'--disable-slash-commands','--no-session-persistence','--permission-mode','dontAsk','--effort','low','--system-prompt','Return only the requested JSON report; all four keys mandatory. No tools or test claims.'],timeout:240000,max_turns:3,model:'haiku',env:{MAX_THINKING_TOKENS:'0',CLAUDE_CODE_EXTRA_BODY:'{"thinking":{"type":"disabled"}}'}};
await writeFile(join(repository,'.zigma-flow/config.json'),JSON.stringify(config,null,2));await writeFile(join(repository,'.zigma-flow/skill-lock.json'),'{"skills":{}}');
const wf=join(repository,'workflow.yml');
const lines=['name: ops-counter-benchmark','version: "1"','jobs:','  work:','    workspace: {mode: read-only}','    retry: {max_attempts: 3, on_exceeded: {status: failed}}','    steps:'];
if(options.mode==='live-model')lines.push('      - id: prepare','        type: script',`        run: node "${slash(worker)}" prepare "\${{ inputs.variant }}" "${slash(prompt)}"`,'      - id: propose','        type: agent','        backend: {name: claude-code}',`        prompt: {file: '${slash(prompt)}'}`,'        outputs_schema:','          expression: {type: string}','      - id: verify-proposal','        type: script',`        run: node "${slash(worker)}" proposal "\${{ run.dir }}"`,'        on_failure: {retry_job: work}');
else lines.push('      - id: deterministic-fixture','        type: script',`        run: node "${slash(worker)}" deterministic`);
await writeFile(wf,lines.join('\n')+'\n');git('add','.');git('commit','-m','fixture: synthetic comparable counter tasks');
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const url=`http://127.0.0.1:${port}`;const coreLog=[];
const core=spawn(process.execPath,[resolve(options.coreCli),'--db',join(root,'core.db'),'serve','--host','127.0.0.1','--port',String(port),'--workers','1'],{env:{...process.env,ZIGMA_CORE_URL:url+'/v1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
core.stdout.on('data',c=>coreLog.push(c.toString()));core.stderr.on('data',c=>coreLog.push(c.toString()));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,path,body){const r=await fetch(url+path,{method,headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});const value=await r.json();if(!r.ok)throw Error(path+': '+JSON.stringify(value));return value.data??value;}
function child(command,args){return new Promise((resolveChild,reject)=>{const c=spawn(command,args,{windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',p=>stdout+=p);c.stderr.on('data',p=>stderr+=p);c.once('error',reject);c.once('close',code=>resolveChild({code,stdout,stderr}));});}
let exitCode=1;const lease=join(root,'suite-use.lock');
try{
 for(let i=0;i<120;i++){try{await api('GET','/health');break;}catch(e){if(core.exitCode!==null||i===119)throw e;await sleep(100);}}
 const profile=await api('POST','/v1/execution-profiles',{name:'ops-benchmark',flowCommand,workspaceCommand,timeoutMs:900000,environment:{ZIGMA_WORKSPACE_STATE_DIR:join(root,'workspace-state')},metadata:{purpose:'synthetic benchmark'}});
 const project=await api('POST','/v1/projects',{key:'ops-benchmark',displayName:'Synthetic operations benchmark',repositories:[{id:'repo',provider:'generic-git',url:repository,defaultRef:'main',writable:false,metadata:{}}],defaultRepositoryId:'repo',defaultWorkflowRef:wf,executionProfileId:profile.id,workspacePolicy:{provider:'zigma-workspace-cli',mode:'read-only',branchTemplate:'zigma/{taskId}',cleanup:'manual',snapshotOnTerminal:true},metadata:{projectRoot:repository}});
 const manifest={schema:'zigma.ops/1',coreUrl:url,projectId:project.id,cohort:'counter-predicate-v1',workloadKind:options.mode==='live-model'?'live-model':'deterministic',proposalFreedom:options.mode==='live-model'?'bounded':'none',modelRoute:options.mode==='live-model'?options.modelRoute:'no-model',workflowRef:wf,backend:'claude-code',suiteLeaseFile:lease,freezeFiles:[wf,worker,join(repository,'.zigma-flow/config.json'),emptyMcp,settings],acceptance:{command:process.execPath,args:[worker,'accept'],timeoutMs:5000},delivery:{files:['candidate.json']},tasks:['fraction','negative','coercion'].map(key=>({key,title:'Synthetic counter '+key,description:'Synthetic bounded counter predicate repair: '+key,inputs:{variant:key}})),callerContext:{actor:{type:'user',id:'ops-benchmark'},capabilities:['task:start','workflow:invoke','workspace:create'],constraints:{repositoryIds:['repo'],workflowRefs:[wf],toolNames:[],branchPatterns:['zigma/*'],maxRunDurationMs:900000},source:{kind:'cli',metadata:{}}},timeoutMs:900000,pollIntervalMs:100,cancelGraceMs:30000};
 const manifestFile=join(root,'manifest.json');await writeFile(manifestFile,JSON.stringify(manifest,null,2));
 const result=await child(process.execPath,[resolve(options.coreCli),'ops','run','--manifest',manifestFile,'--out',join(root,'batch')]);
 await writeFile(join(root,'run.stdout.json'),result.stdout);await writeFile(join(root,'run.stderr.log'),result.stderr);
 const report=await child(process.execPath,[resolve(options.coreCli),'ops','report','--dir',join(root,'batch')]);
 await writeFile(join(root,'report.json'),report.stdout);await writeFile(join(root,'report.stderr.log'),report.stderr);
 exitCode=result.code||report.code||0;
 console.log(JSON.stringify({root,mode:options.mode,exitCode,report:report.code===0?JSON.parse(report.stdout):null,meaning:'Synthetic tasks only; modelRoute is operator-supplied, interventions are recorded notes, not proof of general real-repair success.'},null,2));
}catch(error){console.error(error.message);exitCode=1;}
finally{
 await writeFile(join(root,'core.log'),coreLog.join(''));
 if(!existsSync(lease)){
  core.kill('SIGTERM');for(let i=0;i<50&&core.exitCode===null;i++)await sleep(100);
  if(core.exitCode===null)core.kill('SIGKILL');
 }else{
  console.error('Unknown provider or retained lease: Core PID '+core.pid+' and all evidence retained at '+root);
  core.unref();core.stdout.destroy();core.stderr.destroy();
 }
}
process.exitCode=exitCode;
