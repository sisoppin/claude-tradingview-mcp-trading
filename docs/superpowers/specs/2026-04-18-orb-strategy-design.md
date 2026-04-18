# Opening Range Breakout (ORB) Strategy Design

**Date:** 2026-04-18  
**Status:** Approved

---

## Overview

Add a 15-minute Opening Range Breakout strategy to `strategies.js` as a fourth strategy alongside the existing VWAP+EMA+RSI, MACD, and Bollinger Bands strategies.

## Opening Range Definition

- **Session anchor:** IST midnight (18:30 UTC previous day) — same anchor used by `calcVWAP`
- **Opening range candles:** first 3 candles of the session (9:15–9:30 AM IST on 5m timeframe)
- **ORB High:** `max(high)` of those 3 candles
- **ORB Low:** `min(low)` of those 3 candles
- **Avg ORB Volume:** `mean(volume)` of those 3 candles

If fewer than 3 session candles exist, return `HOLD` with rule `"Opening range not yet formed (need 3 candles)"`.

## Signal Logic

All 5 rules must pass simultaneously for a signal. The current candle is the last candle in the dataset.

### BUY — breakout above range

| Rule | Condition |
|------|-----------|
| Close above ORB High | `close > orbHigh` |
| Volume confirms breakout | `volume > avgOrbVolume × 1.2` |
| RSI(14) bullish momentum | `RSI(14) > 55` |
| Market trend bullish | `price > VWAP` |
| Within time window | candle time between 9:30–11:30 AM IST |

### SELL — breakdown below range

| Rule | Condition |
|------|-----------|
| Close below ORB Low | `close < orbLow` |
| Volume confirms breakdown | `volume > avgOrbVolume × 1.2` |
| RSI(14) bearish momentum | `RSI(14) < 45` |
| Market trend bearish | `price < VWAP` |
| Within time window | candle time between 9:30–11:30 AM IST |

If neither set passes fully → `HOLD`, showing all rules with pass/fail status.

## Time Window

- **Window:** 9:30 AM – 11:30 AM IST (04:00 – 06:00 UTC)
- Signals outside this window return `HOLD` with `"Outside ORB signal window (9:30–11:30 IST)"` as a failing rule
- VWAP is computed using the same IST session anchor

## Implementation

### `strategies.js`

New export `orbStrategy(candles)`:

1. Compute IST session start (18:30 UTC anchor)
2. Filter to session candles; take first 3 as opening range
3. Compute `orbHigh`, `orbLow`, `avgOrbVolume`
4. Compute `VWAP` via existing `calcVWAP` logic
5. Compute `RSI(14)` via `calcRSI`
6. Get last candle — `close`, `volume`, `time`
7. Determine if current candle time is within 9:30–11:30 AM IST (04:00–06:00 UTC)
8. Evaluate all 5 BUY rules, then all 5 SELL rules
9. Return `{ signal, indicators, rules }` — same shape as other strategies

Indicators returned: `{ price, orbHigh, orbLow, avgOrbVolume, vwap, rsi14 }`

### `analyze.js`

- Import `orbStrategy`
- Add as 4th entry in the strategies array with label `"ORB 15min + RSI(14)"`
- Output row and combined signal count handle N strategies dynamically — no other changes needed

### `tests/strategies.test.js`

Five test cases:
1. **BUY** — close > orbHigh, volume > 1.2× avg, RSI > 55, price > VWAP, within window
2. **SELL** — close < orbLow, volume > 1.2× avg, RSI < 45, price < VWAP, within window
3. **HOLD (trend filter)** — close above ORB high but price < VWAP (bearish trend blocks)
4. **HOLD (time window)** — all price/volume/RSI conditions met but outside 9:30–11:30 AM IST
5. **Insufficient data** — fewer than 3 session candles → HOLD with "not yet formed" message

## Out of Scope

- ATR-based stop/target levels (future enhancement)
- Configurable opening range duration (fixed at 15 min / 3 candles)
- Configurable time window (fixed at 9:30–11:30 AM IST)
