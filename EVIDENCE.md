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
