// Failing fixtures for the validator: each case is a valid base document with
// one mutation, and the problem it must produce. `rule` names the section-14
// bullet (or the section 27 limit) it exercises.

export type Doc = Record<string, any>;

export function base(): Doc {
  return {
    v: 1,
    summary: "Plan for the queue move.",
    context: "Plan only; nothing is changed yet.",
    questions: [
      {
        id: "queue",
        kind: "choice",
        prompt: "Which queue?",
        recommend: "pg_boss",
        options: [
          { id: "pg_boss", label: "pg-boss" },
          { id: "bullmq", label: "BullMQ" },
        ],
      },
      { id: "steps", kind: "review", prompt: "Plan steps", of: "plan", verdicts: ["do", "drop"], recommend: "do" },
    ],
    view: [
      {
        t: "plan",
        steps: [
          { id: "s1", title: "Add the jobs table" },
          { id: "s2", title: "Move the mailer", after: ["s1"] },
        ],
      },
    ],
  };
}

export interface InvalidCase {
  rule: string;
  name: string;
  mutate: (doc: Doc) => void;
  pointer: string;
  /** Text the message must contain. */
  includes: string;
}

const many = (n: number, make: (i: number) => unknown): unknown[] => Array.from({ length: n }, (_, i) => make(i));

export const INVALID_CASES: InvalidCase[] = [
  // It does not match the schema, or uses an unknown block, question kind, module or tone.
  { rule: "schema", name: "wrong version", mutate: (d) => { d.v = 2; }, pointer: "/v", includes: "must be the number 1" },
  { rule: "schema", name: "missing summary", mutate: (d) => { delete d.summary; }, pointer: "/summary", includes: "required" },
  { rule: "schema", name: "unknown top-level field", mutate: (d) => { d.sumary = "typo"; }, pointer: "/sumary", includes: "unknown field" },
  { rule: "schema", name: "unknown block type", mutate: (d) => { d.view.push({ t: "bogus" }); }, pointer: "/view/1/t", includes: "unknown block type" },
  { rule: "schema", name: "unknown question kind", mutate: (d) => { d.questions[0].kind = "bogus"; }, pointer: "/questions/0/kind", includes: "unknown question kind" },
  { rule: "schema", name: "question lacks prompt", mutate: (d) => { delete d.questions[0].prompt; }, pointer: "/questions/0/prompt", includes: "required" },
  { rule: "schema", name: "question id with a dot", mutate: (d) => { d.questions[0].id = "a.b"; }, pointer: "/questions/0/id", includes: "invalid" },
  { rule: "schema", name: "plan step lacks title", mutate: (d) => { delete d.view[0].steps[0].title; }, pointer: "/view/0/steps/0/title", includes: "required" },
  { rule: "schema", name: "plan step bad status", mutate: (d) => { d.view[0].steps[0].status = "later"; }, pointer: "/view/0/steps/0/status", includes: "must be one of" },
  { rule: "schema", name: "ref without a line", mutate: (d) => { d.view[0].steps[0].ref = "src/a.ts"; }, pointer: "/view/0/steps/0/ref", includes: "path:line" },
  { rule: "schema", name: "ref range reversed", mutate: (d) => { d.view[0].steps[0].ref = "src/a.ts:9-3"; }, pointer: "/view/0/steps/0/ref", includes: "path:line" },
  { rule: "schema", name: "code with file and s", mutate: (d) => { d.view.push({ t: "code", file: "a.ts", s: "x" }); }, pointer: "/view/1", includes: "exactly one of" },
  { rule: "schema", name: "code with neither file nor s", mutate: (d) => { d.view.push({ t: "code" }); }, pointer: "/view/1", includes: "exactly one of" },
  { rule: "schema", name: "code lines reversed", mutate: (d) => { d.view.push({ t: "code", file: "a.ts", from: 9, to: 3 }); }, pointer: "/view/1/to", includes: "before" },
  { rule: "schema", name: "changes range starts with a dash", mutate: (d) => { d.view.push({ t: "changes", of: "--output=x" }); }, pointer: "/view/1/of", includes: "not a commit or range" },
  { rule: "schema", name: "changes of with spaces", mutate: (d) => { d.view.push({ t: "changes", of: "a b" }); }, pointer: "/view/1/of", includes: "not a commit or range" },
  { rule: "schema", name: "two plans need ids", mutate: (d) => { d.view.push({ t: "plan", steps: [{ id: "x", title: "X" }] }); }, pointer: "/view/1", includes: "needs an `id`" },
  { rule: "schema", name: "verdicts too few", mutate: (d) => { d.questions[1].verdicts = ["do"]; delete d.questions[1].recommend; }, pointer: "/questions/1/verdicts", includes: "takes 2 to 5" },
  { rule: "schema", name: "choice min without multi", mutate: (d) => { d.questions[0].min = 1; }, pointer: "/questions/0/min", includes: "only with `multi`" },
  { rule: "schema", name: "submit with unknown field", mutate: (d) => { d.submit = { colour: "red" }; }, pointer: "/submit/colour", includes: "unknown field" },
  { rule: "schema", name: "review with neither of nor items", mutate: (d) => { delete d.questions[1].of; }, pointer: "/questions/1", includes: "exactly one of" },

  // A question id repeats, an option id repeats within a question, or an item id repeats within a block.
  { rule: "repeated id", name: "question id repeats", mutate: (d) => { d.questions[1].id = "queue"; }, pointer: "/questions/1/id", includes: "repeats" },
  { rule: "repeated id", name: "option id repeats", mutate: (d) => { d.questions[0].options[1].id = "pg_boss"; }, pointer: "/questions/0/options/1/id", includes: "repeats" },
  { rule: "repeated id", name: "bare option repeats", mutate: (d) => { d.questions[0].options = ["a", "a"]; delete d.questions[0].recommend; }, pointer: "/questions/0/options/1", includes: "repeats" },
  { rule: "repeated id", name: "step id repeats", mutate: (d) => { d.view[0].steps[1].id = "s1"; d.view[0].steps[1].after = []; }, pointer: "/view/0/steps/1/id", includes: "repeats" },
  { rule: "repeated id", name: "nested step id repeats", mutate: (d) => { d.view[0].steps[0].children = [{ id: "s2", title: "Inner" }]; }, pointer: "/view/0/steps/1/id", includes: "repeats" },
  { rule: "repeated id", name: "block id repeats", mutate: (d) => { d.view[0].id = "x"; d.view.push({ t: "code", id: "x", s: "y" }); d.questions[1].of = "x"; }, pointer: "/view/1/id", includes: "repeats" },
  { rule: "repeated id", name: "inline review item repeats", mutate: (d) => { d.questions[1] = { id: "steps", kind: "review", prompt: "P", items: [{ id: "a", title: "A" }, { id: "a", title: "B" }] }; }, pointer: "/questions/1/items/1/id", includes: "repeats" },

  // A `q` or `of` names nothing.
  { rule: "of names nothing", name: "review of a missing block", mutate: (d) => { d.questions[1].of = "nope"; }, pointer: "/questions/1/of", includes: "not a block of the view" },
  { rule: "of names nothing", name: "review of a block with no items", mutate: (d) => { d.view.push({ t: "code", s: "x" }); d.questions[1].of = "code"; }, pointer: "/questions/1/of", includes: "no items" },
  { rule: "of names nothing", name: "after names a missing step", mutate: (d) => { d.view[0].steps[1].after = ["s9"]; }, pointer: "/view/0/steps/1/after/0", includes: "not a step" },

  // `recommend` is not a valid answer to its question.
  { rule: "recommend", name: "choice recommends an unknown option", mutate: (d) => { d.questions[0].recommend = "redis"; }, pointer: "/questions/0/recommend", includes: "not one of this question's option ids" },
  { rule: "recommend", name: "single choice recommends a list", mutate: (d) => { d.questions[0].recommend = ["pg_boss"]; }, pointer: "/questions/0/recommend", includes: "single option id" },
  { rule: "recommend", name: "multi choice recommends a string", mutate: (d) => { d.questions[0].multi = true; }, pointer: "/questions/0/recommend", includes: "list of option ids" },
  { rule: "recommend", name: "multi choice recommends an unknown option", mutate: (d) => { d.questions[0].multi = true; d.questions[0].recommend = ["pg_boss", "zz"]; }, pointer: "/questions/0/recommend/1", includes: "not one of" },
  { rule: "recommend", name: "text recommends a number", mutate: (d) => { d.questions.push({ id: "t", kind: "text", prompt: "T", recommend: 5 }); }, pointer: "/questions/2/recommend", includes: "must be a string" },
  { rule: "recommend", name: "review recommends an unknown verdict", mutate: (d) => { d.questions[1].recommend = "maybe"; }, pointer: "/questions/1/recommend", includes: "not one of this question's verdicts" },
  { rule: "recommend", name: "review recommends an unknown item", mutate: (d) => { d.questions[1].recommend = { s9: "do" }; }, pointer: "/questions/1/recommend/s9", includes: "not an item" },
  { rule: "recommend", name: "review item verdict unknown", mutate: (d) => { d.questions[1].recommend = { s1: "nah" }; }, pointer: "/questions/1/recommend/s1", includes: "not one of this question's verdicts" },
  { rule: "recommend", name: "review default verdicts apply", mutate: (d) => { delete d.questions[1].verdicts; }, pointer: "/questions/1/recommend", includes: "\"approve\", \"change\"" },

  { rule: "recommend", name: "multi recommend below min", mutate: (d) => { Object.assign(d.questions[0], { multi: true, min: 2, recommend: ["pg_boss"] }); }, pointer: "/questions/0/recommend", includes: "at least 2" },
  { rule: "recommend", name: "multi recommend above max", mutate: (d) => { Object.assign(d.questions[0], { multi: true, max: 1, recommend: ["pg_boss", "bullmq"] }); }, pointer: "/questions/0/recommend", includes: "at most 1" },
  { rule: "recommend", name: "multi recommend repeats an option", mutate: (d) => { Object.assign(d.questions[0], { multi: true, recommend: ["pg_boss", "pg_boss"] }); }, pointer: "/questions/0/recommend/1", includes: "repeats" },
  { rule: "choice options", name: "min above the options, other false", mutate: (d) => { Object.assign(d.questions[0], { multi: true, other: false, min: 3 }); delete d.questions[0].recommend; }, pointer: "/questions/0/min", includes: "only 2 options" },
  { rule: "limit", name: "plan steps nested four deep", mutate: (d) => { d.view[0].steps = [{ id: "a", title: "A", children: [{ id: "b", title: "B", children: [{ id: "c", title: "C", children: [{ id: "d", title: "D" }] }] }] }]; d.questions[1].recommend = "do"; }, pointer: "/view/0/steps/0/children/0/children/0/children", includes: "nested at most 3 deep" },

  { rule: "schema", name: "changes paths as a string", mutate: (d) => { d.view.push({ t: "changes", paths: "src/" }); }, pointer: "/view/1/paths", includes: "must be a list of paths" },

  // The surface has questions and no `context`.
  { rule: "context", name: "questions without context", mutate: (d) => { delete d.context; }, pointer: "/context", includes: "required when there are questions" },
  { rule: "context", name: "blank context", mutate: (d) => { d.context = "  "; }, pointer: "/context", includes: "is required when there are questions" },

  // A `choice` has no options and `other` is `false`.
  { rule: "choice options", name: "no options, other false", mutate: (d) => { d.questions[0].options = []; d.questions[0].other = false; delete d.questions[0].recommend; }, pointer: "/questions/0/options", includes: "at least two options" },
  { rule: "choice options", name: "one option, other false", mutate: (d) => { d.questions[0].options = ["a"]; d.questions[0].other = false; delete d.questions[0].recommend; }, pointer: "/questions/0/options", includes: "at least two options" },
  { rule: "choice options", name: "no options, other allowed", mutate: (d) => { d.questions[0].options = []; delete d.questions[0].recommend; }, pointer: "/questions/0/options", includes: "at least one option" },

  // `revises` names no surface, or one that belongs to another agent or host.
  { rule: "revises", name: "revises is not a surface id", mutate: (d) => { d.revises = "last one"; }, pointer: "/revises", includes: "surface id" },

  // Limits (section 27.4).
  { rule: "limit", name: "13 questions", mutate: (d) => { d.questions = many(13, (i) => ({ id: `q${i}`, kind: "text", prompt: "P" })); }, pointer: "/questions", includes: "at most 12 questions" },
  { rule: "limit", name: "13 options", mutate: (d) => { d.questions[0].options = many(13, (i) => `o${i}`); delete d.questions[0].recommend; }, pointer: "/questions/0/options", includes: "at most 12 options" },
  { rule: "limit", name: "101 review items", mutate: (d) => { d.questions[1] = { id: "steps", kind: "review", prompt: "P", items: many(101, (i) => `Item ${i}`) }; }, pointer: "/questions/1/items", includes: "at most 100 items" },
  { rule: "limit", name: "61 blocks", mutate: (d) => { d.view = many(61, (i) => `Block ${i}`); d.questions = []; }, pointer: "/view", includes: "at most 60 blocks" },
  { rule: "limit", name: "301 steps", mutate: (d) => { d.view[0].steps = many(301, (i) => ({ id: `s${i}`, title: "T" })); delete d.questions[1].recommend; }, pointer: "/view/0/steps", includes: "at most 300 items" },
  { rule: "limit", name: "summary over 200", mutate: (d) => { d.summary = "x".repeat(201); }, pointer: "/summary", includes: "over 200 characters" },
  { rule: "limit", name: "context over 600", mutate: (d) => { d.context = "x".repeat(601); }, pointer: "/context", includes: "over 600 characters" },
  { rule: "limit", name: "document over 256 KiB", mutate: (d) => { d.view.push("x".repeat(256 * 1024)); }, pointer: "", includes: "256 KiB" },
  { rule: "limit", name: "option id over 64", mutate: (d) => { d.questions[0].options[0].id = "x".repeat(65); delete d.questions[0].recommend; }, pointer: "/questions/0/options/0/id", includes: "1 to 64 characters" },
  { rule: "limit", name: "id over 32", mutate: (d) => { d.questions[0].id = "q" + "x".repeat(32); }, pointer: "/questions/0/id", includes: "invalid" },
];

/** The stage-2 and stage-3 names a document may use, each refused by name. */
export interface StageCase {
  name: string;
  mutate: (doc: Doc) => void;
  pointer: string;
  stage: 2 | 3;
  includes: string;
}

export const STAGE_CASES: StageCase[] = [
  { name: "go_ahead", mutate: (d) => { d.meanwhile = "go_ahead"; }, pointer: "/meanwhile", stage: 2, includes: "`go_ahead` is not available yet" },
  { name: "until", mutate: (d) => { d.until = "merged"; }, pointer: "/until", stage: 2, includes: "`until` is not available yet" },
  { name: "use (modules)", mutate: (d) => { d.use = ["x"]; }, pointer: "/use", stage: 3, includes: "`use` is not available yet" },
  { name: "submit auto", mutate: (d) => { d.submit = { mode: "auto" }; }, pointer: "/submit/mode", stage: 2, includes: "`auto` is not available yet" },
  { name: "kind number", mutate: (d) => { d.questions[0] = { id: "n", kind: "number", prompt: "N" }; }, pointer: "/questions/0/kind", stage: 2, includes: "`number` is not available yet" },
  { name: "kind boolean", mutate: (d) => { d.questions[0] = { id: "n", kind: "boolean", prompt: "N" }; }, pointer: "/questions/0/kind", stage: 2, includes: "`boolean` is not available yet" },
  { name: "kind date", mutate: (d) => { d.questions[0] = { id: "n", kind: "date", prompt: "N" }; }, pointer: "/questions/0/kind", stage: 2, includes: "`date` is not available yet" },
  { name: "kind rank", mutate: (d) => { d.questions[0] = { id: "n", kind: "rank", prompt: "N" }; }, pointer: "/questions/0/kind", stage: 2, includes: "`rank` is not available yet" },
  { name: "kind edit", mutate: (d) => { d.questions[0] = { id: "n", kind: "edit", prompt: "N" }; }, pointer: "/questions/0/kind", stage: 2, includes: "`edit` is not available yet" },
  { name: "block compare", mutate: (d) => { d.view.push({ t: "compare" }); }, pointer: "/view/1/t", stage: 2, includes: "`compare` is not available yet" },
  { name: "block details", mutate: (d) => { d.view.push({ t: "details" }); }, pointer: "/view/1/t", stage: 2, includes: "`details` is not available yet" },
  { name: "block findings", mutate: (d) => { d.view.push({ t: "findings" }); }, pointer: "/view/1/t", stage: 2, includes: "`findings` is not available yet" },
  { name: "block ask", mutate: (d) => { d.view.push({ t: "ask", q: "queue" }); }, pointer: "/view/1/t", stage: 2, includes: "`ask` is not available yet" },
  { name: "block canvas", mutate: (d) => { d.view.push({ t: "canvas" }); }, pointer: "/view/1/t", stage: 3, includes: "`canvas` is not available yet" },
  { name: "q on a block", mutate: (d) => { d.view[0].q = "queue"; }, pointer: "/view/0/q", stage: 2, includes: "`q` is not available yet" },
  { name: "links on a step", mutate: (d) => { d.view[0].steps[0].links = [{ to: "plan.s2" }]; }, pointer: "/view/0/steps/0/links", stage: 2, includes: "`links` is not available yet" },
  { name: "option preview", mutate: (d) => { d.questions[0].options[0].preview = "x"; }, pointer: "/questions/0/options/0/preview", stage: 2, includes: "`preview` is not available yet" },
];
