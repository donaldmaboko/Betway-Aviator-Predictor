# Betway Aviator Round Analyzer

A standalone Tampermonkey/Greasemonkey userscript for recording visible Aviator round results and analyzing the stored history locally.

## Important limitation

This is deliberately **not a next-round predictor**. If rounds are independently generated, previous multipliers, streaks, clock times, and hand-built “ML” models do not reveal the next result. A script cannot make a fair random crash game predictable from past outcomes alone. The historical rates and confidence intervals in this tool describe the rounds you recorded; they are not forecasts, betting signals, or guarantees.

The prior v8 code presented untrained random-weight neural/LSTM-like code, injected random noise into “predictions,” used arbitrary time windows and confidence boosts, and could mistake unrelated page numbers for crash results. Those features gave the display a false appearance of accuracy. This version removes them rather than fabricating confidence.

## Features

- Records manual latest-round entries and newest-first bulk imports; repeated multiplier values are retained as separate rounds.
- Attempts conservative DOM capture only near a visible round-history label. It does not scrape arbitrary numbers from the entire page. If the site changes its layout or renders the game in a protected frame, manual entry remains available.
- Shows sample size, recent median and 90th percentile, multiplier buckets, and observed ≥3x/≥5x frequencies with Wilson 95% confidence intervals (whose usual interpretation assumes stable, independent rounds).
- Merges pasted histories using sequence overlap rather than incorrectly deduplicating equal multipliers.
- Saves locally in userscript storage, migrates the old `aviator_ml_v8` history when present, and supports CSV export, replace, and clear actions.
- Makes no network requests and does not click or place bets.

## Install

1. Install Tampermonkey or another compatible userscript manager.
2. If you already installed v8, edit that existing script and replace its source with [`betway-aviator-round-analyzer.user.js`](./betway-aviator-round-analyzer.user.js). Keeping the same script entry is the best chance of retaining its userscript storage. For a fresh install, create a new userscript and paste the file contents.
3. Open the supported Betway Aviator page and check the analyzer's capture status. Automatic capture assumes the visible history is newest-first; use the order button if the site displays it the other way around.
4. If automatic capture cannot identify the history list, enter a result in **Add latest result** or paste a newest-first list under **Bulk history**.

Automatic DOM capture is best-effort: the game's page structure is controlled by Betway, and browsers/userscript managers cannot read a cross-origin iframe from the surrounding page.

## Tests

Run the pure statistics, parsing, and history-merge tests with:

```sh
node --test tests/analyzer.test.js
```
