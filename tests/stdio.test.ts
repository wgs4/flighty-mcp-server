import { expect, it } from "vitest";
import { verifyStdio } from "./verify-stdio.mjs";

it("serves all 12 local reads over actual MCP stdio and preserves both inventories", async () => {
  const report = await verifyStdio({ checks: "reads", log: () => {} });
  expect(report.failures).toEqual([]);
  expect(report.passed).toHaveLength(2);
});
