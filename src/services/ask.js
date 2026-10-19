// Ask pipeline: retrieval -> guardrail 1 (score gate) -> generation -> guardrail 2 (citation check).
require("dotenv").config({ quiet: true });
const { retrieve, closeConnection } = require("./retrieval");
const { generateFromHits } = require("./generation");

const THRESHOLD = Number(process.env.RETRIEVAL_THRESHOLD || 0.825);
const DISCLAIMER =
  "This is an automated summary of the Nigeria Data Protection Act 2023, not legal advice. Verify against the cited sections and consult a qualified lawyer before acting.";
const OFF_TOPIC =
  "I can only answer questions about the Nigeria Data Protection Act 2023, and I couldn't find any sections of the Act relevant to this question.";
const UNVERIFIABLE =
  "I couldn't produce an answer that can be verified against the retrieved sections of the Act.";

// Finds section references in the answer text: "s.26(3)", "s. 26", "section 26"
function extractTextCitations(answer) {
  const found = new Set();
  for (const re of [/\bs\.\s?(\d+)/g, /\bsections?\s+(\d+)/gi]) {
    for (const m of answer.matchAll(re)) found.add(Number(m[1]));
  }
  return [...found];
}

async function ask(
  question,
  { k = 5, strategy = "section-v1", queryVector = null } = {},
) {
  const hits = await retrieve(question, { k, strategy, queryVector });
  const topScore = hits.length ? hits[0].score : 0;
  const retrieval = {
    topScore: Number(topScore.toFixed(4)),
    threshold: THRESHOLD,
    sections: hits.map((h) => h.section),
  };

  // Guardrail 1: retrieval score gate (no LLM call)
  if (topScore < THRESHOLD) {
    return {
      status: "refused",
      reason: "low_retrieval_score",
      answer: OFF_TOPIC,
      citations: [],
      retrieval,
      disclaimer: DISCLAIMER,
    };
  }

  const out = await generateFromHits(question, hits);

  // Guardrail 2: every cited section (list + answer text) must have been retrieved
  const retrievedSet = new Set(hits.map((h) => h.section));
  const cited = [
    ...new Set([...out.cited_sections, ...extractTextCitations(out.answer)]),
  ].sort((a, b) => a - b);
  const invalid = cited.filter((s) => !retrievedSet.has(s));
  const citations = hits
    .filter((h) => cited.includes(h.section))
    .map((h) => ({ section: h.section, title: h.title, text: h.text }));
  const base = {
    retrieval,
    generation: { supported: out.supported, cited },
    disclaimer: DISCLAIMER,
  };

  if (invalid.length) {
    return {
      status: "refused",
      reason: "citation_not_retrieved",
      invalid_citations: invalid,
      answer: UNVERIFIABLE,
      citations: [],
      ...base,
    };
  }
  if (out.supported && cited.length === 0) {
    return {
      status: "refused",
      reason: "uncited_answer",
      answer: UNVERIFIABLE,
      citations: [],
      ...base,
    };
  }
  if (!out.supported) {
    return {
      status: "not_specified",
      reason: "model_unsupported",
      answer: out.answer,
      citations,
      ...base,
    };
  }
  return {
    status: "answered",
    reason: null,
    answer: out.answer,
    citations,
    ...base,
  };
}

module.exports = { ask, closeConnection };

// CLI: node src/services/ask.js "your question"   (prints without the long citation texts)
if (require.main === module) {
  const question = process.argv.slice(2).join(" ");
  if (!question) {
    console.error('Usage: node src/services/ask.js "your question"');
    process.exit(1);
  }
  ask(question)
    .then((r) =>
      console.log(
        JSON.stringify(
          {
            ...r,
            citations: r.citations.map((c) => `s.${c.section} ${c.title}`),
          },
          null,
          2,
        ),
      ),
    )
    .catch((err) => {
      console.error("FAILED:", err.message);
      process.exitCode = 1;
    })
    .finally(closeConnection);
}
