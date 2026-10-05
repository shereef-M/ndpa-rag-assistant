// Creates the Atlas Vector Search index on the chunks collection and waits until it's queryable.
require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");

const COLLECTION = "chunks";
const INDEX_NAME = "chunks_vector_index";
const DIM = Number(process.env.EMBEDDING_DIM);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const col = client.db().collection(COLLECTION);

  try {
    const existing = await col.listSearchIndexes(INDEX_NAME).toArray();
    if (existing.length) {
      console.log(`Index "${INDEX_NAME}" already exists (status: ${existing[0].status}).`);
    } else {
      await col.createSearchIndex({
        name: INDEX_NAME,
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "embedding", numDimensions: DIM, similarity: "cosine" },
            { type: "filter", path: "chunkStrategy" },
          ],
        },
      });
      console.log(`Index "${INDEX_NAME}" requested. Waiting for it to become queryable...`);
    }

    for (let i = 0; i < 30; i++) {
      const [idx] = await col.listSearchIndexes(INDEX_NAME).toArray();
      if (idx && idx.queryable) {
        console.log(`Ready. status: ${idx.status}, queryable: ${idx.queryable}`);
        return;
      }
      process.stdout.write(`\r  status: ${idx ? idx.status : "pending"} (${(i + 1) * 5}s)   `);
      await sleep(5000);
    }
    console.log("\nStill not queryable after 150s. Check Atlas > Search & Vector Search.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});