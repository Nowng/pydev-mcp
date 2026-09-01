'use strict';
/**
 * test/tools.test.cjs — Regression gate for Phase 2 (tool-name simplification)
 * and Phase 3 (structured, grouped list_tools output).
 *
 * Requires a prior build so that dist/utils/toolRegistry.js exists.
 * Run with:  npm run test:tools      (builds, then runs this file)
 */

process.chdir('/home/sensei/works/pydev-mcp');

let reg;
try {
  // eslint-disable-next-line global-require
  reg = require('../dist/utils/toolRegistry.js');
} catch (_e) {
  console.error('Cannot require dist/utils/toolRegistry.js — run "npm run build" first.');
  process.exit(2);
}

const { TOOL_DEFINITIONS, getToolList, getToolGroups, TOOLS_COUNT } = reg;

let passed = 0;
let failed = 0;
function report(nm, ok, msg) {
  if (ok) {
    // eslint-disable-next-line no-console
    console.log(`✓ ${nm}`);
    passed += 1;
  } else {
    // eslint-disable-next-line no-console
    console.error(`✗ FAIL: ${nm}${msg ? ` — ${msg}` : ''}`);
    failed += 1;
  }
}

const names = TOOL_DEFINITIONS.map((d) => d.name);

// ---- Phase 2: the 7 renames ----
const NEW_NAMES = [
  'pydev_run_code',
  'pydev_run_file',
  'pydev_run_code_interactive',
  'pydev_run_file_interactive',
  'pydev_coverage',
  'pydev_scan_security',
  'pydev_type_check',
];
const OLD_NAMES = [
  'pydev_run_python',
  'pydev_run_python_file',
  'pydev_run_python_interactive',
  'pydev_run_python_file_interactive',
  'pydev_run_project_coverage',
  'pydev_scan_project_security',
  'pydev_type_check_project',
];

NEW_NAMES.forEach((n) => report(`new name present: ${n}`, names.includes(n)));
OLD_NAMES.forEach((n) => report(`old name removed: ${n}`, !names.includes(n)));

// ---- Structure (Phase 2/3): group + example on every tool ----
report('every tool has a non-empty group', TOOL_DEFINITIONS.every((d) => typeof d.group === 'string' && d.group.length > 0));
report('every tool has a non-empty example', TOOL_DEFINITIONS.every((d) => typeof d.example === 'string' && d.example.length > 0));
report('TOOLS_COUNT matches array length', TOOLS_COUNT === TOOL_DEFINITIONS.length, `TOOLS_COUNT=${TOOLS_COUNT} len=${TOOL_DEFINITIONS.length}`);
report('total tool count is 41', TOOL_DEFINITIONS.length === 41, `len=${TOOL_DEFINITIONS.length}`);

// ---- Phase 3: getToolGroups() covers the expected groups ----
const groups = getToolGroups();
const EXPECTED_GROUP_SET = new Set(['run', 'packages', 'files', 'search', 'quality', 'testing', 'scaffold', 'environment', 'meta', 'dev', 'refactoring', 'documentation', 'migration', 'context']);
report('getToolGroups returns exactly 14 groups', Array.isArray(groups) && groups.length === 14, `len=${Array.isArray(groups) ? groups.length : 'n/a'}`);
report(
  'getToolGroups covers all expected groups',
  Array.isArray(groups) && groups.length === 14 && EXPECTED_GROUP_SET.size === 14 && groups.every((g) => EXPECTED_GROUP_SET.has(g)) && new Set(groups).size === 14,
  `got=${JSON.stringify(groups)}`,
);

// ---- Phase 3: getToolList(true) structured shape ----
const listed = getToolList(true);
report('getToolList(true) length matches registry', listed.length === TOOL_DEFINITIONS.length, `len=${listed.length}`);
report(
  'getToolList(true): each item exposes name + group + description + example',
  listed.every((t) => t && t.name && t.group && typeof t.description === 'string' && t.example),
  JSON.stringify(listed.slice(0, 3)),
);

// ---- Sanity: the list_tools tool itself is registered in the meta group ----
const self = TOOL_DEFINITIONS.find((d) => d.name === 'pydev_list_tools');
report('pydev_list_tools registered in "meta" group', !!self && self.group === 'meta', `self=${JSON.stringify(self)}`);

// eslint-disable-next-line no-console
console.log(`\n=== TOOLS TEST: Passed=${passed} Failed=${failed} ===`);
process.exit(failed === 0 ? 0 : 1);
