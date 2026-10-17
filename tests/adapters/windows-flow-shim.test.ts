import {mkdtemp,writeFile,rm,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {LocalCliFlowExecutor} from "../../src/adapters/local-cli-flow.js";

it("captures detached Flow shim output and preserves task arguments", async()=>{
  const root=await mkdtemp(join(tmpdir(),"zigma shim "));
  try {
    const win=process.platform === "win32";
    const command=join(root,win ? "flow.cmd":"flow.sh");
    await writeFile(command,win ? '@echo off\r\nnode "%~dp0provider.mjs" %*\r\n' : '#!/bin/sh\nnode "$(dirname "$0")/provider.mjs" "$@"\n');
    if(!win)await chmod(command,0o755);
    await writeFile(join(root,"provider.mjs"),`const args=process.argv.slice(2);
const handshake={contractVersion:1,provider:"zigma-flow",packageVersion:"0.8.14",capabilities:["caller-context-v1","invoke-json-v1","context-freeze-v1","callback-envelope-v1","callback-http-delivery-v1"]};
console.log(JSON.stringify(args.includes("contract-info") ? handshake : {contractVersion:1,runId:"shim-run",status:"completed",exitCode:0,artifacts:[{args}]}));`);
    const task="Unicode 中文 and spaces & literal-data";
    const result=await new LocalCliFlowExecutor().start({command,projectId:"p",taskId:"t",flowRunId:"shim-test",workflowRef:"wf.yml",taskText:task,projectRoot:root,inputs:{},callerContext:{actor:{type:"user",id:"tester"},capabilities:["task:start"],constraints:{repositoryIds:[],workflowRefs:[],toolNames:[],branchPatterns:[]},source:{kind:"api",metadata:{}}},permissionSnapshotId:"s",integrityHash:"hash",timeoutMs:30000,environment:{},dryRun:false});
    expect(result.externalRunId).toBe("shim-run");
    const args=(result.metadata.artifacts as Array<{args:string[]}>)[0]!.args;
    expect(args[args.indexOf("--task")+1]).toBe(task);
  } finally {await rm(root,{recursive:true,force:true});}
},30000);
