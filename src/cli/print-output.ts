import {
  createAntJsonOutput,
  isPrintableAntEvent,
  sanitizeAntEventForPersistence
} from "../core/events.ts";

type PrintEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * @param {{ format: "text" | "json" | "stream-json"; includePartialMessages?: boolean; write?: (text: string) => void }} options
 */
export function createPrintEventCollector(options: { format: "text" | "json" | "stream-json"; includePartialMessages?: boolean; write?: (text: string) => void }) {
  const events: PrintEvent[] = [];
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  return {
    /**
     * @param {Record<string, any>} event
     */
    onAntEvent(event: Record<string, unknown>) {
      if (!isPrintableAntEvent(event, { includePartialMessages: options.includePartialMessages })) {
        return;
      }
      const printable = sanitizeAntEventForPersistence(event);
      if (!printable) {
        return;
      }
      if (options.format === "stream-json") {
        write(`${JSON.stringify(printable)}\n`);
        return;
      }
      events.push(printable);
    },
    /**
     * @param {{ sessionId: string; output: string; status?: string }} result
     */
    formatJson(result: { sessionId: string; output: string; status?: string }) {
      const lastTurnResult = [...events].reverse().find((event) => event.type === "turn_result");
      const lastPayload = asRecord(lastTurnResult?.payload);
      return JSON.stringify(createAntJsonOutput({
        sessionId: result.sessionId,
        events,
        result: {
          status: result.status ?? lastPayload.status ?? "completed",
          output: result.output,
          outputBytes: Buffer.byteLength(result.output ?? "", "utf8")
        }
      }), null, 2);
    },
    get events() {
      return events;
    }
  };
}
