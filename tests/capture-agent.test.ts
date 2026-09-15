import { expect, test } from "bun:test";

type ResponseSpec = {
  status: number;
  body: string;
};

async function runPrecheck(responses: ResponseSpec[]) {
  let statusHits = 0;
  let healthHits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/capture-health") {
        healthHits += 1;
      } else {
        statusHits += 1;
      }
      const response = responses[Math.min(statusHits - 1, responses.length - 1)];
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    const child = Bun.spawn(["bun", "agent/capture.ts", "precheck"], {
      env: {
        ...process.env,
        OWNER_SECRET: "",
        WORK_LIVE_BASE_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { statusHits, healthHits, exitCode, stdout, stderr };
  } finally {
    server.stop();
  }
}

test("capture agent retries transient status failures once", async () => {
  const result = await runPrecheck([
    { status: 500, body: "temporary" },
    { status: 200, body: JSON.stringify({ paused: false, quiet: false }) },
  ]);

  expect(result.statusHits).toBe(2);
  expect(result.healthHits).toBe(0);
  expect(result.exitCode).toBe(0);
});

test("capture agent does not retry authentication failures and classifies them", async () => {
  const result = await runPrecheck([{ status: 401, body: "no" }]);

  expect(result.statusHits).toBe(1);
  expect(result.healthHits).toBe(0);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"failure":"authentication_failed"');
});

test("capture agent classifies storage-unavailable status failures", async () => {
  const result = await runPrecheck([{ status: 503, body: "Capture store unavailable" }]);

  expect(result.statusHits).toBe(2);
  expect(result.healthHits).toBe(0);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"failure":"storage_failed"');
});
