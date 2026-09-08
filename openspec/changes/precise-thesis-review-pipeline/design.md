
- [ ] Anthropic 1h-TTL beta header name and current write-premium multiplier — re-verify against
      live docs at implementation (design falls back to the 5m default, correctness-neutral).
- [ ] `pysbd` Spanish segmentation quality on real thesis text — RED tests decide; documented
      fallback is a hand-rolled abbreviation-aware splitter behind the same interface.
- [ ] LibreOffice pagination may differ from Word's own rendering; pages are real and citable
      but derived from the converted PDF. Recorded as `provenance_confidence=0.9` +
      `metadata.pagination_engine`. Confirm this is acceptable to the reviewer workflow.
