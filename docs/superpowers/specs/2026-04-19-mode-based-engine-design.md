# Mode-Based Trading Engine — Design Spec

**Date:** 2026-04-19  
**Status:** Approved

## Problem

The current `combinedSignal` fires BUY/SELL when ≥2 of 4 strategies agree, regardless of market conditions. This is dangerous because:
- BB + VWAP mean-reversion strategies lose money in trending markets
- ORB + MACD trend strategies generate noise in sideways markets

## Goal

Route to the right strategy group based on detected market mode, so each strategy only fires when market conditions suit it.

---

## Architecture

### Files Changed

| File | Change |
|------|--------|
| `strategies.js` | Add `detectMarketMode(candles)` export |
| `analyze.js` | Replace `combinedSignal` with `modeCombinedSignal`, display mode in output |

No changes to `indicators.js` or strategy functions themselves.

---

## Component 1: `detectMarketMode(candles)` — `strategies.js`

**Logic:**

1. `currentVWAP = calcVWAP(candles)` — full session VWAP
2. `prevVWAP = calcVWAP(candles.slice(0, -3))` — VWAP 3 candles ago
3. `vwapSlope = currentVWAP - prevVWAP`
4. `price = candles[candles.length - 1].close`

**Classification:**

| Condition | Mode |
|-----------|------|
| `price > currentVWAP && vwapSlope > 0` | `"bullish"` |
| `price < currentVWAP && vwapSlope < 0` | `"bearish"` |
| else | `"sideways"` |

**Returns:** `{ mode, vwap, vwapSlope }`

**Edge case:** If VWAP cannot be computed (insufficient session candles), default to `"sideways"`.

---

## Component 2: `modeCombinedSignal(mode, inOrbWindow, results)` — `analyze.js`

Replaces the current `combinedSignal(results)` function.

### Routing Table

| Mode | In ORB Window | Active Strategies | Fire Condition |
|------|--------------|-------------------|----------------|
| `bullish` / `bearish` | yes (9:30–11:30 IST) | ORB + MACD | both agree OR MACD alone |
| `bullish` / `bearish` | no | MACD only | MACD fires |
| `sideways` | any | VWAP+EMA+RSI(3) + BB+RSI(14) | either fires |

**"Both agree"** = ORB and MACD return the same direction (both BUY or both SELL).

**Sideways mode:** Either mean-reversion strategy firing is sufficient — they are independent signals.

**Returns:** `{ signal, mode, activeStrategies, count, total }`

### ORB Window Detection

Reuse the existing UTC time check from `orbStrategy`:
```
utcMinutes >= 240 && utcMinutes <= 360  →  9:30–11:30 IST
```
Compute from `candles[candles.length - 1].time`.

---

## Output Changes

Both terminal and HTML output add:

- **Market Mode** indicator: `BULLISH TREND` / `BEARISH TREND` / `SIDEWAYS`
- **Active Strategies** label: which pair is being used for the combined signal
- VWAP slope value shown in indicators panel

---

## Testing

Existing `tests/strategies.test.js` to cover:

1. `detectMarketMode` returns `"bullish"` when price > VWAP and slope > 0
2. `detectMarketMode` returns `"bearish"` when price < VWAP and slope < 0
3. `detectMarketMode` returns `"sideways"` for mixed signals
4. `detectMarketMode` returns `"sideways"` when VWAP unavailable
5. `modeCombinedSignal` in trending+ORB window uses ORB+MACD
6. `modeCombinedSignal` in trending outside ORB window uses MACD only
7. `modeCombinedSignal` in sideways uses VWAP+BB strategies
