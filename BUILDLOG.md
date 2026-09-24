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
