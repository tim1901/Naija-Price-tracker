import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPERMARKETS = ['Shoprite', 'Spar', 'Justrite', 'Marketplace', 'Hubmart', 'PriceMart', 'Finrel'];

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { image, mimeType } = await req.json();

    if (!image) throw new Error('No image provided');

    // ── Ask Claude to read the receipt ──────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image }
            },
            {
              type: 'text',
              text: `You are reading a Nigerian supermarket receipt. Extract all items and prices.

Return ONLY a JSON object in this exact format, nothing else:
{
  "supermarket": "name of supermarket (one of: Shoprite, Spar, Justrite, Marketplace, Hubmart, PriceMart, Finrel, or Other)",
  "date": "date on receipt as YYYY-MM-DD, or today if not visible",
  "items": [
    { "name": "item name in lowercase", "price": 1500, "unit": "1kg or 1L or each etc" }
  ]
}

Rules:
- Price must be a number in Naira (no symbols)
- Item name must be clean and lowercase (e.g. "tomatoes", "indomie noodles", "eva water 75cl")
- If you cannot read the receipt clearly, return { "error": "Could not read receipt" }
- Return ONLY the JSON, no other text`
            }
          ]
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Could not parse receipt. Please try a clearer photo.');
    }

    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.items || parsed.items.length === 0) throw new Error('No items found on receipt.');

    // ── Save to Netlify Blobs ────────────────────────────────────
    const store = getStore({ name: 'price-data', consistency: 'strong' });

    // Load existing data
    let db = { items: {}, receipts: [] };
    try {
      const existing = await store.get('database', { type: 'json' });
      if (existing) db = existing;
    } catch { /* first time, start fresh */ }

    const supermarket = parsed.supermarket || 'Unknown';
    const date = parsed.date || new Date().toISOString().slice(0, 10);

    // Merge new prices into db
    for (const item of parsed.items) {
      const key = item.name.toLowerCase().trim();
      if (!db.items[key]) db.items[key] = { name: item.name, prices: [] };

      // Remove old entry from same supermarket if older than 30 days
      db.items[key].prices = db.items[key].prices.filter(p => {
        const age = (Date.now() - new Date(p.date).getTime()) / (1000 * 60 * 60 * 24);
        return !(p.supermarket === supermarket && age > 30);
      });

      // Add new price
      db.items[key].prices.push({
        supermarket,
        price: item.price,
        unit: item.unit || 'each',
        date
      });
    }

    // Store receipt log
    db.receipts.push({ supermarket, date, itemCount: parsed.items.length, addedAt: new Date().toISOString() });
    if (db.receipts.length > 500) db.receipts = db.receipts.slice(-500); // cap at 500

    await store.set('database', JSON.stringify(db));

    return new Response(JSON.stringify({
      success: true,
      supermarket,
      date,
      itemsAdded: parsed.items.length,
      items: parsed.items
    }), { headers: { 'Content-Type': 'application/json', ...CORS } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
};

export const config = { path: '/api/upload-receipt' };
