/**
 * POD Resource Utilization — Cursor SDK CLI agent
 *
 * 1) Runs the CLI orchestrator (or analyzes an existing report)
 * 2) Asks a local Cursor agent to produce capacity / rightsizing recommendations
 *
 * For MCP (Cursor IDE tools), use: npm run mcp
 * Requires: CURSOR_API_KEY (CLI analyze only), Node >= 22.13, kubectl/oc for live runs
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import {
  REPO_ROOT,
  REPORTS_DIR,
  buildAnalysisPrompt,
  findLatestTextReport,
  readReportFile,
  runPodResourceReport,
  type ReportMode,
} from "./lib.js";

type CliArgs = {
  mode: ReportMode;
  namespaces: string[];
  analyzeOnly: boolean;
  reportPath?: string;
  noEmail: boolean;
  model: string;
};

function usage(): never {
  console.error(`Usage:
  npm run agent -- [--mode auto|aks-html|multicloud|both] [--no-email] <ns> [ns...]
  npm run agent -- --analyze <report.txt>
  npm run mcp                              # start MCP stdio server

Env:
  CURSOR_API_KEY   required for CLI AI analysis
  CURSOR_MODEL     optional (default: composer-2.5)
`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "auto",
    namespaces: [],
    analyzeOnly: false,
    noEmail: false,
    model: process.env.CURSOR_MODEL || "composer-2.5",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      const v = argv[++i] as ReportMode;
      if (!["auto", "aks-html", "multicloud", "both"].includes(v)) usage();
      args.mode = v;
    } else if (a === "--no-email") {
      args.noEmail = true;
    } else if (a === "--analyze" || a === "--analyze-only") {
      args.analyzeOnly = true;
      if (a === "--analyze" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
        args.reportPath = argv[++i];
      }
    } else if (a === "-h" || a === "--help") {
      usage();
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      usage();
    } else {
      args.namespaces.push(a);
    }
  }

  if (!args.analyzeOnly && args.namespaces.length === 0) usage();
  if (args.analyzeOnly && !args.reportPath) {
    console.error("--analyze requires a report file path");
    usage();
  }
  return args;
}

async function analyzeWithCursor(
  reportText: string,
  meta: Record<string, string>,
  modelId: string,
): Promise<string> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set. Export it before running the SDK agent.");
  }

  const result = await Agent.prompt(buildAnalysisPrompt(reportText, meta), {
    apiKey,
    model: { id: modelId },
    local: { cwd: REPO_ROOT },
  });

  if (result.status === "error") {
    throw new Error(`Cursor agent run failed (run id: ${result.id})`);
  }

  return result.result ?? "(no analysis text returned)";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(REPORTS_DIR, { recursive: true });

  let reportPath = args.reportPath;
  let orchestratorCode = 0;

  if (!args.analyzeOnly) {
    console.log("\n=== Running CLI orchestrator ===\n");
    const result = await runPodResourceReport({
      namespaces: args.namespaces,
      mode: args.mode,
      noEmail: args.noEmail,
      echo: true,
    });
    orchestratorCode = result.code;
    reportPath = result.textReportPath;
  }

  if (!reportPath || !existsSync(reportPath)) {
    reportPath = await findLatestTextReport();
  }

  if (!reportPath || !existsSync(reportPath)) {
    console.error(
      "No text report found to analyze. Use --mode multicloud|both, or --analyze <file>.",
    );
    process.exit(orchestratorCode || 1);
  }

  const reportText = await readReportFile(reportPath);
  const meta = {
    report: reportPath,
    mode: args.mode,
    namespaces: args.namespaces.join(" ") || "(from report)",
    model: args.model,
  };

  console.log("\n=== Cursor SDK analysis ===\n");
  let analysis: string;
  try {
    analysis = await analyzeWithCursor(reportText, meta, args.model);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`Cursor startup failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const analysisPath = path.join(
    REPORTS_DIR,
    `ai_analysis_${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
  );
  await writeFile(analysisPath, analysis, "utf8");

  console.log(analysis);
  console.log(`\nAI analysis saved: ${analysisPath}`);
  process.exit(orchestratorCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
