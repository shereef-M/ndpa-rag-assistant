// Sanity check: verifies MongoDB connection and Gemini embedding before real ingestion.
require("dotenv").config();
const { MongoClient } = require("mongodb");
const { GoogleGenAI } = require("@google/genai");

async function main() {
  // 1. MongoDB
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(); // uses the database name from the URI
    await db.command({ ping: 1 });
    console.log(`MongoDB OK, database: "${db.databaseName}"`);
  } catch (err) {
    console.error("MongoDB FAILED:", err.message);
  } finally {
    await client.close();
  }

  // 2. Gemini embedding
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const res = await ai.models.embedContent({
      model: process.env.EMBEDDING_MODEL,
      contents:
        "Silence or inactivity of the data subject shall not constitute consent.",
      config: {
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: Number(process.env.EMBEDDING_DIM),
      },
    });
    const values = res.embeddings[0].values;
    console.log(
      `Gemini OK, model: ${process.env.EMBEDDING_MODEL}, dimensions: ${values.length}`,
    );
    console.log(
      "First 5 values:",
      values
        .slice(0, 5)
        .map((v) => v.toFixed(4))
        .join(", "),
    );
  } catch (err) {
    console.error("Gemini FAILED:", err.message);
  }
}

main();
