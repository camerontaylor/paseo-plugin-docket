import { expect, it } from "vitest";
import { parseFlowchart } from "./flowchart";
import { layoutFlowchart, layoutSequence, layoutSequenceMessage } from "./layout";
import { parseSequence } from "./sequence";

it.each([
  ["TD", "down", "up"], ["TB", "down", "up"], ["BT", "up", "down"],
  ["LR", "right", "left"], ["RL", "left", "right"],
] as const)("keeps %s long edges in bounds and enters the correct side", (orientation, forward, backward) => {
  const chart = parseFlowchart(`flowchart ${orientation}\nA --> B --> C\nA --> C\nC --> A`)!;
  const layout = layoutFlowchart(chart);
  for (const [from, to, direction] of [["A", "C", forward], ["C", "A", backward]]) {
    const edge = layout.edges.find((edge) => edge.from === from && edge.to === to)!;
    const target = layout.nodes.find(({ id }) => id === to)!;
    const vertical = direction === "up" || direction === "down";
    expect(edge.segments).toHaveLength(5);
    for (const { x, y, width, height } of edge.segments) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(layout.width);
      expect(y + height).toBeLessThanOrEqual(layout.height);
    }
    expect(edge.arrowAt).toEqual({
      direction,
      x: vertical ? target.x + target.width / 2 : target.x + (direction === "left" ? target.width : 0),
      y: vertical ? target.y + (direction === "up" ? target.height : 0) : target.y + target.height / 2,
    });
    const lane = edge.labelAt!;
    expect(vertical ? lane.x : lane.y).toBeGreaterThan(Math.max(...layout.nodes.map(
      (node) => vertical ? node.x + node.width : node.y + node.height,
    )));
  }
});

it("retains the target, line style and arrow form for each sequence message", () => {
  const sequence = parseSequence([
    "sequenceDiagram", "participant A", "participant B",
    "A->>B: Dispatch", "B-->>A: Response", "A-)B: Notify", "B--xA: Cancel", "A->B: Signal",
  ].join("\n"))!;
  expect(sequence.skipped).toEqual([]);
  const { columns } = layoutSequence(sequence.participants, sequence.events.length);
  const centers = new Map(columns.map((column) => [column.id, column.centerX]));
  const messages = sequence.events.flatMap((event) => event.kind === "message"
    ? [layoutSequenceMessage(event, centers.get(event.from)!, centers.get(event.to)!)!] : []);
  const [dispatch, response, notify, cancel, signal] = messages;
  expect(dispatch.arrow).toEqual({ kind: "filled", direction: "right", x: dispatch.width });
  expect(dispatch.strokes).toEqual([{ x: 0, width: dispatch.width }]);
  expect(response.arrow).toEqual({ kind: "filled", direction: "left", x: 0 });
  expect(response.strokes.length).toBeGreaterThan(1);
  expect(response.strokes[0].width).toBeLessThan(response.strokes[1].x);
  expect(notify.arrow).toEqual({ kind: "async", direction: "right", x: notify.width });
  expect(cancel.arrow).toEqual({ kind: "cross", direction: "left", x: 0 });
  expect(signal.arrow).toBeNull();
  expect(parseSequence("sequenceDiagram\nA->>A: Retry")?.skipped).toEqual(["A->>A: Retry"]);
});
