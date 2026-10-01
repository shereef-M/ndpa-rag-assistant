// Ingestion stages 1-3: read extracted text, clean it, split into sections with metadata.
const fs = require("fs");
const path = require("path");

const INPUT = path.join(__dirname, "..", "data", "processed", "ndpa-2023.txt");
const OUTPUT = path.join(__dirname, "..", "data", "processed", "sections.json");
const TOTAL_SECTIONS = 66;

const lines = fs
  .readFileSync(INPUT, "utf8")
  .replace(/\f/g, "\n")
  .split("\n")
  .map((l) => l.trim());

// ---------- helpers ----------
const NOISE = [
  /^A \d{3}$/, // gazette page numbers
  /^20(22|23) No\. 37$/, // gazette running header
  /^Nigeria Data Protection Act, 2023$/, // gazette running header
  /^Commencement\.?$/, // margin note on s.1
  /^Act No\. \d+,?$/, // margin citation (Child's Right Act)
  /^\d{4}$/,
  /^Schedule$/, // margin cross-reference (s.8)
  /^Cap\. [A-Z]\d+,?$/, // margin statute citation (s.54)
  /^LFN, \d{4}$/, // margin statute citation (s.54)                         // margin citation year
];
const isNoise = (l) => NOISE.some((re) => re.test(l));
const isPartLine = (l) => /^PART [IVXL]+\s*—/.test(l);
const isUpperContinuation = (l) =>
  l.length > 3 && /[A-Z]/.test(l) && l === l.toUpperCase();
const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
const cleanChars = (s) => s.replace(/[^\x20-\x7E’‘“”—–]/g, "");

// ---------- 1. Parse the Arrangement of Sections: titles + Part per section ----------
const arrStart = lines.findIndex((l) => l === "ARRANGEMENT OF SECTIONS");
const arrEnd = lines.findIndex((l, i) => i > arrStart && l === "SCHEDULE");
const titles = {};
const partOf = {};
let currentPart = null;
let lastWasPart = false;

for (let i = arrStart + 1; i < arrEnd; i++) {
  const l = lines[i];
  if (!l || isNoise(l) || l === "Section :") continue;
  if (isPartLine(l)) {
    currentPart = l;
    lastWasPart = true;
    continue;
  }
  const m = l.match(/^(\d+)\.\s+(.+)$/);
  if (m) {
    titles[+m[1]] = m[2];
    partOf[+m[1]] = currentPart;
    lastWasPart = false;
    continue;
  }
  if (lastWasPart && isUpperContinuation(l)) currentPart += " " + l;
}
for (const n in partOf) partOf[n] = partOf[n].replace(/\s*—\s*/, " — ");

// ---------- 2. Isolate the body: ENACTED by ... SCHEDULE ----------
const enactedIdx = lines.findIndex((l) => l.startsWith("ENACTED by"));
const bodyEnd = lines.findIndex((l, i) => i > enactedIdx && l === "SCHEDULE");
if (bodyEnd === -1)
  console.warn("WARNING: SCHEDULE heading not found; body runs to end of file");
const body = lines.slice(
  enactedIdx + 1,
  bodyEnd === -1 ? lines.length : bodyEnd,
);

// ---------- 3a. Clean pass 1: drop noise lines and Part headings ----------
const pass1 = [];
for (let i = 0; i < body.length; i++) {
  const l = cleanChars(body[i]).trim();
  if (!l || isNoise(l)) continue;
  if (isPartLine(l)) {
    while (i + 1 < body.length && isUpperContinuation(body[i + 1].trim())) i++;
    continue;
  }
  pass1.push(l);
}

// ---------- 3b. Clean pass 2: drop margin notes (runs of lines that spell a known title) ----------
// Margin notes whose wording differs from the Arrangement title (gazette quirks)
const MARGIN_VARIANTS = ["Fund of the Commission"]; // s.19 is "Funds of the Commission" in the Arrangement
const titleNorms = new Set(
  [...Object.values(titles), ...MARGIN_VARIANTS].map(norm),
);
const drop = new Set();
for (let i = 0; i < pass1.length; i++) {
  if (!/^[A-Z]/.test(pass1[i])) continue; // margin notes start with a capital; protects words like "consent."
  let joined = "";
  for (let k = 0; k < 8 && i + k < pass1.length; k++) {
    joined += norm(pass1[i + k]);
    if (titleNorms.has(joined)) {
      for (let j = i; j <= i + k; j++) drop.add(j);
      break;
    }
  }
}
const pass2 = pass1.filter((_, i) => !drop.has(i));

// ---------- 4. Segment into sections (must be sequential) ----------
const sections = [];
let current = null;
for (const l of pass2) {
  const m = l.match(/^(\d+)\.(—|\s)/);
  const expected = current ? current.section + 1 : 1;
  if (m && +m[1] === expected) {
    current = { section: expected, lines: [l] };
    sections.push(current);
  } else if (current) {
    current.lines.push(l);
  }
}

// ---------- 5. Cross-reference extraction ----------
function extractRefs(text, self) {
  const secs = new Set();
  const secRe =
    /\bsections?\s+((?:\d+\s*(?:\([^)]*\)\s*)*(?:,|or|and|to)?\s*)+)/gi;
  let m;
  while ((m = secRe.exec(text))) {
    const nums = m[1].replace(/\([^)]*\)/g, "").match(/\d+/g) || [];
    for (const n of nums.map(Number))
      if (n >= 1 && n <= TOTAL_SECTIONS && n !== self) secs.add(n);
  }
  const parts = new Set();
  const partRe = /\bPart\s+([IVXL]+)\b/g;
  while ((m = partRe.exec(text))) parts.add(m[1]);
  return { sections: [...secs].sort((a, b) => a - b), parts: [...parts] };
}

const out = sections.map((s) => {
  const text = s.lines.join("\n");
  return {
    section: s.section,
    title: titles[s.section] || null,
    part: partOf[s.section] || null,
    text,
    references: extractRefs(text, s.section),
    chars: text.length,
  };
});
fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));

// ---------- 6. Diagnostic report ----------
const found = new Set(out.map((s) => s.section));
const missing = [];
for (let n = 1; n <= TOTAL_SECTIONS; n++) if (!found.has(n)) missing.push(n);
const lens = out.map((s) => s.chars);

console.log(`Titles parsed: ${Object.keys(titles).length}/${TOTAL_SECTIONS}`);
console.log(`Sections found: ${out.length}/${TOTAL_SECTIONS}`);
console.log(`Missing: ${missing.length ? missing.join(", ") : "none"}`);
console.log(
  `Chars: min ${Math.min(...lens)}, max ${Math.max(...lens)}, avg ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}`,
);
console.log(
  "Longest:",
  [...out]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5)
    .map((s) => `s.${s.section} (${s.chars})`)
    .join(", "),
);

const suspects = [];
for (const s of out)
  for (const l of s.text.split("\n"))
    if (l.length < 25 && !/([.;,:—)]|\band|\bor)$/.test(l))
      suspects.push(`s.${s.section}: "${l}"`);

console.log(`Suspect leftover lines (${suspects.length}):`);
suspects.slice(0, 40).forEach((x) => console.log("  " + x));
