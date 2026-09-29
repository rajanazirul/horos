// OFAC SDN.CSV parser (AD-21). Pure: text in, address → entity names out. Only SDN.CSV is read
// (never the XML or the consolidated list). Column 2 is the entity name, column 12 the Remarks.

/** Thrown for input that is not valid RFC 4180 CSV (e.g. an unterminated quoted field). */
export class CsvError extends Error {
  override readonly name = "CsvError";
}

/**
 * RFC 4180 tokenizer: quoted fields, `""` escapes, commas and newlines inside quotes, CRLF or LF
 * record ends. A quote inside an unquoted field is kept literally. Blank lines yield no record.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
    quotedField = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "" && !quotedField) {
      inQuotes = true;
      quotedField = true;
      i++;
    } else if (c === ",") {
      endField();
      i++;
    } else if (c === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 2;
    } else if (c === "\n" || c === "\r") {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (inQuotes) throw new CsvError("unterminated quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

const NAME_COLUMN = 1;
const REMARKS_COLUMN = 11;
const DIGITAL_CURRENCY_FEATURE = /Digital Currency Address - /iu;
const EVM_ADDRESS = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/gu;
// OFAC's placeholder for an empty field.
const EMPTY = "-0-";

/**
 * Every `0x`+40-hex token inside a `Digital Currency Address - <TICKER>` Remarks feature, lowercased,
 * mapped to the entity names it is listed under. Any ticker counts, including an empty one; non-EVM
 * addresses (XBT, TRX, ...) never match the `0x` pattern and are ignored.
 */
export function parseSdnCsv(text: string): Map<string, string[]> {
  // The published file ends with a DOS end-of-file marker (0x1A) on some exports.
  const rows = parseCsv(text.replaceAll(String.fromCharCode(0x1a), ""));
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    const remarks = row[REMARKS_COLUMN];
    if (remarks === undefined || remarks.trim() === EMPTY) continue;
    const rawName = (row[NAME_COLUMN] ?? "").trim();
    const name = rawName === EMPTY ? "" : rawName;
    for (const feature of remarks.split(";")) {
      if (!DIGITAL_CURRENCY_FEATURE.test(feature)) continue;
      for (const m of feature.matchAll(EVM_ADDRESS)) {
        const address = m[0].toLowerCase();
        let set = names.get(address);
        if (set === undefined) {
          set = new Set();
          names.set(address, set);
        }
        if (name !== "") set.add(name);
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const [address, set] of names) out.set(address, [...set].sort(compareCodeUnits));
  return out;
}

/** Deterministic, locale-free string order (UTF-16 code units). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
