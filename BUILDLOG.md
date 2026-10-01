# Build Log

## 1. Sourcing the corpus
- First source (a KPMG-hosted copy of the Act) returned 404; the link was dead.
- Found the Official Gazette version (Gazette No. 119, 1 July 2023) hosted by ngCERT. `wget` returned 403 even with a browser user-agent (Cloudflare bot protection), so I downloaded it manually through the browser.
- Verified the PDF has a clean text layer (not OCR): 43 pages, section text extracts accurately.

## 2. Inspecting the raw text
- Section boundaries follow a consistent `N.—` pattern, which can be split on reliably.
- Gazette page headers (`A 734`, `2023 No. 37`, the Act's title) interrupt sections mid-text and need stripping.
- Margin-note section titles are displaced (they sometimes appear after a section starts, and are split across lines), so they're unreliable. Titles will come from the Arrangement of Sections instead.
- Heavy cross-referencing between sections (e.g. s.27 cites s.25, s.30, s.46 and Part VI). Retrieval can miss referenced context, which is a known v1 limitation. References will be extracted as chunk metadata.

## 3. Findings while verifying the test set
- Section-start format is not consistent after all: sections with subsections start `N.—(1)`, sections without start `N. ` (e.g. s.5). The chunker must match both.
- The `N. ` pattern also appears in the Arrangement of Sections and the Schedule's paragraphs, so section detection must be limited to the body (from `ENACTED by` to the `SCHEDULE` heading).
- Part headings (e.g. "PART VIII — CROSS-BORDER TRANSFERS...") appear inline at the end of the preceding section; they must be stripped from text and kept as `part` metadata.
- Text layer contains stray characters (e.g. "section ż42" in s.43), so text needs cleaning before cross-reference extraction.
- Key definitions live in s.65 (Interpretation), and several test questions depend on it alongside another section. It's a likely retrieval hotspot.
- "child" (s.65) is defined only by reference to the Child's Right Act 2003, so the corpus cannot answer age thresholds alone. This is a known limitation of a single-document corpus.
