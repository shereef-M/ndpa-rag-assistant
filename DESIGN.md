# Design

## Architecture

```
INGESTION (offline, run from a dev machine with a read-write DB user)
  Gazette PDF ──pdftotext──▶ ndpa-2023.txt (committed, fixed input)
     └─ segment.js: strip page headers/margin notes ─▶ 66 sections + title, Part, cross-refs
        └─ embed.js: Gemini embeddings (768-d) ─▶ Atlas `chunks` (section-v1)
           └─ build-s65split.js: s.65 ─▶ 24 definition chunks (s65split-v1, default)
              └─ create-index.js: Atlas vector index (cosine, filter on chunkStrategy)

QUERY (Render, read-only DB user)
  POST /ask ─▶ retrieve (top 5 sections) ─▶ Guardrail 1 (score gate)
            ─▶ generate (gpt-oss-120b, JSON) ─▶ Guardrail 2 (citation check)
            ─▶ answered | not_specified | refused  (+ cited section text, disclaimer)
```

## Key decisions

**Corpus: the Official Gazette text, extracted once.** The gazette PDF (Gazette No. 119, 1 July 2023) is the authoritative text. It is extracted once with `pdftotext` and the result is committed, so the patterns verified during development are exactly what ingestion parses, the server needs no PDF tooling, and anyone cloning gets identical input. Node PDF libraries use different engines and would have produced different text.

**Chunk by the Act's own structure, not fixed sizes.** One chunk per section, split on the section-start patterns (`26.—(1)` and `5. `), restricted to the body (`ENACTED by` … `SCHEDULE`) because the same patterns appear in the Arrangement and the Schedule. Section starts must be sequential, so a detection failure shows up as missing sections rather than silently mis-splitting. Fixed-size chunks would cut subsections in half and make citations meaningless.

**Titles from the Arrangement of Sections; margin notes removed by title matching.** The gazette prints section titles as margin notes that land in the wrong place in the extracted text (after a section starts, split across lines, letter-spaced as "S e c u r i t y,"). The Arrangement is a clean numbered list, so titles come from there, and margin notes are removed by matching runs of lines against known titles (normalised, and only runs starting with a capital, so body words like "consent." survive). Gazette quirks that defeat this (s.19's "Fund" vs "Funds") are handled by explicit rules rather than by loosening the matching.

**Contextual headers in embeddings.** Each chunk is embedded as `Section N: Title` + Part + text. Users ask in topic language; titles carry that signal better than statutory wording.

**Gemini `gemini-embedding-001`, 768 dimensions, cosine similarity.** Free tier, and an API keeps the Render instance light (a local model would need to be loaded in memory to embed each query). Documents use `RETRIEVAL_DOCUMENT`, queries `RETRIEVAL_QUERY`. Truncated to 768 dimensions the vectors are no longer unit-length, so the index uses cosine; `dotProduct` would rank them wrongly. Atlas rescales cosine scores to `(1 + cos) / 2`, and the refusal threshold is defined on that rescaled score.

**Exact vector search.** With under 100 chunks, exact search is cheap and removes approximate-nearest-neighbour noise from evaluation, so retrieval misses are attributable to embeddings or chunking, not the index.

**s.65 split into definitions, with section-level grouping (tuning experiment 1).** s.65 bundles 24 definitions into 5,716 characters, producing one blurry vector. Splitting it raised full recall@5 from 85% to 90%. Retrieval fetches 3× candidates and merges chunks of the same section, so a split section takes one top-k slot. This leaves the unsplit baseline identical and the comparison fair.

**Two guardrails plus the model's own flag, three outcomes.**
- *Guardrail 1, score gate (0.825):* chosen from a threshold sweep over all 30 test questions. 0.835 refused the same 6 unanswerable questions but sat 0.001 below the lowest answerable score (overfit); 0.825 keeps a ~0.011 margin. Off-topic questions are refused without an LLM call.
- *The model's `supported` flag:* near-miss questions score inside the answerable range, so no threshold can separate them. The generator is instructed to flag them and state what the Act does say.
- *Guardrail 2, citation check:* every section cited (in `cited_sections` or found in the answer text) must have been retrieved; a "supported" answer must cite something.
- *`not_specified` as a distinct outcome:* for near-misses, "the Act doesn't specify X, but says Y (s.34(1))" is more useful than a flat refusal and is honest about the gap.

**Generator `gpt-oss-120b` at temperature 0 with JSON output.** The strongest production model available on Groq's free tier when checked against the live model list (Llama models had been withdrawn). JSON output (`answer`, `cited_sections`, `supported`) lets code verify citations without parsing prose.

**Evaluation designed before the pipeline.** The 30-question test set (20 answerable with verified reference answers and expected sections; 10 unanswerable across off-topic, plausible-not-in-Act, and near-miss) was written and verified against the Act before any retrieval code existed, so questions couldn't be tuned to what the system already handled. The judge (`gpt-oss-20b`) is a different model from the generator, so the generator isn't grading itself.

**Production credentials: least privilege.** The Atlas cluster accepts connections from any IP (Render's free tier has no static IP), so credentials are the only protection. Render holds a dedicated user with `read` on `ndpa_rag` only: it can't write, and it can't see other databases on the shared cluster. Ingestion uses a separate read-write user from a dev machine.

**Rate limit on `/ask` (10/min/IP).** A deliberate small exception to "rate limiting out of scope": a public endpoint on free-tier Gemini/Groq quotas can be drained by one script.

**Retries with backoff on every external call.** Rate limits (429), server errors (5xx) and network failures (`fetch failed`, resets) are retried with exponential backoff. The eval harnesses also cache query embeddings and save per-question progress, so runs resume after failures; the live API embeds every query fresh.

## Known limitations

**Retrieval**
- **Cross-references are not resolved.** Sections refer to others ("orders made under section 47"); only what retrieval fetches reaches the generator.
- **Defined-term dependencies are invisible to retrieval.** "Does my company need a DPO?" depends on the s.65 definition of "major importance" only because s.32 uses the term; the question never mentions it, so no chunking strategy retrieves it (A11, A16).
- **Definitions that point outside the corpus.** "Child" is defined only by reference to the Child's Right Act 2003; the NDPA states no age.

**Generation**
- **Outside-knowledge leaks.** The generator repeatedly writes "a child, including a 15-year-old", an age threshold the Act doesn't state, despite the "only from the provided sections" rule.
- **Guardrail 2 checks section numbers, not subsections.** A non-existent "s.48(3)(d)" passes verification.
- **Answers omit content they were given.** The 2–5 sentence limit makes answers concise but often partial against fuller references (8–9 of 20).
- **Inline citations are inconsistent:** ~88–92% of answers cite sections in the text; the rest rely on the `cited_sections` list.
- **Non-deterministic.** Wording and completeness vary between runs despite temperature 0 (reasoning model).

**Evaluation**
- **The LLM judge is unreliable at fine detail.** On hand spot-checks it missed a non-existent subsection citation (A18), cited a non-existent subsection itself (A14), scored the correct statement "the NDPA does not specify any maximum fine under the GDPR" as unfaithful (U04), and missed the 15-year-old leak (A10). Faithfulness scores are an upper bound.
- **Small and optimistic test set.** n=30; questions were drafted against section titles, which are also embedded, so retrieval scores likely overstate performance on real user phrasing.
- **Run-to-run variance is about the size of the effects measured.** In experiment 1, a question with identical retrieval in both runs still changed grade; single runs can't resolve one-question differences.

**Data**
- **A corpus defect in s.65:** the tail of the "data controller" definition is displaced by the PDF's text order and attached to "social security laws". No test question depends on it.
- **The Schedule is excluded** (procedural Council matters).

**Operations and privacy**
- **User questions go to Gemini's free tier, whose inputs may be used by Google.** For a data-protection assistant this is a real limitation; a paid tier or a local embedding model would remove it.
- **Free-tier constraints:** cold starts (~50s after idle), unpublished and changeable quotas, model catalogue changes (Groq withdrew Llama models during this project).
- **No authentication, no conversation history, single document.**

## v2 backlog (prioritised)

1. **Definition expansion:** after retrieval, scan retrieved sections for defined terms and attach their s.65 definitions. Deterministic; targets A11/A16.
2. **Subsection validator:** parse cited subsections (e.g. `48(3)(d)`) and verify they exist in the section text. Replaces the judge for this error class.
3. **Prompt fix for inferred facts:** explicitly forbid stating thresholds, numbers or classifications the sections don't contain.
4. **Judge fixes:** treat statements of absence as supported for `not_specified` answers; spot-check protocol formalised.
5. **Variance measurement:** repeat runs per strategy and report ranges, not single values.
6. **Larger, paraphrased test set** written without reference to section titles.
7. **Fix the s.65 "data controller" text-order defect.**
8. **Resolve cross-references** (fetch sections referenced by retrieved ones), measured against false-refusal and noise effects.
9. **Privacy:** paid embedding tier or local model so user queries aren't used for training.
10. **Stretch:** CBN documents as a second corpus.

## Definition of Done (v1)

- [x] Ingestion chunks the full Act by section, with metadata
- [x] `/ask` works with both guardrail layers active
- [x] 30-question test set written and verified before the pipeline
- [x] Eval harness runs with one command and outputs all metrics
- [x] Baseline and tuned results recorded in EVIDENCE.md
- [x] Deployed live on Render
- [x] README, DESIGN, EVIDENCE, BUILDLOG complete
- [x] "Not legal advice" disclaimer in README and API responses
