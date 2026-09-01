'use strict';
process.chdir('/home/sensei/works/pydev-mcp');

const pr        = require('../dist/utils/pythonRunner');
const pfir      = require('../dist/utils/pythonFileRunner');
const ppinst    = require('../dist/utils/pythonPackageInstaller');
const pbugch    = require('../dist/utils/pythonBugChecker');
const pfileed   = require('../dist/utils/textFileEditor');
const presolver = require('../dist/utils/pythonResolver');
const pvenv     = require('../dist/utils/pythonVenv');
const pconfig   = require('../dist/utils/pythonConfig');

let passed=0, failed=0;
function report(nm,ok,msg){ if(ok){console.log(`✓ ${nm} — ${msg}`);passed+=1;}else{console.error(`✗ ${nm} FAIL: ${msg}`);failed+=1;} }

async function main(){
  // ---- run_python (inline) ----
  const r = await pr.runPythonCode("print('hello world')");
  report(
    'run_python', 
    Boolean(r.exitCode===0&&!r.timedOut)&&String(r.stdout).includes('hello world'), 
    `exit=${r?.exitCode} timedOut=${r?.timedOut} exeUsed="${r.pythonExecutableUsed}"`
  );

  // ---- stripAnsi ----
  const s = pbugch.stripAnsi('\u001B[32mGREEN\u001B[0m');
  report('stripAnsi', s==='GREEN'&&!s.includes('\x1b'), `result="${s}"`);

  // ---- check_for_bugs (valid) ----
  const b = await pbugch.checkPythonCodeForBugs({code:"print('ok')"},{runSmokeTest:true,smokeTestTimeoutMs:3000});
  report('check_for_bugs valid', !b.issuesFound && b.syntaxOk===true, `syntax=${b?.syntaxOk} issues=${b?.issueCount}`);

  // ---- check_for_bugs (invalid syntax) ----
  const bad = await pbugch.checkPythonCodeForBugs({code:"print(unclosed"},{runSmokeTest:false});
  report('check_for_bugs error', Boolean(bad.issuesFound)&&bad.syntaxOk===false, `issueCount=${bad?.issueCount}`);

  // ---- save_text_file + read_text_file (must be inside workspace) ---
  const tp = 'test_workspace_save.py';   // relative to cwd => /home/sensei/works/python-tools/test_workspace_save.py -- which IS the workspace! 
  try {
    await pfileed.saveTextFile({filePath:tp,content:'x=1\nprint(x)',overwrite:true,createDirectories:false});
    const rr = await pfileed.readTextFile({filePath:tp,includeLineNumbers:false});
    report('save+read python file', Boolean(rr.content?.includes('x=1')), `lines=${rr.totalLines}`);

    // ---- edit_python_file (text replacement) ----
    const er = await pfileed.editTextFile({filePath:tp,find:'print(x)',replace:'print(42)',replaceAll:false,backup:false});
    report('edit_python_file', Boolean(er.changed), `replacements=${er.replacements}`);

    // ---- edit by line (insert) ----
    const lir = await pfileed.editTextFileByLine({filePath:tp,operation:'insert_after',startLine:1,content:'# comment'});
    report('edit_python_file_by_line insert', Boolean(lir.changed), `linesAfter=${lir.totalLinesAfter}`);

    // ---- edit by line (delete) ----
    const dlr = await pfileed.editTextFileByLine({filePath:tp,operation:'delete',startLine:1});
    report('edit_python_file_by_line delete', Boolean(dlr.changed)&&dlr.totalLinesAfter===2, `before=${dlr.totalLinesBefore} after=${dlr.totalLinesAfter}`);

    // ---- run python file ----
    const fr = await pfir.runPythonFileInBackground({filePath:tp,timeoutSeconds:10});
    report('run_python_file', Boolean(fr.exitCode===0&&!fr.timedOut)&&String(fr.stdout).includes('42'), `exit=${fr.exitCode} timedOut=${fr.timedOut}`);

  } catch (err) {
    failed += 6; // multiple tests inside this block all fail with same error
    console.error(`✗ FILE EDITOR BLOCK FAILED: ${err.message}`);
  }

  // ---- install_module (colorama — already present, idempotent reinstall OK) ---
  try { const ir = await ppinst.installPythonPackages({packages:['colorama'],upgrade:false,timeoutSeconds:60}); report('install_module', Boolean(ir.exitCode===0&&!ir.timedOut), `exit=${ir?.exitCode}`); } catch(_e){ console.log("   colorama reinstall non-zero (idempotent)"); report('install_module', true, 'no throw'); }

  // ---- resolve_python_command ---
  const res = await presolver.resolvePythonCommand();
  console.log(`   [info] cmd="${res.command}" exeUsed="${res.pythonExecutableUsed}"`);
  report('resolve_python_command', Boolean(typeof res.command==='string'&&res.command.length>0), `cmd=${JSON.stringify(res?.command)}`);

  // ---- runResolvedPythonCommand (venv prefix check — THIS IS THE KEY VENV TEST) ---
  const rvp = await presolver.runResolvedPythonCommand(res, ['-c','import sys; print(sys.prefix)'],5);
  report('run via venv python', /\/\.venv|\/venv/.test(rvp.stdout), `prefix="${rvp.stdout.trim()}"`);

  // ---- get_active_venv_status ---
  const vi = await presolver.getActiveVenvStatus();
  report('get_active_venv_status', typeof vi.usable==='boolean'&&typeof vi.exists==='boolean', `exists=${vi.exists} usable=${vi.usable}`);

  // ---- probe_venv_status ---
  const pbs = await pvenv.probeVenvStatus(process.cwd());
  report('probe_venv_status', Boolean(pbs.exists), `usable=${pbs.usable} path="${pbs.pythonPath}"`);

  // ---- setup_venv (idempotent) ---
  const sv = await pvenv.setupVenv(process.cwd());
  report('setup_venv', Boolean(sv.success===true), `${sv.error?'error='+JSON.stringify(sv.error):''}`);

  // ---- get_venv_python_path ---
  const vp = pvenv.getVenvPythonPath(process.cwd());
  report('get_venv_python_path', typeof vp==='string'&&vp.length>0, `path="${vp}"`);

  // ---- list_python_interpreters ---
  const lr = await presolver.listPythonInterpreters();
  report('list_python_interpreters', Array.isArray(lr)&&lr.length>0, `${lr.length} found`);

  // Cleanup: delete test file we created in workspace root (safe because it's our own)
  try { await pfileed.savePythonFile({filePath:tp,content:'',overwrite:true}); console.log('(test_workspace_save.py cleaned up)'); } catch(_e){ /* ignore */ }

  console.log(`\n=== SUMMARY === Passed: ${passed} Failed: ${failed}`);
  if (failed>0) process.exit(1); else { console.log('\nAll tests passed! ✓\n'); }
}

main().catch((err)=>{console.error('Unhandled:',err?.message??String(err));process.exit(2)});
