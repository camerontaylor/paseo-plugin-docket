import { LIMITS } from "./limits";

/** Plugin id (spec section 24); every name derived from it is built here. */
export const PLUGIN_ID = "docket";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SURFACE_ID = /^s_[a-z0-9]{6}$/;
const ITEM_ID = /^[a-z][a-z0-9_]*$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Surface id: `s_` and six characters of a-z0-9 (spec 27.1). */
export function isSurfaceId(value: unknown): value is string {
  return typeof value === "string" && SURFACE_ID.test(value);
}

/** Question, block and item id: `[a-z][a-z0-9_]*`, at most 32 characters, no dots. */
export function isItemId(value: unknown): value is string {
  return typeof value === "string" && value.length <= LIMITS.idLength && ITEM_ID.test(value);
}

/** Option id: any text without a line break, at most 64 characters. */
export function isOptionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIMITS.optionIdLength &&
    !LINE_BREAK.test(value)
  );
}

/**
 * Makes a surface id unique on its host. `random` returns a number in [0, 1)
 * (`Math.random` in the server, a stub in tests), `exists` says whether an id
 * is already stored. Gives up after `attempts` collisions.
 */
export function newSurfaceId(
  random: () => number,
  exists: (id: string) => boolean,
  attempts = 50,
): string {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let id = "s_";
    for (let i = 0; i < 6; i++) id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
    if (!exists(id)) return id;
  }
  throw new Error("could not find an unused surface id");
}

/** `block.item`, or `question.item` for a review item (spec 27.1). */
export function itemAddress(owner: string, item: string): string {
  return `${owner}.${item}`;
}

/** The delivery message's first line, `[docket s_8f2k, delivery 2]` (spec 24, 8.4). */
export function deliveryHeader(surfaceId: string, delivery: number): string {
  return `[${PLUGIN_ID} ${surfaceId}, delivery ${delivery}]`;
}

/** The queue message id, `docket:<surfaceId>:<delivery number>` (spec 24). */
export function deliveryMessageId(surfaceId: string, delivery: number): string {
  return `${PLUGIN_ID}:${surfaceId}:${delivery}`;
}

/** The first line of the `docket_show` result, `[docket s_xxxxxx]` (plan D1). */
export function surfaceIdLine(surfaceId: string): string {
  return `[${PLUGIN_ID} ${surfaceId}]`;
}

/** Number of UTF-8 bytes in `text`, without `TextEncoder` (Hermes-safe). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Number of Unicode code points in `text`. */
export function charCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}
