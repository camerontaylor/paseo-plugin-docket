import { expect, it } from "vitest";
import { parseFlowchart } from "./flowchart";

it.each([
  "A[One] & B[Two] --> C[Three]",
  "A[One] --> B[Two] & C[Three]",
  'A["One"] & B["Two"] --> C[Three]',
  "A[[One]] & B[[Two]] --> C[Three]",
])("flags unsupported multi-node link syntax for source fallback", (line) => {
  const chart = parseFlowchart(`flowchart TD\nD --> E\n${line}`)!;
  expect(chart.skipped).toEqual([line]);
  expect(chart.edges.map(({ from, to }) => [from, to])).toEqual([["D", "E"]]);
  expect(chart.nodes.map(({ id }) => id)).toEqual(["D", "E"]);
});

it("keeps closers in quoted labels and consumes exactly one node", () => {
  const chart = parseFlowchart('flowchart TD\nA["One] two"] --> B(("Three)) four"))')!;
  expect(chart.skipped).toEqual([]);
  expect(chart.nodes.map(({ label }) => label)).toEqual(["One] two", "Three)) four"]);
});
