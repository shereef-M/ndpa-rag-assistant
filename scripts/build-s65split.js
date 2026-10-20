// Tuning experiment 1: split s.65 (Interpretation) into one chunk per definition.
// The other 65 sections are copied from section-v1 with their existing vectors (no re-embedding).
require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const BASE = "section-v1";
const STRATEGY = "s65split-v1";
const MODEL = process.env.EMBEDDING_MODEL;
const DIM = Number(process.env.EMBEDDING_DIM);
const DELAY_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function embedWithRetry(ai, text, attempt = 1) {
  try {
    const res = await ai.models.embedContent({
      model: MODEL,
      contents: text,
      config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: DIM },
    });
    return res.embeddings[0].values;
  } catch (err) {
    const retryable =
      err.status === 429 ||
      err.status === 503 ||
      /429|RESOURCE_EXHAUSTED|UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(
        err.message,
      );
    if (retryable && attempt < 5) {
      const wait = 2 ** attempt * 1000;
      console.warn(
        `\n  retryable error (${err.message.slice(0, 40)}), retrying in ${wait / 1000}s`,
      );
      await sleep(wait);
      return embedWithRetry(ai, text, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const col = client.db().collection("chunks");

  try {
    // 1. Copy every section except s.65, keeping its existing embedding
    const others = await col
      .find({ chunkStrategy: BASE, section: { $ne: 65 } })
      .toArray();
    for (const d of others) {
      const { _id, ...rest } = d;
      await col.replaceOne(
        { _id: `${_id}-${STRATEGY}` },
        { ...rest, chunkStrategy: STRATEGY },
        { upsert: true },
      );
    }
    console.log(`Copied ${others.length} sections from ${BASE}.`);

    // 2. Split s.65 into definitions: each starts with a line beginning “term”
    const s65 = await col.findOne({ chunkStrategy: BASE, section: 65 });
    const defs = [];
    let cur = null;
    for (const line of s65.text.split("\n")) {
      const m = line.match(/^“([^”]+)”/);
      if (m) {
        cur = { term: m[1], lines: [line] };
        defs.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      }
    }
    console.log(`Found ${defs.length} definitions in s.65:`);
    console.log("  " + defs.map((d) => d.term).join(" | "));

    // 3. Embed each definition as its own chunk
    let done = 0;
    for (const d of defs) {
      const text = d.lines.join("\n");
      const embedText = `Section 65: Interpretation. Definition of "${d.term}"\n${s65.part}\n\n${text}`;
      const embedding = await embedWithRetry(ai, embedText);
      if (embedding.length !== DIM)
        throw new Error(
          `"${d.term}": got ${embedding.length} dims, expected ${DIM}`,
        );

      await col.replaceOne(
        { _id: `s65-${slug(d.term)}-${STRATEGY}` },
        {
          section: 65,
          title: `Interpretation: "${d.term}"`,
          term: d.term,
          part: s65.part,
          text,
          references: s65.references,
          chars: text.length,
          embedText,
          embedding,
          embeddingModel: MODEL,
          embeddingDim: DIM,
          chunkStrategy: STRATEGY,
          embeddedAt: new Date(),
        },
        { upsert: true },
      );
      done++;
      process.stdout.write(`\rEmbedded ${done}/${defs.length} definitions   `);
      await sleep(DELAY_MS);
    }

    const count = await col.countDocuments({ chunkStrategy: STRATEGY });
    console.log(
      `\nDone. ${count} "${STRATEGY}" chunks (${others.length} sections + ${defs.length} definitions).`,
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
