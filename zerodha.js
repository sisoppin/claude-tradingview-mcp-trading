import "dotenv/config";

const KITE_BASE = "https://api.kite.trade";

function kiteHeaders(accessToken) {
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function placeZerodhaOrder(
  accessToken,
  { tradingsymbol, exchange, side, sizeUSD, price, lotSize = 1 }
) {
  if (!price || price <= 0 || !isFinite(price)) {
    throw new Error(`Invalid price ${price} for ${tradingsymbol}`);
  }

  let quantity;

  if (exchange === "NFO") {
    const lots = Math.floor(sizeUSD / (price * lotSize));
    if (lots < 1) {
      throw new Error(
        `Trade size ${sizeUSD} too small for one lot of ${tradingsymbol} (needs ~${(price * lotSize).toFixed(2)})`
      );
    }
    quantity = lots * lotSize;
  } else {
    quantity = Math.floor(sizeUSD / price);
    if (quantity < 1) {
      throw new Error(
        `Trade size ${sizeUSD} too small for one share of ${tradingsymbol} at ${price}`
      );
    }
  }

  const body = new URLSearchParams({
    tradingsymbol,
    exchange,
    transaction_type: side.toUpperCase(),
    order_type: "MARKET",
    quantity: quantity.toString(),
    product: "MIS",
  });

  const res = await fetch(`${KITE_BASE}/orders/regular`, {
    method: "POST",
    headers: kiteHeaders(accessToken),
    body,
  });

  if (!res.ok) {
    const body2 = await res.text().catch(() => "");
    throw new Error(`Kite order request failed with HTTP ${res.status}: ${body2.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite order failed: ${data.message}`);

  return { orderId: data.data.order_id, quantity };
}
