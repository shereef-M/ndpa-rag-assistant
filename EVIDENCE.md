# Evidence

All results below are measured, not claimed. Raw results are in `eval/results/`.

## Test set
30 questions written and verified against the Act text before any pipeline code: 20 answerable (with expected sections and reference answers), 10 unanswerable (3 off-topic, 3 plausible-but-not-in-Act, 4 near-misses where the Act covers the topic but not the specific detail asked).

## Retrieval baseline (`section-v1`: one chunk per section, 66 chunks, exact vector search, k=5)

| Metric | @1 | @3 | @5 |
|---|---|---|---|
| hit (any expected section) | 100.0% | 100.0% | 100.0% |
| full recall (all expected sections) | 70.0% | 80.0% | 85.0% |

MRR: 1.000

**Where it fails:** all 3 full-recall misses at k=5 (A10, A11, A16) are questions needing a definition from s.65 (Interpretation). s.65 is never retrieved for them; it appears only at ranks 3 and 5 for A09 and A15. s.65 is 5,716 characters bundling about 30 definitions into one vector, which is the hypothesis for the first tuning experiment.

**Caveat:** questions were drafted against section titles, and titles are included in chunk embeddings, so the 100% hit@1 is likely optimistic for real user phrasing. n=20.

## Refusal gate: top-score distributions (Atlas cosine score, rescaled (1+cos)/2)

| Group | min | max | mean |
|---|---|---|---|
| answerable (n=20) | 0.8361 | 0.8884 | 0.8607 |
| off-topic (n=3) | 0.7733 | 0.7905 | 0.7817 |
| plausible, not in Act (n=3) | 0.8011 | 0.8426 | 0.8162 |
| near-miss (n=4) | 0.8246 | 0.8679 | 0.8482 |

Threshold chosen: **0.825**. It refuses 6/10 unanswerable with 0/20 false refusals. 0.835 gives the same result but sits 0.001 below the lowest answerable score (overfit); 0.825 keeps a ~0.011 margin. The remaining 4 (3 near-misses, 1 plausible) score inside the answerable range, so no score threshold can catch them. This is the measured justification for guardrail layer 2.

## Full pipeline baseline (`section-v1`, threshold 0.825, generator gpt-oss-120b, judge gpt-oss-20b)

All 30 questions run through `ask()` with both guardrails active. Raw results: `eval/results/full-section-v1-2026-10-19T19-33-01-241Z.json`.

### Outcomes
| | Result |
|---|---|
| Answerable answered | 20/20 (0 false refusals) |
| Unanswerable not answered | 10/10 |
| - off-topic (3) | 3 refused at retrieval gate |
| - plausible, not in Act (3) | 2 refused at gate, 1 `not_specified` |
| - near-miss (4) | 3 `not_specified` (ideal: partial answer + "Act doesn't specify"), 1 refused at gate |

The model's own `supported` flag caught the 4 unanswerable questions that passed the 0.825 gate. No guardrail-2 refusals were triggered; the feared cross-reference false refusals (e.g. s.49 mentioning s.47) did not occur.

### Correctness vs verified reference answers (LLM judge)
12 correct, 8 partial, 0 incorrect (answerable). Partials are real omissions on spot-check, largely driven by the deliberate 2–5 sentence answer limit. A10 and A16 are partial because they lack s.65 definitions, the same section retrieval failed to fetch for them, so the retrieval weakness carries through to answer completeness.

### Faithfulness (LLM judge): 24/24 "faithful". Treat as an upper bound, not a measurement
Hand spot-check found the judge unreliable at subsection precision:
- **Missed a real error:** A18 cites "s.48(3)(d)", which does not exist (the penalty power is s.48(2)(d)); judged "faithful".
- **Hallucinated itself:** for A14 the judge cited a missing point under "s.40(3)(b)"; s.40(3) has no paragraph (b).
- Checked A12's "partial" by hand: correct (the answer omits the s.37(1) right and the s.37(2) exceptions).

A deterministic subsection validator (parse cited subsections, verify they exist in the section text) would be more reliable than an LLM for this error class. Logged as a candidate improvement.

### Inline citations
21/24 generated answers (87.5%) cite sections in the answer text; A19, A20 and U09 do not (their `cited_sections` lists are populated, so guardrail 2 still verified them). The first computation reported 79.2% because the regex only matched "s.26", not "Section 26". That was a metric bug, fixed.

### Caveats
Single run; the generator is a reasoning model and wording varies between runs despite temperature 0. n=30.
