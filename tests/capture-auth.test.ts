import { expect, test } from "bun:test";
import { POST } from "@/app/api/capture/route";

test("capture rejects missing bearer secret before reading a frame", async () => {
  const previousSecret = process.env.CAPTURE_SECRET;
  process.env.CAPTURE_SECRET = "test-capture-secret";

  const response = await POST(
    new Request("http://localhost/api/capture", {
      method: "POST"
    })
  );

  process.env.CAPTURE_SECRET = previousSecret;
  expect(response.status).toBe(401);
});
