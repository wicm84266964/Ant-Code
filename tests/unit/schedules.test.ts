import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createScheduleRecord,
  describeCadence,
  listSchedules,
  nextScheduleRunAt,
  parseScheduleCadence,
  parseScheduleInteger,
  parseScheduleTime,
  scheduleFireDecision,
  writeSchedule
} from "../../src/schedules/store.ts";
import { scheduleCreateTool } from "../../src/schedules/tools.ts";

test("a one-time schedule fires five minutes later and does not repeat", () => {
  const now = Date.parse("2026-10-17T09:00:00.000Z");
  const cadence = parseScheduleCadence({ cadence: "once", delayMinutes: 5, now });
  assert.equal(cadence.ok, true);
  if (!cadence.ok || cadence.cadence.type !== "once") return;
  assert.equal(cadence.cadence.at, "2026-10-17T09:05:00.000Z");
  const record = createScheduleRecord({
    title: "五分钟后提醒",
    prompt: "检查刚才的任务",
    permissionMode: "plan",
    sessionId: "session-1",
    cadence: cadence.cadence,
    timeZone: "UTC",
    now
  });
  assert.equal(record.nextRunAt, "2026-10-17T09:05:00.000Z");
  const waiting = scheduleFireDecision(record, now + 60_000, null);
  assert.equal(waiting.action, "wait");
  const due = scheduleFireDecision(record, now + 5 * 60_000, { running: false, goalEnabled: false, queued: false });
  assert.equal(due.action, "fire");
  if (due.action === "fire") assert.equal(due.once, true);
});

test("schedule time accepts a Chinese colon and fullwidth digits", () => {
  assert.equal(parseScheduleTime("０９：００"), "09:00");
  assert.equal(parseScheduleTime("9:5"), "09:05");
  assert.equal(parseScheduleInteger("１５。"), 15);
});

test("daily schedule lands on the next local time", () => {
  const cadence = parseScheduleCadence({ cadence: "daily", time: "09:00" });
  assert.equal(cadence.ok, true);
  if (!cadence.ok) return;
  const now = Date.parse("2026-10-17T01:30:00.000Z");
  const next = nextScheduleRunAt(cadence.cadence, "UTC", now);
  assert.equal(next, "2026-10-17T09:00:00.000Z");
  assert.equal(describeCadence(cadence.cadence), "每天 09:00");
});

test("weekly schedule skips to the requested weekday", () => {
  const cadence = parseScheduleCadence({ cadence: "weekly", weekday: "周一", time: "08:15" });
  assert.equal(cadence.ok, true);
  if (!cadence.ok) return;
  const now = Date.parse("2026-10-17T12:00:00.000Z");
  const next = Date.parse(nextScheduleRunAt(cadence.cadence, "UTC", now));
  assert.equal(new Date(next).getUTCDay(), 1);
  assert.ok(next > now);
});

test("a running session skips the due prompt and advances the clock", () => {
  const record = createScheduleRecord({
    title: "早间检查",
    prompt: "看看失败记录",
    permissionMode: "plan",
    sessionId: "session-1",
    cadence: { type: "interval", everyMinutes: 30 },
    timeZone: "UTC",
    now: Date.parse("2026-10-17T00:00:00.000Z")
  });
  record.nextRunAt = "2026-10-17T00:10:00.000Z";
  const decision = scheduleFireDecision(record, Date.parse("2026-10-17T00:20:00.000Z"), {
    running: true,
    goalEnabled: false,
    queued: false
  });
  assert.equal(decision.action, "skip");
  if (decision.action !== "skip") return;
  assert.equal(decision.reason, "上次任务仍在运行，本轮跳过");
  assert.ok(Date.parse(decision.nextRunAt) > Date.parse("2026-10-17T00:20:00.000Z"));
});

test("schedule creation waits for confirmation and then writes one record", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ant-code-schedules-"));
  try {
    const declined = await scheduleCreateTool({
      title: "早间检查",
      prompt: "列出昨晚的失败",
      cadence: "daily",
      time: "09:00"
    }, {
      cwd,
      sessionId: "session-1",
      policy: { fullAccess: false },
      askUser: async () => ({ selectedChoice: "cancel", cancelled: false })
    });
    assert.equal(declined.ok, false);
    assert.equal((await listSchedules(cwd)).length, 0);

    const created = await scheduleCreateTool({
      title: "早间检查",
      prompt: "列出昨晚的失败",
      cadence: "daily",
      time: "09:00",
      permissionMode: "fullAccess"
    }, {
      cwd,
      sessionId: "session-1",
      policy: { fullAccess: false },
      askUser: async () => ({ selectedChoice: "confirm" }),
      timeZone: "UTC",
      now: Date.parse("2026-10-17T01:00:00.000Z")
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const saved = await listSchedules(cwd);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].permissionMode, "fullAccess");
    assert.equal(saved[0].sessionId, "session-1");
    assert.equal(saved[0].nextRunAt, "2026-10-17T09:00:00.000Z");
    await writeSchedule(cwd, saved[0]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
