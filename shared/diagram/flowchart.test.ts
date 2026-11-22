import { expect, it } from "vitest";
import { layoutFlowchart } from "./layout";
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


it.each([
  "A -.-> B", "A -.- B", "A ==> B", "A === B",
  "A -. sometimes .-> B", "A == often ==> B", "A---->B", "A----B", "A <---> B",
])("flags unsupported edge syntax for source fallback (%s)", (line) => {
  const chart = parseFlowchart(`flowchart LR\nX --> Y\n${line}`)!;
  expect(chart.skipped).toEqual([line]);
  expect(layoutFlowchart(chart).edges.map(({ from, to }) => [from, to])).toEqual([["X", "Y"]]);
});

it.each(["A --> A", "A --- A", "A --> B --> A --> A"])("falls back for a self-loop (%s)", (line) => {
  const chart = parseFlowchart(`flowchart TD\nA[Queue]\n${line}`)!;
  expect(chart.skipped).toEqual([line]);
  expect(layoutFlowchart(chart).edges).toEqual([]);
});

it("still lays out solid arrows, undirected lines, labels and cycles", () => {
  const chart = parseFlowchart("flowchart RL\nA -- yes --> B --- C\nC --> A")!;
  expect(chart.skipped).toEqual([]);
  expect(layoutFlowchart(chart).edges.map(({ from, to, label, arrowAt }) => [from, to, label, !!arrowAt])).toEqual([
    ["A", "B", "yes", true], ["B", "C", null, false], ["C", "A", null, true],
  ]);
});
