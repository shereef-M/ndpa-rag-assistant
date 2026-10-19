// Full eval: all 30 test questions through ask() (both guardrails active),
// then an LLM judge (a different model from the generator) scores faithfulness and correctness.
// Resumable: per-question results are saved immediately; rerun to continue after a failure.
const fs = require("fs");
const path = require("path");
const { ask, closeConnection } = require("../src/services/ask");
const { embedQuery } = require("../src/services/retrieval");
const TESTSET = require("./testset.json");

const STRATEGY = process.argv[2] || "section-v1";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "n/a");

// ---------- caches ----------
const CACHE_DIR = path.join(__dirname, ".cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });
const EMB_FILE = path.join(CACHE_DIR, "query-embeddings.json");
const PROGRESS_FILE = path.join(
  CACHE_DIR,
  `full-eval-progress-${STRATEGY}.json`,
);
const embCache = fs.existsSync(EMB_FILE)
  ? JSON.parse(fs.readFileSync(EMB_FILE, "utf8"))
  : {};
const progress = fs.existsSync(PROGRESS_FILE)
  ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"))
  : {};
const embKey = (q) =>
  `${process.env.EMBEDDING_MODEL}|${process.env.EMBEDDING_DIM}|${q}`;

// ---------- judge ----------
const JUDGE_PROMPT = `You are a strict evaluator of answers about the Nigeria Data Protection Act 2023.

You receive: a question, the Act sections the answer cited, the answer, and (if available) a reference answer written by a human who verified it against the Act.

Judge two things independently:

1. faithfulness: is every claim in the answer supported by the provided sections?
   - "faithful": every claim is supported, including any section or subsection numbers cited.
   - "minor_issue": the substance is supported, but there is a small error, such as a wrong subsection number or a slight extrapolation beyond the text.
   - "unfaithful": the answer makes a claim the sections do not support, or that contradicts them.
   List each unsupported or inaccurate claim in "unsupported_claims".

2. correctness: compared to the reference answer, does the answer cover its key points?
   - "correct": covers the key points.
   - "partial": correct as far as it goes, but misses one or more key points.
   - "incorrect": wrong, or contradicts the reference.
   - "n/a": no reference answer was provided.
   List missing key points in "missing_points".

Judge only against the provided sections and reference. Do not use outside knowledge.

Respond with a JSON object only:
{"faithfulness": "faithful"|"minor_issue"|"unfaithful", "unsupported_claims": string[], "correctness": "correct"|"partial"|"incorrect"|"n/a", "missing_points": string[], "notes": string}`;

async function callJudge(messages, attempt = 1) {
  const retry = async (reason) => {
    if (attempt >= 5)
      throw new Error(`Judge failed after ${attempt} attempts: ${reason}`);
    const wait = 2 ** attempt * 1000;
    console.warn(
      `\n  judge retryable error (${reason}), retrying in ${wait / 1000}s`,
    );
    await sleep(wait);
    return callJudge(messages, attempt + 1);
  };
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        reasoning_effort: "medium",
        include_reasoning: false,
      }),
    });
  } catch (err) {
    return retry(err.message);
  }
  if (res.status === 429 || res.status >= 500)
    return retry(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`Judge HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function judge(q, result) {
  const sources = result.citations.length
    ? result.citations
        .map((c) => `[Section ${c.section}: ${c.title}]\n${c.text}`)
        .join("\n\n---\n\n")
    : "(no sections cited)";
  const user = [
    `Question: ${q.question}`,
    `Cited sections:\n\n${sources}`,
    `Answer: ${result.answer}`,
    `Reference answer: ${q.expected_answer || "(none provided)"}`,
  ].join("\n\n===\n\n");
  return callJudge([
    { role: "system", content: JUDGE_PROMPT },
    { role: "user", content: user },
  ]);
}

// ---------- run ----------
async function main() {
  let i = 0;
  for (const q of TESTSET) {
    i++;
    if (progress[q.id]) continue; // already done in an earlier run

    let queryVector = embCache[embKey(q.question)];
    if (!queryVector) {
      queryVector = await embedQuery(q.question);
      embCache[embKey(q.question)] = queryVector;
      fs.writeFileSync(EMB_FILE, JSON.stringify(embCache));
    }

    const result = await ask(q.question, { strategy: STRATEGY, queryVector });
    let judgement = null;
    if (result.status !== "refused") {
      await sleep(DELAY_MS);
      judgement = await judge(q, result);
    }

    progress[q.id] = {
      id: q.id,
      type: q.type,
      subtype: q.subtype || null,
      status: result.status,
      reason: result.reason,
      answer: result.answer,
      cited: result.generation ? result.generation.cited : [],
      topScore: result.retrieval.topScore,
      inlineCitation:
        result.status !== "refused"
          ? /\bs\.\s?\d+|\bsections?\s+\d+/i.test(result.answer)
          : null,
    };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2)); // save immediately
    console.log(
      `${String(i).padStart(2)}/30 ${q.id} ${result.status}${judgement ? ` | ${judgement.faithfulness} | ${judgement.correctness}` : ""}`,
    );
    await sleep(DELAY_MS);
  }

  report();
}

function report() {
  const rows = TESTSET.map((q) => progress[q.id]);
  const ans = rows.filter((r) => r.type === "answerable");
  const una = rows.filter((r) => r.type === "unanswerable");
  const judged = rows.filter((r) => r.judgement);
  const n = (arr, f) => arr.filter(f).length;

  console.log("\nPER QUESTION");
  console.log(
    "id    status          reason                  faithfulness  correctness  inline-cite",
  );
  for (const r of rows) {
    const j = r.judgement || {};
    console.log(
      `${r.id.padEnd(5)} ${r.status.padEnd(15)} ${String(r.reason || "-").padEnd(23)} ${String(j.faithfulness || "-").padEnd(13)} ${String(j.correctness || "-").padEnd(12)} ${r.inlineCitation === null ? "-" : r.inlineCitation}`,
    );
  }

  console.log(`\nANSWERABLE (n=${ans.length})`);
  console.log(
    `  answered:       ${n(ans, (r) => r.status === "answered")}  (${pct(
      n(ans, (r) => r.status === "answered"),
      ans.length,
    )})`,
  );
  console.log(
    `  not_specified:  ${n(ans, (r) => r.status === "not_specified")}  (under-answered)`,
  );
  console.log(
    `  refused:        ${n(ans, (r) => r.status === "refused")}  (false refusals)`,
  );
  for (const reason of [
    "low_retrieval_score",
    "citation_not_retrieved",
    "uncited_answer",
  ]) {
    const c = n(ans, (r) => r.reason === reason);
    if (c) console.log(`    - ${reason}: ${c}`);
  }
  const ansJudged = ans.filter((r) => r.judgement);
  console.log(
    `  correctness (of ${ansJudged.length} generated): correct ${n(ansJudged, (r) => r.judgement.correctness === "correct")}, partial ${n(ansJudged, (r) => r.judgement.correctness === "partial")}, incorrect ${n(ansJudged, (r) => r.judgement.correctness === "incorrect")}`,
  );

  console.log(
    `\nUNANSWERABLE (n=${una.length}): correct refusal = not answered`,
  );
  for (const sub of ["off_topic", "plausible_not_in_act", "near_miss"]) {
    const g = una.filter((r) => r.subtype === sub);
    const notAnswered = n(g, (r) => r.status !== "answered");
    console.log(
      `  ${sub.padEnd(22)} ${notAnswered}/${g.length} not answered  (refused ${n(g, (r) => r.status === "refused")}, not_specified ${n(g, (r) => r.status === "not_specified")})`,
    );
  }
  console.log(
    `  overall correct refusal rate: ${pct(
      n(una, (r) => r.status !== "answered"),
      una.length,
    )}`,
  );

  console.log(`\nFAITHFULNESS (all ${judged.length} generated answers)`);
  for (const f of ["faithful", "minor_issue", "unfaithful"]) {
    console.log(
      `  ${f.padEnd(12)} ${n(judged, (r) => r.judgement.faithfulness === f)}  (${pct(
        n(judged, (r) => r.judgement.faithfulness === f),
        judged.length,
      )})`,
    );
  }
  console.log(
    `\nINLINE CITATION RATE: ${pct(
      n(judged, (r) => r.inlineCitation),
      judged.length,
    )} of generated answers cite sections in the text`,
  );

  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `full-${STRATEGY}-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        strategy: STRATEGY,
        generator: process.env.LLM_MODEL,
        judge: JUDGE_MODEL,
        threshold: Number(process.env.RETRIEVAL_THRESHOLD),
        timestamp: new Date().toISOString(),
        rows,
      },
      null,
      2,
    ),
  );
  fs.unlinkSync(PROGRESS_FILE); // completed run: next run starts fresh
  console.log(`\nSaved: ${path.relative(process.cwd(), file)}`);
}

main()
  .catch((err) => {
    console.error(
      "\nFAILED:",
      err.message,
      "\nProgress is saved; rerun to continue.",
    );
    process.exitCode = 1;
  })
  .finally(closeConnection);
