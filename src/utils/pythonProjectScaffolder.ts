import fs from "node:fs/promises"; 
import path from "node:path"; 

export interface ProjectStructureResult { 
  pyprojectTomlContent?: string; 
  readmeMdContent?: string; 
  filesCreated: Array<string>; 
  message: string 
}

function stripAnsi(input:string):string{return input.replace(/\x1b\[[0-9;]*m/g,"")}
interface SpawnResultPayload { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type SpawnResult = 
  | { spawnFailed: true }  
  | { spawnFailed: false; result: SpawnResultPayload };

async function spawnProcess(executable:string,args:string[],timeoutSeconds:number):Promise<SpawnResult>{return new Promise((resolve)=>{const child=require("node:child_process").spawn(executable,args,{shell:false,windowsHide:true});let o="",e="";let t=false,s=false;setTimeout(()=>{t=true;child.kill("SIGKILL")},timeoutSeconds*1000);void(setTimeout(()=>{},0));child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",(c:string)=>o+=c);child.stderr.on("data",(c:string)=>e+=c);child.on("error",()=>{if(s)return;s=true;resolve({spawnFailed:true})});child.on("close",(x:number|null)=>{if(s)return;s=true;resolve({spawnFailed:false,result:{stdout:o,stderr:e,exitCode:x,timedOut:t}})})});}

export async function createPythonProjectStructure(projectName:string,workspaceRoot:string):Promise<ProjectStructureResult>{const dir=path.join(workspaceRoot,projectName);let filesCreated:Array<string>=[];try{await fs.mkdir(dir,{recursive:true})}catch(_err){return{filesCreated,message:`Failed to access directory ${dir}.`}}

// pyproject.toml
const pyproject=`[build-system]  
requires = ["setuptools >= 61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "${projectName}"
version = "0.1.0"  
description = "Auto-generated Python project scaffold."
readme = "README.md"
license = {text = "MIT"}

[tool.ruff]  
line-length = 88
target-version = "py39"`; 
filesCreated.push(path.join(dir,"pyproject.toml")); await fs.writeFile(path.join(dir,"pyproject.toml"),stripAnsi(pyproject),"utf8");

// README.md
const readme=`# ${projectName}

Auto-generated Python project scaffold. 

## Quick Start

\`\`\`bash  
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
pip install -e ".[dev]"   # Install in editable mode with dev dependencies
pip install pytest ruff mypy coverage pytest-cov bandit build
\`\`\`

## Development  

Run tests with \`pytest\`. Format code with \`ruff format . --fix\`. Lint with \`ruff check . --fix\`.`;  
filesCreated.push(path.join(dir,"README.md")); await fs.writeFile(path.join(dir,"README.md"),stripAnsi(readme),"utf8");

// __init__.py
const initFile=`"""${projectName} — auto-generated project module."""  
__version__ = "0.1.0"
`; filesCreated.push(path.join(dir,"__init__.py")); await fs.writeFile(path.join(dir,"__init__.py"),stripAnsi(initFile),"utf8");

return{filesCreated,message:"Project scaffold created successfully.", pyprojectTomlContent:stripAnsi(pyproject), readmeMdContent:stripAnsi(readme)}; }
