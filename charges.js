// Zerodha intraday (MIS) equity charges for one executed order. An estimate:
// the contract note is the real number. Rates from https://zerodha.com/charges —
// check them each financial year.
const RATES = {
  brokeragePct: 0.03, brokerageCap: 20,
  sttSellPct: 0.025,
  nseTxnPct: 0.00307,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
  gstPct: 18,
};

export function estimateCharges(side, value, rates = RATES) {
  const pct = (p) => (value * p) / 100;
  const isBuy = side.toLowerCase() === "buy";
  const brokerage = Math.min(pct(rates.brokeragePct), rates.brokerageCap);
  const stt = isBuy ? 0 : pct(rates.sttSellPct);
  const txn = pct(rates.nseTxnPct);
  const sebi = (value / 1e7) * rates.sebiPerCrore;
  const stamp = isBuy ? pct(rates.stampBuyPct) : 0;
  const gst = ((brokerage + txn + sebi) * rates.gstPct) / 100;
  return Math.round((brokerage + stt + txn + sebi + stamp + gst) * 100) / 100;
}
