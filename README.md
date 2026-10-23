# NDPA RAG Assistant

A question-answering API for the **Nigeria Data Protection Act 2023 (NDPA)**. It answers only from the Act's text, cites the exact sections it used, and refuses when the Act doesn't support an answer.

**Live:** https://ndpa-rag-assistant.onrender.com (free tier: the first request after ~15 min idle takes 30–60s while the instance wakes)

> Not legal advice. Answers are automated summaries of the Act; verify against the cited sections and consult a qualified lawyer before acting.

## How it works

```
question → embed (Gemini) → vector search (MongoDB Atlas, top 5 sections)
        → Guardrail 1: top score < 0.825? refuse, no LLM call
        → generate (gpt-oss-120b via Groq): answer only from the sections, cite them, flag if unsupported
        → Guardrail 2: every cited section must have been retrieved; a "supported" answer must cite something
        → answered | not_specified | refused
```

- **answered:** the Act covers it; citations verified.
- **not_specified:** the topic is in the Act but the specific detail isn't (e.g. "how many days to respond to an access request?"). Returns what the Act *does* say, clearly labelled.
- **refused:** off-topic, or the answer couldn't be verified against retrieved sections.

## Results (measured on a 30-question test set written before the pipeline)

| | |
|---|---|
| Retrieval hit@1 / MRR | 100% / 1.000 |
| Retrieval full recall@5 | 85% → **90%** after tuning |
| Answerable questions answered | 20/20 (0 false refusals) |
| Unanswerable questions not answered | 10/10 |
| Correctness vs verified references (LLM judge) | 11–12 correct, 8–9 partial, 0 incorrect |

Full results, caveats, and where the evaluation instruments fell short: [EVIDENCE.md](EVIDENCE.md). Design decisions and known limitations: [DESIGN.md](DESIGN.md). Build history including real obstacles: [BUILDLOG.md](BUILDLOG.md).

## API

### `POST /ask`
```bash
curl -X POST https://ndpa-rag-assistant.onrender.com/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "If our database gets hacked, how quickly must we notify the regulator?"}'
```
Returns `status`, `answer`, `citations` (each with the section's full text), `retrieval` (top score, threshold, retrieved sections), `generation` (model's supported flag, cited sections), and `disclaimer`.
Limits: question 1–500 characters; 10 requests per minute per IP.

### `GET /sections/:id`
Full text of a section (1–66), for verifying citations.
```bash
curl https://ndpa-rag-assistant.onrender.com/sections/40
```

### `GET /health`
Server and database status.

## Run it yourself

**Requires:** Node 20+, a MongoDB Atlas cluster (free M0 works), a Gemini API key, a Groq API key. All free tier.

```bash
git clone https://github.com/shereef-M/ndpa-rag-assistant.git
cd ndpa-rag-assistant
npm install
```

Create `.env`:
```
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER/ndpa_rag?appName=...
GEMINI_API_KEY=...
GROQ_API_KEY=...
EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIM=768
LLM_MODEL=openai/gpt-oss-120b
JUDGE_MODEL=openai/gpt-oss-20b
RETRIEVAL_THRESHOLD=0.825
```

Build the index (the extracted Act text is already in `data/processed/`):
```bash
node scripts/check-env.js          # verify MongoDB + Gemini credentials
node scripts/segment.js            # clean + split the Act into 66 sections
node scripts/embed.js              # embed sections into Atlas (section-v1)
node scripts/build-s65split.js     # tuned strategy: s.65 split into definitions (s65split-v1, default)
node scripts/create-index.js       # create the Atlas vector index
npm start                          # API on http://localhost:3000
```

Run the evals:
```bash
node eval/retrieval-eval.js s65split-v1   # retrieval metrics + threshold sweep
node eval/full-eval.js s65split-v1        # end-to-end with LLM judge (resumable)
```

## Project structure
```
data/raw/            the Act (Official Gazette PDF)
data/processed/      extracted text, segmented sections
scripts/             ingestion: segment, embed, index, tuning builds
src/services/        retrieval, generation, ask pipeline (guardrails)
src/server.js        Express API
eval/                test set, eval harnesses, results/
```

## Stack
Node.js · Express · MongoDB Atlas Vector Search · Gemini embeddings · Groq (gpt-oss-120b, gpt-oss-20b judge) · Render
