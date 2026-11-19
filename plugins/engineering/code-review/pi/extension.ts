import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default function codeReview(pi: ExtensionAPI) {
  for (const [command, skill, description] of [
    ["code-review", "code-review", "Review a Git change or resume an interrupted review"],
    ["code-review:adversarial", "adversarial", "Review, fix, and re-review a Git change"],
    ["code-review:setup", "setup", "Configure code review for this repository"],
  ] as const) {
    const path = fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url));
    pi.registerCommand(command, {
      description,
      handler: async (args, ctx) => {
        if (process.env.CODE_REVIEW_CHILD) throw new Error("Review workers cannot launch reviews");
        await ctx.waitForIdle();
        const model = skill !== "setup" && ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        pi.sendUserMessage([
          `Follow the manually invoked skill from ${JSON.stringify(path)}.`,
          readFileSync(path, "utf8"),
          ...(model ? [`Pi session model for review runner selection: ${model}`] : []),
          `Invocation arguments: ${JSON.stringify(args)}`,
        ].join("\n\n"));
      },
    });
  }
}
