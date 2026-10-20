// HTTP API: POST /ask, GET /sections/:id, GET /health
require("dotenv").config({ quiet: true });
const express = require("express");
const rateLimit = require("express-rate-limit");
const { ask } = require("./services/ask");
const { getCollection, closeConnection } = require("./services/retrieval");

const PORT = process.env.PORT || 3000;
const MAX_QUESTION_CHARS = 500;

const app = express();
app.set("trust proxy", 1); // Render runs behind a proxy; needed so rate limiting sees real client IPs
app.use(express.json({ limit: "10kb" }));

// Protects the free-tier Gemini/Groq quotas: 10 questions per minute per IP
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many questions. Please wait a minute and try again." },
});

app.get("/health", async (req, res) => {
  try {
    const col = await getCollection();
    await col.findOne({}, { projection: { _id: 1 } });
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    console.error("health check failed:", err.message);
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

app.post("/ask", askLimiter, async (req, res) => {
  const question =
    typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res
      .status(400)
      .json({
        error: '"question" is required and must be a non-empty string.',
      });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res
      .status(400)
      .json({
        error: `"question" must be at most ${MAX_QUESTION_CHARS} characters.`,
      });
  }
  try {
    res.json(await ask(question));
  } catch (err) {
    console.error("ask failed:", err.message); // real cause stays in the server log
    res
      .status(502)
      .json({
        error:
          "The assistant could not answer right now. Please try again shortly.",
      });
  }
});

// Full section text for verifying citations (always from section-v1, so s.65 comes back whole)
app.get("/sections/:id", async (req, res) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1 || n > 66) {
    return res
      .status(400)
      .json({ error: "Section id must be an integer from 1 to 66." });
  }
  try {
    const col = await getCollection();
    const doc = await col.findOne(
      { chunkStrategy: "section-v1", section: n },
      {
        projection: {
          _id: 0,
          section: 1,
          title: 1,
          part: 1,
          text: 1,
          references: 1,
        },
      },
    );
    if (!doc) return res.status(404).json({ error: `Section ${n} not found.` });
    res.json(doc);
  } catch (err) {
    console.error("section lookup failed:", err.message);
    res
      .status(502)
      .json({
        error:
          "Could not load the section right now. Please try again shortly.",
      });
  }
});

app.use((req, res) => {
  res
    .status(404)
    .json({
      error: "Not found. Endpoints: POST /ask, GET /sections/:id, GET /health",
    });
});

const server = app.listen(PORT, () =>
  console.log(`NDPA RAG API listening on port ${PORT}`),
);

async function shutdown() {
  server.close();
  await closeConnection();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
