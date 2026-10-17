import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {execaSync} from "execa";

const core=resolve(fileURLToPath(new URL("..",import.meta.url)));
const flow=process.env.ZIGMA_FLOW_REPO;
const workspace=process.env.ZIGMA_WORKSPACE_REPO;
if(!flow || !workspace) throw new Error("Set ZIGMA_FLOW_REPO and ZIGMA_WORKSPACE_REPO to source checkouts");
for(const [root,name] of [[core,"core"],[flow,"flow"],[workspace,"workspace"]]) {
  if(JSON.parse(readFileSync(resolve(root,"package.json"),"utf8")).name !== `@zigma-ai/zigma-${name}`) throw new Error(`Invalid ${name} checkout`);
}
function run(command,args,cwd,environment={}) {
  const result=execaSync(command,args,{cwd,env:{...process.env,...environment},stdio:"inherit",reject:false,windowsHide:true});
  if(result.exitCode !== 0)process.exit(result.exitCode ?? 1);
}
// Build once, then exercise every component and all real provider tests.
for(const [root,manager] of [[flow,"pnpm"],[workspace,"pnpm"],[core,"npm"]]) {
  run(manager,["run","typecheck"],root);
  run(manager,["run","build"],root);
}
const providers={ZIGMA_FLOW_CLI_PATH:resolve(flow,"dist/cli.js"),ZIGMA_WORKSPACE_CLI_PATH:resolve(workspace,"dist/cli/index.js"),ZIGMA_CORE_CLI_PATH:resolve(core,"dist/cli.js")};
run("pnpm",["test"],workspace);
run("pnpm",["test"],flow,providers);
run("pnpm",["test:lifecycle"],flow,providers);
run(process.execPath,[resolve(core,"node_modules/vitest/vitest.mjs"),"run"],core,providers);
console.log("All component and real cross-repository readiness gates passed. Live model-provider smoke is a separate authenticated check.");
