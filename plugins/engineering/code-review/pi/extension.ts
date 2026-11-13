import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(resolve(plugin, "references/portable-workflow.md"), "utf8");
const entry = resolve(plugin, "scripts/review.py");
const tool = "code_review_round";
const modes = ["normal", "adversarial", "resume", "setup"] as const;
type Mode = typeof modes[number];

const parameters = Type.Object({
  operation: Type.Union([Type.Literal("run"), Type.Literal("resume"), Type.Literal("next")]),
  kind: Type.Optional(Type.Union([
    Type.Literal("working-tree"), Type.Literal("staged"), Type.Literal("files"),
    Type.Literal("commit"), Type.Literal("branch"),
  ])),
  values: Type.Optional(Type.Array(Type.String())),
  description: Type.Optional(Type.String()),
  spec: Type.Optional(Type.Array(Type.String())),
  spec_context: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Integer({ minimum: 0 })),
  max_rounds: Type.Optional(Type.Integer({ minimum: 1 })),
  run_dir: Type.Optional(Type.String()),
  fixed: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
  known_issues: Type.Optional(Type.String()),
});
type Arguments = typeof parameters.static;

function flags(args: Arguments, keys: (keyof Arguments)[]): string[] {
  return keys.flatMap((key) => {
    const value = args[key];
    return value === undefined ? [] : (Array.isArray(value) ? value : [value])
      .map((item) => `--${key.replaceAll("_", "-")}=${item}`);
  });
}

function launch(argv: string[], cwd: string, signal: AbortSignal | undefined,
                update: (line: string) => void): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(new Error("Review cancelled"));
  return new Promise((resolveResult, reject) => {
    const child = spawn("python3", ["-B", entry, "--repo", cwd, ...argv], {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    let output = "";
    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) update(line);
    });
    child.once("error", reject);
    child.once("close", (status) => {
      signal?.removeEventListener("abort", abort);
      try {
        resolveResult(JSON.parse(output));
      } catch {
        reject(new Error(pending || `Review process exited ${status} without a result`));
      }
    });
  });
}

export default function codeReview(pi: ExtensionAPI) {
  let active: {
    mode: Mode;
    session: string;
    model?: string;
    currentRound?: string;
    started: boolean;
  } | undefined;

  function deactivate() {
    if (!active) return;
    active = undefined;
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== tool && name !== "code_review_prompt"));
  }

  pi.on("session_shutdown", deactivate);
  pi.on("agent_end", deactivate);

  for (const [name, mode] of [
    ["code-review", "normal"], ["code-review:adversarial", "adversarial"],
    ["code-review:setup", "setup"],
  ] as const) {
    pi.registerCommand(name, {
      description: "Review an explicit Git change in the current session",
      handler: async (raw, ctx) => {
        if (process.env.CODE_REVIEW_CHILD) throw new Error("Review workers cannot launch reviews");
        await ctx.waitForIdle();
        const args = raw.trim();
        const resume = mode === "normal" && /^resume(?:\s|$)/.test(args);
        const selected = resume ? "resume" : mode;
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const input = resume ? args.slice("resume".length).trim() : args;
        const instruction = [
          `The user explicitly invoked code-review in ${selected} mode.`,
          `Command arguments: ${JSON.stringify(input)}.`,
          `Plugin references are in ${resolve(plugin, "references")}.`,
          "Follow the procedure below. In Pi, call code_review_round with operation run, resume,",
          "or next in place of review_run, review_resume, or review_next. The tool supplies the",
          "current Git workspace and waits for the result. If more information is needed, ask",
          "through the code_review_prompt tool while this invocation is active.",
          "When calling code_review_prompt, use a short question and explicit choices where possible.",
          "", workflow,
        ].join("\n");
        active = { mode: selected, session: ctx.sessionManager.getSessionId(), model, started: false };
        pi.setActiveTools([...new Set([...pi.getActiveTools(), tool, "code_review_prompt"])]);
        pi.sendUserMessage(instruction);
      },
    });
  }

  pi.registerTool({
    name: "code_review_prompt",
    label: "Code review question",
    description: "Ask the user for target, spec, resume selection or setup values during an explicit code review.",
    defaultActive: false,
    parameters: Type.Object({
      question: Type.String(),
      choices: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      if (!active || active.session !== ctx.sessionManager.getSessionId() || !ctx.hasUI) {
        return { content: [{ type: "text", text: "Ask the user in the conversation." }], details: {} };
      }
      const answer = args.choices?.length
        ? await ctx.ui.select(args.question, args.choices)
        : await ctx.ui.input(args.question);
      return { content: [{ type: "text", text: JSON.stringify({ answer: answer ?? null }) }], details: {} };
    },
  });

  pi.registerTool({
    name: tool,
    label: "Code review round",
    description: "Execute one read-only round after an explicit code-review slash command.",
    defaultActive: false,
    parameters,
    async execute(_id, args, signal, onUpdate, ctx) {
      const call = active;
      if (!call || call.session !== ctx.sessionManager.getSessionId() || call.mode === "setup") {
        throw new Error("Start the review with an explicit /code-review command");
      }
      let argv: string[];
      if (args.operation === "run") {
        if (call.started || call.mode === "resume" || !args.kind) {
          throw new Error("The invocation requires one explicit new review target");
        }
        argv = ["run", "--backend", "pi", "--mode", call.mode,
          ...flags(args, ["spec", "spec_context", "description", "concurrency", "max_rounds"])];
        if (call.model) argv.push("--active-model", call.model);
        argv.push("--", args.kind, ...(args.values ?? []));
      } else if (args.operation === "resume") {
        if (call.mode !== "resume" || call.started) throw new Error("Use /code-review resume");
        argv = ["resume", "--", ...(args.run_dir ? [args.run_dir] : [])];
      } else {
        if (!call.currentRound || call.currentRound !== args.run_dir) {
          throw new Error("Pass the current review round to continue the adversarial loop");
        }
        argv = ["next", ...flags(args, ["fixed", "known_issues"]), "--", call.currentRound];
      }
      const result = await launch(argv, ctx.cwd, signal, (line) => {
        onUpdate?.({ content: [{ type: "text", text: line }], details: {} });
      });
      if (result.status === "completed") {
        call.started = true;
        call.currentRound = String(result.run_dir);
      } else if (result.status === "incomplete") {
        deactivate();
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
