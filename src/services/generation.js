// Generation service: answers a question strictly from retrieved NDPA sections, with citations.
require("dotenv").config({ quiet: true });
const { retrieve, closeConnection } = require("./retrieval");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const LLM_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-120b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `You answer questions about the Nigeria Data Protection Act 2023 (NDPA) using ONLY the Act sections provided in the user message.

Rules:
1. Use only the provided sections. Do not use outside knowledge, including other laws (e.g. GDPR), regulations, or general data-protection practice.
2. Cite the section, and subsection where clear, for every claim, inline, in the form s.26(3).
3. If the provided sections fully answer the question, set "supported" to true.
4. If they do not contain the answer, set "supported" to false. In "answer", say plainly that the Act does not specify it in the provided sections, then state only what the provided sections do say on the topic, if anything relevant, with citations. Never guess or fill gaps.
5. "cited_sections" lists the section numbers you cited, as integers, and only sections that were provided.
6. Be concise: two to five sentences, in your own words. Do not copy long passages.

Respond with a JSON object only, in exactly this shape:
{"answer": string, "cited_sections": number[], "supported": boolean}`;

function buildUserMessage(question, hits) {
  const context = hits
    .map((h) => `[Section ${h.section}: ${h.title}]\n${h.text}`)
    .join("\n\n---\n\n");
  return `Act sections:\n\n${context}\n\n---\n\nQuestion: ${question}`;
}

// Retries on rate limits, server errors and network failures, with exponential backoff
async function callGroq(messages, attempt = 1) {
  const retry = async (reason) => {
    if (attempt >= 5)
      throw new Error(`Groq failed after ${attempt} attempts: ${reason}`);
    const wait = 2 ** attempt * 1000;
    console.warn(
      `\n  Groq retryable error (${reason}), retrying in ${wait / 1000}s`,
    );
    await sleep(wait);
    return callGroq(messages, attempt + 1);
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
        model: LLM_MODEL,
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
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data.choices[0].message.content;
}

function parseOutput(raw) {
  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }
  if (
    typeof out.answer !== "string" ||
    !Array.isArray(out.cited_sections) ||
    typeof out.supported !== "boolean"
  ) {
    throw new Error(`LLM JSON has the wrong shape: ${raw.slice(0, 200)}`);
  }
  out.cited_sections = out.cited_sections.map(Number).filter(Number.isInteger);
  return out;
}

async function generateAnswer(
  question,
  { k = 5, strategy = "section-v1", queryVector = null } = {},
) {
  const hits = await retrieve(question, { k, strategy, queryVector });
  const raw = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(question, hits) },
  ]);
  const out = parseOutput(raw);
  return {
    question,
    answer: out.answer,
    cited_sections: out.cited_sections,
    supported: out.supported,
    retrieved: hits.map((h) => ({
      section: h.section,
      title: h.title,
      score: Number(h.score.toFixed(4)),
    })),
    model: LLM_MODEL,
  };
}

module.exports = { generateAnswer, closeConnection };

// CLI: node src/services/generation.js "your question"
if (require.main === module) {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error('Usage: node src/services/generation.js "your question"');
    process.exit(1);
  }
  generateAnswer(question)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error("FAILED:", err.message);
      process.exitCode = 1;
    })
    .finally(closeConnection);
}
