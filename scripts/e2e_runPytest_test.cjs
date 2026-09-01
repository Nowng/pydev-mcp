/* Temporary E2E harness for runPytestTests path-resolution + execution. */
const fs = require("node:fs/promises");
(async () => {
  const base = "/home/sensei/Workspace";
  await fs.mkdir(base + "/remove_boxes/src", { recursive: true });
  await fs.writeFile(base + "/remove_boxes/src/main.py", "def add(a, b):\n    return a + b\n");
  const resolved = base + "/remove_boxes/tests/test_main.py";
  await fs.mkdir(base + "/remove_boxes/tests", { recursive: true });
  await fs.writeFile(
    resolved,
    "import os, sys\nd = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(d, '..'))\nimport main\n\ndef test_add():\n    assert main.add(2, 3) == 5\ntest_main.py"
  );
  // Load the tool directly from src via tsx-friendly require.
  const ptp = (await import("../src/utils/pythonTestRunner.ts")).runPytestTests;
  const r = await ptp({ testFileOrPath: "tests/test_main.py", additionalArgs: undefined, timeoutMs: 30000, pythonExecutable: "", stdin: "", workDirectory: "" });
  console.log("SUMMARY:", JSON.stringify(r.summary));
  console.log("RESULT [2 passed]:", String(r.summary).includes("2 passed"));
  process.exit(String(r.summary).includes("2 passed") ? 0 : 1);
})().catch((e) => { console.error("ERR", e && e.stack || e); process.exit(1); });
