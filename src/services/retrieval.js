// Retrieval service: embeds a question and returns the top-k closest sections from Atlas.
require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

const COLLECTION = "chunks";
const INDEX_NAME = "chunks_vector_index";
const MODEL = process.env.EMBEDDING_MODEL;
const DIM = Number(process.env.EMBEDDING_DIM);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let client;

async function getCollection() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db().collection(COLLECTION);
}

async function closeConnection() {
  if (client) {
    await client.close();
    client = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedQuery(question, attempt = 1) {
  try {
    const res = await ai.models.embedContent({
      model: MODEL,
      contents: question,
      config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: DIM },
    });
    return res.embeddings[0].values;
  } catch (err) {
    // Retry on rate limits, temporary server errors, and transient network failures
    const retryable =
      err.status === 429 ||
      err.status === 503 ||
      /429|RESOURCE_EXHAUSTED|UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(
        err.message,
      );
    if (retryable && attempt < 5) {
      const wait = 2 ** attempt * 1000; // 2s, 4s, 8s, 16s
      console.warn(
        `\n  rate limited, retrying in ${wait / 1000}s (attempt ${attempt})`,
      );
      await sleep(wait);
      return embedQuery(question, attempt + 1);
    }
    throw err;
  }
}

// Atlas cosine score is rescaled: score = (1 + cosine) / 2, range 0-1
async function retrieve(
  question,
  { k = 5, strategy = "section-v1", queryVector = null } = {},
) {
  queryVector = queryVector || (await embedQuery(question));
  const col = await getCollection();
  return col
    .aggregate([
      {
        $vectorSearch: {
          index: INDEX_NAME,
          path: "embedding",
          queryVector,
          exact: true, // 66 chunks: exact search is cheap and removes ANN noise from eval
          limit: k,
          filter: { chunkStrategy: strategy },
        },
      },
      {
        $project: {
          _id: 0,
          section: 1,
          title: 1,
          part: 1,
          text: 1,
          references: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray();
}

module.exports = { retrieve, embedQuery, closeConnection };

// CLI: node src/services/retrieval.js "your question"
if (require.main === module) {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error('Usage: node src/services/retrieval.js "your question"');
    process.exit(1);
  }
  retrieve(question)
    .then((hits) =>
      hits.forEach((h, i) =>
        console.log(
          `${i + 1}. s.${h.section} ${h.title} (score ${h.score.toFixed(4)})`,
        ),
      ),
    )
    .catch((err) => {
      console.error("FAILED:", err.message);
      process.exitCode = 1;
    })
    .finally(closeConnection);
}
