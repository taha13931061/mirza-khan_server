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

const AQAYEPARDAKHT_PIN = process.env.AQAYEPARDAKHT_PIN || 'sandbox';
const CREATE_URL = 'https://panel.aqayepardakht.ir/api/v2/create';
const VERIFY_URL = 'https://panel.aqayepardakht.ir/api/v2/verify';
const STARTPAY_BASE = 'https://panel.aqayepardakht.ir/startpay/';

// EXAMPLE prices — these are placeholders, not a real pricing decision. Edit freely;
// nothing else in the code needs to change when you do.
const PACKAGES = {
  coins_100: { type: 'coins', amount: 100, priceToman: 15000, label: '۱۰۰ سکه' },
  coins_550: { type: 'coins', amount: 550, priceToman: 65000, label: '۵۵۰ سکه (۵۰۰ + ۵۰ هدیه)' },
  gems_20: { type: 'gems', amount: 20, priceToman: 25000, label: '۲۰ جم' },
  gems_110: { type: 'gems', amount: 110, priceToman: 110000, label: '۱۱۰ جم (۱۰۰ + ۱۰ هدیه)' },
};

function listPackages() {
  return Object.entries(PACKAGES).map(([id, p]) => ({ id, label: p.label, priceToman: p.priceToman, type: p.type, amount: p.amount }));
}
function getPackage(id) {
  return PACKAGES[id] || null;
}

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

module.exports = { listPackages, getPackage, gatewayCreate, gatewayVerify, AQAYEPARDAKHT_PIN };
