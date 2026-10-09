import { expect, test } from "bun:test";
import { readManualCounts, type ManualCounts } from "@/lib/ledger-fields";
import {
  buildOutreachFunnel,
  followUpsDue,
  splitStartDay,
} from "@/lib/outreach-funnel";
import { dayRange } from "@/lib/ledger";

type Day = { day: string; inRange: boolean } & ManualCounts;

function days(
  from: string,
  to: string,
  logged: Record<string, Partial<ManualCounts>> = {},
): Day[] {
  return dayRange(from, to).map((day) => ({
    day,
    inRange: true,
    ...readManualCounts(logged[day] ?? {}),
  }));
}

test("pre-split history never starts the pipeline", () => {
  // The 26 acceptances logged Sep 16-18 predate any per-channel count.
  const history = days("2026-09-14", "2026-10-08", {
    "2026-09-16": { connections: 5, followUpsSent: 6, reachouts: 22 },
    "2026-09-17": { connections: 14, followUpsSent: 10 },
  });
  expect(splitStartDay(history)).toBeNull();
  const funnel = buildOutreachFunnel(history, "2026-10-08");
  expect(funnel.fromDay).toBeNull();
  expect(funnel.headline).toBe(
    "Starts when you log your first email or LinkedIn request.",
  );
  expect(followUpsDue(history, history.length - 1, null)).toBeNull();
});

test("the window starts at the split, so earlier acceptances cannot read as unmessaged", () => {
  const history = days("2026-09-14", "2026-10-08", {
    "2026-09-17": { connections: 14 },
    "2026-10-05": { connectionRequests: 40 },
  });
  const funnel = buildOutreachFunnel(history, "2026-10-08");
  expect(funnel.fromDay).toBe("2026-10-05");
  expect(funnel.linkedin.map((step) => step.count)).toEqual([40, 0, 0, 0, 0]);
});

test("a low reply rate with every acceptance messaged blames the message", () => {
  const history = days("2026-09-07", "2026-10-02", {
    "2026-09-07": {
      connectionRequests: 100,
      connections: 35,
      linkedinMessages: 35,
      linkedinReplies: 5,
      linkedinMeetings: 3,
    },
  });
  const funnel = buildOutreachFunnel(history, "2026-10-02");
  expect(funnel.linkedin.map((step) => step.status)).toEqual([
    null,
    "on target",
    "on target",
    "low",
    "not enough yet",
  ]);
  expect(funnel.headline).toBe(
    "14% of people you message reply (target 50%). Your first message isn't landing.",
  );
});

test("an unsent backlog is named before the message is blamed", () => {
  const history = days("2026-09-07", "2026-10-02", {
    "2026-09-07": {
      connectionRequests: 100,
      connections: 35,
      linkedinMessages: 12,
      linkedinReplies: 2,
    },
  });
  const funnel = buildOutreachFunnel(history, "2026-10-02");
  expect(funnel.linkedin[2].status).toBe("low");
  expect(funnel.headline).toBe(
    "You've messaged 12 of 35 people who accepted. Send those first messages before judging replies.",
  );
});

test("stages under ten in their denominator say not enough yet", () => {
  const history = days("2026-10-05", "2026-10-08", {
    "2026-10-05": { connectionRequests: 8, connections: 1 },
  });
  const funnel = buildOutreachFunnel(history, "2026-10-08");
  expect(funnel.linkedin[1]).toMatchObject({
    count: 1,
    status: "not enough yet",
  });
  expect(funnel.headline).toBe(
    "Not enough LinkedIn data yet to judge. Keep logging.",
  );
});

test("the window is the last 28 days", () => {
  const history = days("2026-09-01", "2026-10-08", {
    "2026-09-01": { emailsSent: 500 },
    "2026-09-11": { emailsSent: 10, emailReplies: 2 },
    "2026-10-08": { emailsSent: 20, emailFollowUps: 4 },
  });
  const funnel = buildOutreachFunnel(history, "2026-10-08");
  expect(funnel.fromDay).toBe("2026-09-11");
  expect(funnel.email.map((step) => [step.count, step.status])).toEqual([
    [30, null],
    [2, "no target"],
    [0, "not enough yet"],
  ]);
  expect(funnel.emailFollowUps).toBe(4);
});

test("email follow-ups fall due three weekdays after the send", () => {
  // Mon Oct 5 -> Thu Oct 8; Wed Oct 7 -> Mon Oct 12 (skips the weekend).
  const history = days("2026-10-05", "2026-10-12", {
    "2026-10-05": { emailsSent: 30 },
    "2026-10-07": { emailsSent: 25 },
  });
  const dueOn = (day: string) =>
    followUpsDue(
      history,
      history.findIndex((entry) => entry.day === day),
      "2026-10-05",
    );
  expect(dueOn("2026-10-08")?.emailFollowUps).toBe(30);
  expect(dueOn("2026-10-09")?.emailFollowUps).toBe(0);
  expect(dueOn("2026-10-12")?.emailFollowUps).toBe(25);
  expect(dueOn("2026-10-10")).toBeNull(); // Saturday: nothing is due
});

test("LinkedIn first messages due are acceptances not yet messaged", () => {
  const history = days("2026-10-05", "2026-10-08", {
    "2026-10-05": { connectionRequests: 30, connections: 4 },
    "2026-10-06": { connections: 3, linkedinMessages: 4 },
    "2026-10-08": { connections: 2, linkedinMessages: 1 },
  });
  const due = followUpsDue(history, 3, "2026-10-05");
  // 9 accepted through today, 4 messaged before today: 5 due; today's 1 counts as done, not as due.
  expect(due?.linkedinMessages).toBe(5);
});
