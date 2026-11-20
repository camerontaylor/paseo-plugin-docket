// First values from spec section 27.4, to be adjusted from use. `show` refuses
// a document over a limit and says which.

export const LIMITS = {
  documentBytes: 256 * 1024,
  questions: 12,
  questionsWarnAbove: 6,
  options: 12,
  optionsWarnAbove: 7,
  reviewItems: 100,
  blocks: 60,
  blockDepth: 3,
  itemsPerBlock: 300,
  summary: 200,
  summaryWarnAbove: 140,
  context: 600,
  note: 2000,
  /** A comment, a custom answer or a text answer. */
  answer: 4000,
  loadedFileBytes: 2 * 1024 * 1024,
  evidenceBytes: 20 * 1024 * 1024,
  changesFiles: 300,
  openSurfacesPerAgent: 20,
  renderedBytes: 8 * 1024,
  // Not in the spec's table; first values chosen here.
  idLength: 32,
  optionIdLength: 64,
  verdictLength: 32,
  verdictsMin: 2,
  verdictsMax: 5,
  submitLabel: 60,
  refLength: 500,
} as const;

/** The tool input's serialised JSON schema must stay under this (plan D7). */
export const TOOL_SCHEMA_MAX_BYTES = 4000;
