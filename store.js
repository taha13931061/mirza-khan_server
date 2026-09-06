// Real-money store — Aqaye Pardakht (آقای پرداخت) gateway.
//
// Flow: game links to /shop/?token=<jwt> → shop page calls purchase-init → we create a
// pending row + ask the gateway for a payment URL → user pays on the gateway's own page →
// gateway calls OUR server directly (not through the user's browser) at /api/store/verify
// → we re-verify with the gateway using the amount WE stored (never trust anything the
// request claims) → only then do we credit coins/gems → then we show a result page.
//
// PIN comes from AQAYEPARDAKHT_PIN env var. Until Aqaye Pardakht approves the real site
// and issues a real pin, "sandbox" is a real, documented test value — it exercises the
// exact same endpoints with no real money moving, so this code needs zero changes later,
// just swap the env var.
//
// Package definitions themselves live in storePackages.js (Supabase-backed) now, so the
// admin panel can add/remove them without a redeploy — this file only talks to the gateway.

const AQAYEPARDAKHT_PIN = process.env.AQAYEPARDAKHT_PIN || 'sandbox';
const CREATE_URL = 'https://panel.aqayepardakht.ir/api/v2/create';
const VERIFY_URL = 'https://panel.aqayepardakht.ir/api/v2/verify';
const STARTPAY_BASE = 'https://panel.aqayepardakht.ir/startpay/';

async function gatewayCreate({ amountToman, callbackUrl, invoiceId, description }) {
  const res = await fetch(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pin: AQAYEPARDAKHT_PIN, amount: amountToman, callback: callbackUrl, callback_method: 'GET',
      invoice_id: String(invoiceId), description: description || 'خرید داخل بازی میرزاخان'
    })
  });
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'success' || !data.transid) {
    throw new Error('gateway create failed: ' + JSON.stringify(data));
  }
  return { transId: data.transid, paymentUrl: STARTPAY_BASE + data.transid };
}

async function gatewayVerify({ amountToman, transId }) {
  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: AQAYEPARDAKHT_PIN, amount: amountToman, transid: transId })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: Number(data.code) === 1, raw: data };
}

module.exports = { gatewayCreate, gatewayVerify, AQAYEPARDAKHT_PIN };
