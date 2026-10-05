// Ingestion stage 4: embed each section and upsert into Atlas.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const SECTIONS = path.join(
  __dirname,
  "..",
  "data",
  "processed",
  "sections.json",
);
const COLLECTION = "chunks";
const STRATEGY = "section-v1";
const MODEL = process.env.EMBEDDING_MODEL;
const DIM = Number(process.env.EMBEDDING_DIM);
const DELAY_MS = 700; // pacing between requests; free-tier limits are unpublished

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Contextual header: title + Part give the vector topic-level signal
function buildEmbedText(s) {
  return `Section ${s.section}: ${s.title}\n${s.part}\n\n${s.text}`;
}

async function embedWithRetry(ai, text, attempt = 1) {
  try {
    const res = await ai.models.embedContent({
      model: MODEL,
      contents: text,
      config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: DIM },
    });
    return res.embeddings[0].values;
  } catch (err) {
    const rateLimited =
      err.status === 429 || /429|RESOURCE_EXHAUSTED/.test(err.message);
    if (rateLimited && attempt < 5) {
      const wait = 2 ** attempt * 1000;
      console.warn(
        `\n  rate limited, retrying in ${wait / 1000}s (attempt ${attempt})`,
      );
      await sleep(wait);
      return embedWithRetry(ai, text, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  const sections = JSON.parse(fs.readFileSync(SECTIONS, "utf8"));
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const col = client.db().collection(COLLECTION);

  try {
    let done = 0;
    for (const s of sections) {
      const embedText = buildEmbedText(s);
      const embedding = await embedWithRetry(ai, embedText);
      if (embedding.length !== DIM)
        throw new Error(
          `s.${s.section}: got ${embedding.length} dims, expected ${DIM}`,
        );

      await col.replaceOne(
        { _id: `s${s.section}` },
        {
          section: s.section,
          title: s.title,
          part: s.part,
          text: s.text,
          references: s.references,
          chars: s.chars,
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
      process.stdout.write(
        `\rEmbedded ${done}/${sections.length} (s.${s.section})   `,
      );
      await sleep(DELAY_MS);
    }
    const count = await col.countDocuments({ chunkStrategy: STRATEGY });
    console.log(`\nDone. ${count} "${STRATEGY}" chunks in "${COLLECTION}".`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});
