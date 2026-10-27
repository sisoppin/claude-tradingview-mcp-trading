import "dotenv/config";

const KITE_BASE = "https://api.kite.trade";

function kiteHeaders(accessToken) {
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

async function kiteRequest(accessToken, method, path, body) {
  const res = await fetch(`${KITE_BASE}${path}`, {
    method,
    headers: kiteHeaders(accessToken),
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kite ${method} ${path} failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite order failed: ${data.message}`);
  return data.data;
}

// Round a price onto the instrument's tick grid. Kite rejects off-tick prices.
// "up" for prices that must not be worse than intended on a buy, "down" on a sell.
export function roundToTick(price, tickSize = 0.05, direction = "nearest") {
  const ticks = price / tickSize;
  const n = direction === "up" ? Math.ceil(ticks - 1e-9)
    : direction === "down" ? Math.floor(ticks + 1e-9)
    : Math.round(ticks);
  return Number((n * tickSize).toFixed(4));
}

export function calcQuantity({ tradingsymbol, exchange, sizeINR, price, lotSize = 1 }) {
  if (exchange === "NFO") {
    const lots = Math.floor(sizeINR / (price * lotSize));
    if (lots < 1) {
      throw new Error(
        `Trade size ${sizeINR} too small for one lot of ${tradingsymbol} (needs ~${(price * lotSize).toFixed(2)})`
      );
    }
    return lots * lotSize;
  }
  const quantity = Math.floor(sizeINR / price);
  if (quantity < 1) {
    throw new Error(
      `Trade size ${sizeINR} too small for one share of ${tradingsymbol} at ${price}`
    );
  }
  return quantity;
}

function validateSide(side) {
  if (!["buy", "sell"].includes(side?.toLowerCase())) {
    throw new Error(`Invalid side "${side}" — must be "buy" or "sell"`);
  }
}

// Marketable LIMIT price: crosses the spread like a market order would, but
// never fills more than slippagePct away from the reference price.
export function marketableLimit(side, price, slippagePct, tickSize) {
  return side.toLowerCase() === "buy"
    ? roundToTick(price * (1 + slippagePct / 100), tickSize, "up")
    : roundToTick(price * (1 - slippagePct / 100), tickSize, "down");
}

// Entry order: MIS (intraday) LIMIT. Returns { orderId, quantity, limitPrice }.
export async function placeZerodhaOrder(
  accessToken,
  { tradingsymbol, exchange, side, sizeINR, price, lotSize = 1, tickSize = 0.05, slippagePct = 0.1, quantity }
) {
  if (!price || price <= 0 || !isFinite(price)) {
    throw new Error(`Invalid price ${price} for ${tradingsymbol}`);
  }
  validateSide(side);

  const qty = quantity ?? calcQuantity({ tradingsymbol, exchange, sizeINR, price, lotSize });
  const limitPrice = marketableLimit(side, price, slippagePct, tickSize);

  const data = await kiteRequest(accessToken, "POST", "/orders/regular", new URLSearchParams({
    tradingsymbol,
    exchange,
    transaction_type: side.toUpperCase(),
    order_type: "LIMIT",
    price: limitPrice.toString(),
    quantity: qty.toString(),
    product: "MIS",
    validity: "DAY",
  }));

  return { orderId: data.order_id, quantity: qty, limitPrice };
}

// Protective stop: an SL (stop-limit) order on the opposite side. SL rather than
// SL-M because exchanges restrict SL-M on some F&O contracts. The limit sits
// limitBufferPct beyond the trigger so a fast move still fills.
export async function placeStopOrder(
  accessToken,
  { tradingsymbol, exchange, side, quantity, triggerPrice, tickSize = 0.05, limitBufferPct = 1 }
) {
  validateSide(side);
  const isSell = side.toLowerCase() === "sell";
  const trigger = roundToTick(triggerPrice, tickSize, isSell ? "down" : "up");
  const limit = isSell
    ? roundToTick(trigger * (1 - limitBufferPct / 100), tickSize, "down")
    : roundToTick(trigger * (1 + limitBufferPct / 100), tickSize, "up");

  const data = await kiteRequest(accessToken, "POST", "/orders/regular", new URLSearchParams({
    tradingsymbol,
    exchange,
    transaction_type: side.toUpperCase(),
    order_type: "SL",
    trigger_price: trigger.toString(),
    price: limit.toString(),
    quantity: quantity.toString(),
    product: "MIS",
    validity: "DAY",
  }));
  return { orderId: data.order_id, triggerPrice: trigger, limitPrice: limit };
}

// Latest state of an order: { status, filledQuantity, averagePrice }.
export async function getOrder(accessToken, orderId) {
  const history = await kiteRequest(accessToken, "GET", `/orders/${orderId}`);
  const last = history[history.length - 1] || {};
  return {
    status: last.status,
    filledQuantity: Number(last.filled_quantity) || 0,
    averagePrice: Number(last.average_price) || 0,
  };
}

export async function cancelOrder(accessToken, orderId) {
  return kiteRequest(accessToken, "DELETE", `/orders/regular/${orderId}`);
}

const FINAL = new Set(["COMPLETE", "CANCELLED", "REJECTED"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until the order is final or timeoutMs passes. If it is still open at the
// timeout, cancel what is left, so nothing unexpected fills later unprotected.
// Returns the final { status, filledQuantity, averagePrice }.
export async function waitForFill(accessToken, orderId, { timeoutMs = 15000, pollMs = 1500, wait = sleep } = {}) {
  let order = await getOrder(accessToken, orderId);
  for (let waited = 0; !FINAL.has(order.status) && waited < timeoutMs; waited += pollMs) {
    await wait(pollMs);
    order = await getOrder(accessToken, orderId);
  }
  if (!FINAL.has(order.status)) {
    await cancelOrder(accessToken, orderId).catch(() => {});
    order = await getOrder(accessToken, orderId);
  }
  return order;
}
