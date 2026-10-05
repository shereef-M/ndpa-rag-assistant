// Retrieval eval: hit@k, full recall@k, MRR on answerable questions;
// top-score distributions + threshold sweep for the refusal gate.
const fs = require("fs");
const path = require("path");
const {
  retrieve,
  embedQuery,
  closeConnection,
} = require("../src/services/retrieval");
// Query-embedding cache: test questions never change, so embed each once and reuse
const CACHE_FILE = path.join(__dirname, ".cache", "query-embeddings.json");
fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
const cache = fs.existsSync(CACHE_FILE)
  ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
  : {};
const cacheKey = (q) =>
  `${process.env.EMBEDDING_MODEL}|${process.env.EMBEDDING_DIM}|${q}`;
const TESTSET = require("./testset.json");

const STRATEGY = process.argv[2] || "section-v1";
const K = 5;
const KS = [1, 3, 5];
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => (100 * x).toFixed(1) + "%";

function stats(nums) {
  if (!nums.length) return "n/a";
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return `min ${Math.min(...nums).toFixed(4)}  max ${Math.max(...nums).toFixed(4)}  mean ${mean.toFixed(4)}  (n=${nums.length})`;
}

async function main() {
  const rows = [];
  for (const q of TESTSET) {
    const key = cacheKey(q.question);
    let queryVector = cache[key];
    if (!queryVector) {
      queryVector = await embedQuery(q.question);
      cache[key] = queryVector;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); // save immediately so progress survives a crash
    }
    const hits = await retrieve(q.question, {
      k: K,
      strategy: STRATEGY,
      queryVector,
    });
    const retrieved = hits.map((h) => h.section);
    const firstRank =
      retrieved.findIndex((s) => q.expected_sections.includes(s)) + 1; // 0 = miss
    rows.push({
      id: q.id,
      type: q.type,
      subtype: q.subtype || null,
      expected: q.expected_sections,
      retrieved,
      scores: hits.map((h) => Number(h.score.toFixed(4))),
      topScore: hits.length ? hits[0].score : 0,
      firstRank,
    });
    process.stdout.write(`\rRetrieving ${rows.length}/${TESTSET.length}`);
    await sleep(DELAY_MS);
  }
  console.log("\n");

  const ans = rows.filter((r) => r.type === "answerable");
  const una = rows.filter((r) => r.type === "unanswerable");

  // ---- Metrics ----
  const metrics = {};
  for (const k of KS) {
    metrics[`hit@${k}`] =
      ans.filter((r) => r.firstRank > 0 && r.firstRank <= k).length /
      ans.length;
    metrics[`fullRecall@${k}`] =
      ans.filter((r) =>
        r.expected.every((s) => r.retrieved.slice(0, k).includes(s)),
      ).length / ans.length;
  }
  metrics.mrr =
    ans.reduce((sum, r) => sum + (r.firstRank ? 1 / r.firstRank : 0), 0) /
    ans.length;

  // ---- Per-question table (answerable) ----
  console.log(
    "ANSWERABLE  expected        retrieved (top 5)          rank  top score",
  );
  for (const r of ans) {
    const fullK = r.expected.every((s) => r.retrieved.includes(s));
    const flag =
      r.firstRank === 0 ? "  <-- MISS" : !fullK ? "  <-- partial" : "";
    console.log(
      `${r.id.padEnd(11)} ${JSON.stringify(r.expected).padEnd(15)} ${JSON.stringify(r.retrieved).padEnd(26)} ${String(r.firstRank || "-").padEnd(5)} ${r.topScore.toFixed(4)}${flag}`,
    );
  }

  console.log("\nMETRICS (answerable, n=" + ans.length + ")");
  for (const k of KS)
    console.log(
      `  hit@${k}: ${pct(metrics[`hit@${k}`])}   fullRecall@${k}: ${pct(metrics[`fullRecall@${k}`])}`,
    );
  console.log(`  MRR: ${metrics.mrr.toFixed(3)}`);

  // ---- Score distributions ----
  console.log("\nTOP-SCORE DISTRIBUTIONS");
  console.log(`  answerable:            ${stats(ans.map((r) => r.topScore))}`);
  for (const sub of ["off_topic", "plausible_not_in_act", "near_miss"]) {
    console.log(
      `  ${sub.padEnd(22)} ${stats(una.filter((r) => r.subtype === sub).map((r) => r.topScore))}`,
    );
  }

  // ---- Threshold sweep ----
  console.log("\nTHRESHOLD SWEEP (refuse if top score < t)");
  console.log(
    "  t       correct refusals (of " +
      una.length +
      ")   false refusals (of " +
      ans.length +
      ")",
  );
  for (let t = 0.76; t <= 0.8501; t += 0.005) {
    const correct = una.filter((r) => r.topScore < t).length;
    const wrong = ans.filter((r) => r.topScore < t).length;
    console.log(`  ${t.toFixed(3)}   ${String(correct).padEnd(28)} ${wrong}`);
  }

  // ---- Save ----
  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `retrieval-${STRATEGY}-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        strategy: STRATEGY,
        k: K,
        timestamp: new Date().toISOString(),
        metrics,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved: ${path.relative(process.cwd(), file)}`);
}

main()
  .catch((err) => {
    console.error("\nFAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(closeConnection);
