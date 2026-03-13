import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.toLowerCase().trim() || '';

    const store = getStore({ name: 'price-data', consistency: 'strong' });

    let db = { items: {}, receipts: [] };
    try {
      const existing = await store.get('database', { type: 'json' });
      if (existing) db = existing;
    } catch { /* empty db */ }

    const allItems = Object.values(db.items);

    if (!query) {
      // Return stats + all item names for autocomplete
      const stats = {
        totalItems: allItems.length,
        totalReceipts: db.receipts.length,
        supermarkets: [...new Set(db.receipts.map(r => r.supermarket))],
        recentReceipts: db.receipts.slice(-5).reverse(),
        itemNames: allItems.map(i => i.name).sort()
      };
      return new Response(JSON.stringify(stats), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // Search items matching query
    const matched = allItems.filter(item =>
      item.name.toLowerCase().includes(query)
    );

    if (matched.length === 0) {
      return new Response(JSON.stringify({ results: [], message: 'No prices found for that item yet. Be the first to upload a receipt!' }), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // For each matched item, get latest price per supermarket
    const results = matched.map(item => {
      // Get most recent price per supermarket
      const bySuper = {};
      for (const p of item.prices) {
        if (!bySuper[p.supermarket] || p.date > bySuper[p.supermarket].date) {
          bySuper[p.supermarket] = p;
        }
      }

      const prices = Object.values(bySuper).sort((a, b) => a.price - b.price);
      const cheapest = prices[0];
      const mostExpensive = prices[prices.length - 1];
      const saving = prices.length > 1 ? mostExpensive.price - cheapest.price : 0;

      return {
        name: item.name,
        prices,
        cheapest,
        saving,
        priceCount: prices.length
      };
    });

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json', ...CORS }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }
};

export const config = { path: '/api/search' };
