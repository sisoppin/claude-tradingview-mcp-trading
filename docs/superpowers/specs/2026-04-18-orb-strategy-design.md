# Opening Range Breakout (ORB) Strategy Design

**Date:** 2026-04-18  
**Status:** Approved

---

## Overview

Add a 15-minute Opening Range Breakout strategy to `strategies.js` as a fourth strategy alongside the existing VWAP+EMA+RSI, MACD, and Bollinger Bands strategies.

## Opening Range Definition

- **Session anchor:** same IST midnight anchor used by `calcVWAP` (18:30 UTC previous day)
- **Opening range candles:** first 3 candles of the session (9:15–9:30 AM IST on 5m timeframe)
- **ORB High:** `max(high)` of those 3 candles
- **ORB Low:** `min(low)` of those 3 candles
- **Avg ORB Volume:** `mean(volume)` of those 3 candles

If fewer than 3 session candles exist, return `HOLD` with rule `"Opening range not yet formed (need 3 candles)"`.

## Signal Logic

All 3 rules must pass simultaneously for a signal. The current candle is the last candle in the dataset.

### BUY — price breakout above range with trend confirmation

| Rule | Condition |
|------|-----------|
| Close above ORB High | `close > orbHigh` |
| Volume above avg ORB volume | `volume > avgOrbVolume` |
| RSI(14) bullish | `RSI(14) > 50` |

### SELL — price breakdown below range with trend confirmation

| Rule | Condition |
|------|-----------|
| Close below ORB Low | `close < orbLow` |
| Volume above avg ORB volume | `volume > avgOrbVolume` |
| RSI(14) bearish | `RSI(14) < 50` |

If neither set passes fully → `HOLD`, showing all rules with pass/fail status.

## Implementation

### `strategies.js`

New export `orbStrategy(candles)`:

1. Compute IST session start (same anchor as `calcVWAP`)
2. Filter to session candles; take first 3 as opening range
3. Compute `orbHigh`, `orbLow`, `avgOrbVolume`
4. Get last candle (current), compute `RSI(14)` via `calcRSI`
5. Evaluate BUY rules, then SELL rules
6. Return `{ signal, indicators, rules }` — same shape as other strategies

Indicators returned: `{ price, orbHigh, orbLow, avgOrbVolume, rsi14 }`

### `analyze.js`

- Import `orbStrategy`
- Add as 4th entry in the strategies array with label `"ORB 15min + RSI(14)"`
- Output row and combined signal count already handle N strategies dynamically

### `tests/strategies.test.js`

Four test cases:
1. **BUY** — close > orbHigh, volume spike, RSI(14) > 50
2. **SELL** — close < orbLow, volume spike, RSI(14) < 50
3. **HOLD** — close above ORB high but RSI(14) < 50 (trend filter blocks)
4. **Insufficient data** — fewer than 3 session candles → HOLD with message

## Out of Scope

- ATR-based stop/target levels (future enhancement)
- Configurable opening range duration (fixed at 15 min / 3 candles)
