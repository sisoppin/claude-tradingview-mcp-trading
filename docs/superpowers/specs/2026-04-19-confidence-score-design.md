# Confidence Score — Design Spec

**Date:** 2026-04-19
**Status:** Approved

## Goal

Add a `STRONG` / `WEAK` confidence label to every combined signal, based on how well the active strategies' rules were satisfied. Display only — no effect on signal logic.

---

## Calculation

Computed inside `modeCombinedSignal` using the active strategy results already in scope.

### Per-strategy score

```
strategyScore(s) = s.rules.filter(r => r.pass).length / s.rules.length
```

### Final score

```
finalScore = average(strategyScores of active strategies)
```

Only the active strategy pair is included — never the inactive ones.

| Mode | Active strategies | Results used |
|------|------------------|--------------|
| Trending + ORB window | ORB + MACD | s4, s2 |
| Trending, outside ORB window | MACD only | s2 |
| Sideways | VWAP+EMA+RSI + BB+RSI | s1, s3 |

### Thresholds

| Condition | Threshold | Rationale |
|-----------|-----------|-----------|
| 2 active strategies | score ≥ 0.75 → STRONG | Both strategies need reasonable agreement |
| MACD-only (1 strategy) | score ≥ 0.85 → STRONG | 2 rules isn't much evidence; stricter bar |
| HOLD signal | always WEAK | Nothing fired |

### Example

Trending + ORB window, ORB 3/5 rules pass, MACD 2/2 pass:
- ORB score: 0.60
- MACD score: 1.00
- Final: (0.60 + 1.00) / 2 = 0.80 → **STRONG**

---

## Return Shape

`modeCombinedSignal` extended return — no new parameters:

```javascript
{ signal, mode, activeStrategies, count, total, confidence, score }
// confidence: "STRONG" | "WEAK"
// score: float 0–1
```

---

## Output Changes

### Terminal (`printTerminal`)

New line after the Combined Signal line:

```
  Combined Signal                🟢 BUY     via [ORB, MACD]
  Confidence                     STRONG (0.80)
```

### HTML (`buildHtml`)

Confidence badge added to the combined signal card:
- `STRONG` → green text/badge (`#16a34a`)
- `WEAK` → amber text/badge (`#ca8a04`)
- Score shown as percentage (e.g. `80%`)

---

## Files Changed

| File | Change |
|------|--------|
| `analyze.js` | Extend `modeCombinedSignal` to compute + return `confidence` and `score`; update `printTerminal` and `buildHtml` to display them |
| `tests/analyze.test.js` | Add tests for confidence score in `modeCombinedSignal` |

No changes to `strategies.js`.
