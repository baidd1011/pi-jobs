import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] || "done";
let buffer = "";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");

function handle(message) {
  if (message.type === "prompt") {
    if (process.env.FAKE_PI_INVOCATIONS) appendFileSync(process.env.FAKE_PI_INVOCATIONS, `${mode}\n`);
    if (process.env.FAKE_PI_CREATE) writeFileSync(join(process.cwd(), process.env.FAKE_PI_CREATE), "created by fake pi\n");
    if (mode === "done") {
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fake task complete" }] } });
      emit({ type: "agent_settled" });
    } else if (mode === "error") {
      emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "fake 401", content: [] } });
      emit({ type: "agent_settled" });
    } else if (mode === "budget" || mode === "max-turns") {
      emit({ type: "turn_end" });
    }
  } else if (message.type === "get_session_stats") {
    emit({ type: "response", command: "get_session_stats", success: true, data: { cost: mode === "budget" ? 0.5 : 0.003, tokens: { input: 10, output: 5 }, sessionFile: "fake-session.jsonl" } });
  } else if (message.type === "abort") {
    emit({ type: "agent_settled" });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    try { handle(JSON.parse(line)); } catch {}
  }
});
