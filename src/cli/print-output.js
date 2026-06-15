import {
  createAntJsonOutput,
  isPrintableAntEvent,
  sanitizeAntEventForPersistence
} from "../core/events.js";

/**
 * @param {{ format: "text" | "json" | "stream-json"; includePartialMessages?: boolean; write?: (text: string) => void }} options
 */
export function createPrintEventCollector(options) {
  const events = [];
  const write = options.write ?? ((text) => process.stdout.write(text));

  return {
    /**
     * @param {Record<string, any>} event
     */
    onAntEvent(event) {
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
    formatJson(result) {
      const lastTurnResult = [...events].reverse().find((event) => event.type === "turn_result");
      return JSON.stringify(createAntJsonOutput({
        sessionId: result.sessionId,
        events,
        result: {
          status: result.status ?? lastTurnResult?.payload?.status ?? "completed",
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
