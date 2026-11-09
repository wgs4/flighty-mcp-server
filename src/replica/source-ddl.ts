import { createReplicaError } from "./cleanup.js";

type Token = { kind: "word" | "quoted" | "string" | "number" | "symbol"; text: string };
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;
function invalid(): never {
  throw createReplicaError("SOURCE_SCHEMA_INVALID", "Source table contains unsupported schema expressions or defaults.");
}

/** Only tokens outside quoted identifiers/literals carry schema authority. */
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  for (let i = 0;i < sql.length;) {
    if (/\s/.test(sql[i])) { i++; continue; }
    const start = i, ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const end = ch === "[" ? "]" : ch;
      let closed = false;
      for (i++;i < sql.length;i++) {
        if (sql[i] !== end) continue;
        if (ch !== "[" && sql[i + 1] === end) { i++; continue; }
        i++; closed = true; break;
      }
      if (!closed) invalid();
      result.push({ kind: ch === "'" ? "string" : "quoted", text: sql.slice(start, i) });
      continue;
    }
    if (sql.startsWith("--", i) || sql.startsWith("/*", i)) invalid();
    const number = NUMBER.exec(sql.slice(i));
    if (number) { i += number[0].length; result.push({ kind: "number", text: number[0] }); continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (word) { i += word[0].length; result.push({ kind: "word", text: word[0].toUpperCase() }); continue; }
    if (!"(),.+-;".includes(ch)) invalid();
    result.push({ kind: "symbol", text: ch }); i++;
  }
  return result;
}
function literalEnd(input: readonly Token[], index: number): number {
  const token = input[index];
  if (!token) invalid();
  if (token.kind === "string" || token.kind === "number" || (token.kind === "word" && token.text === "NULL")) return index + 1;
  if ((token.text === "+" || token.text === "-") && input[index + 1]?.kind === "number") return index + 2;
  return invalid();
}
export function assertSafeSourceDdl(sql: string): void {
  const input = tokens(sql);
  if (input[0]?.text !== "CREATE" || input[1]?.text !== "TABLE") invalid();
  const forbidden = new Set(["CHECK", "GENERATED", "VIRTUAL", "REFERENCES", "COLLATE", "AS"]);
  for (let i = 0;i < input.length;i++) {
    const token = input[i];
    if (token.kind !== "word") continue;
    if (forbidden.has(token.text)) invalid();
    if (token.text !== "DEFAULT") continue;
    const end = literalEnd(input, i + 1), next = input[end];
    if (!next || !((next.kind === "symbol" && [",", ")", ";"].includes(next.text)) || (next.kind === "word" && ["NOT", "NULL", "PRIMARY", "UNIQUE", "CONSTRAINT"].includes(next.text)))) invalid();
    i = end - 1;
  }
}
export function assertSafeSourceDefault(value: unknown): void {
  if (value === null) return;
  if (typeof value !== "string" || value.length > 65536) invalid();
  const input = tokens(value);
  if (literalEnd(input, 0) !== input.length) invalid();
}
