/**
 * L'Atelier Laser — Serveur
 *
 * Ce fichier a deux modes de fonctionnement :
 *
 * 1. AVEC npm (recommandé) : après `npm install`, il utilise express + stripe + dotenv
 * 2. SANS npm (fallback)   : fonctionne avec les seuls modules natifs Node.js 18+
 *                            (http, fs, path, crypto, fetch natif pour Stripe)
 *
 * Démarrage : npm install && node server.js
 * Ou sans dépendances : node server.js
 */

'use strict';

// ─── Chargement .env ──────────────────────────────────────────────────────────
try {
  require('dotenv').config();
} catch (_) {
  // dotenv absent : on essaie le chargement natif Node 22+ puis le parsing manuel
  try {
    process.loadEnvFile('.env');
  } catch (_2) {
    try {
      const fs  = require('fs');
      const raw = fs.readFileSync('.env', 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
      }
    } catch (_3) { /* .env absent */ }
  }
}

// ─── Tentative de chargement d'Express ────────────────────────────────────────
let useExpress = false;
let express;
try {
  express = require('express');
  useExpress = true;
} catch (_) { /* pas installé */ }

const fs     = require('fs');
const http   = require('http');
const path   = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT           = parseInt(process.env.PORT || '3000', 10);
const PRODUCTS_FILE  = path.join(__dirname, 'products.json');
const PUBLIC_DIR     = path.join(__dirname, 'public');

// ─── Stripe (npm ou fetch natif) ──────────────────────────────────────────────
let stripe = null;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const stripeConfigured =
  STRIPE_KEY && STRIPE_KEY !== 'sk_test_VOTRE_CLE_SECRETE_ICI';

if (stripeConfigured) {
  try {
    stripe = require('stripe')(STRIPE_KEY);
  } catch (_) {
    // stripe npm absent — on utilisera fetch natif (voir createCheckoutSession)
    stripe = 'native';
  }
}

// ─── Helpers produits ──────────────────────────────────────────────────────────
function readProducts() {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf-8')); }
  catch (_) { return []; }
}
function writeProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf-8');
}
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ─── Tokens admin ─────────────────────────────────────────────────────────────
const validTokens = new Set();

function checkAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  return validTokens.has(authHeader.split(' ')[1]);
}

// ─── Stripe via fetch natif ────────────────────────────────────────────────────
async function createStripeSession(product, baseUrl) {
  const body = new URLSearchParams({
    'payment_method_types[0]':                   'card',
    'line_items[0][price_data][currency]':        'eur',
    'line_items[0][price_data][unit_amount]':     String(product.price),
    'line_items[0][price_data][product_data][name]':        product.name,
    'line_items[0][price_data][product_data][description]': product.description,
    'line_items[0][quantity]':  '1',
    'mode':                     'payment',
    'success_url':              `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url':               `${baseUrl}/cancel.html`,
    'metadata[productId]':      product.id,
  });
  if (product.image) {
    body.set('line_items[0][price_data][product_data][images][0]', product.image);
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Erreur Stripe');
  return data;
}

// ─── MIME types pour le serveur statique minimal ──────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODE EXPRESS
// ═══════════════════════════════════════════════════════════════════════════════

if (useExpress) {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // Auth middleware
  function requireAuth(req, res, next) {
    if (!checkAuth(req.headers['authorization'])) {
      return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
  }

  // GET /api/products
  app.get('/api/products', (_req, res) => res.json(readProducts()));

  // POST /api/admin/login
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    if (!password || password !== (process.env.ADMIN_PASSWORD || 'admin123')) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    setTimeout(() => validTokens.delete(token), 8 * 60 * 60 * 1000);
    res.json({ token });
  });

  // POST /api/create-checkout-session
  app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripeConfigured) {
      return res.status(503).json({
        error: 'Stripe non configuré. Ajoutez STRIPE_SECRET_KEY dans votre fichier .env',
      });
    }
    const { productId } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId manquant' });

    const products = readProducts();
    const product  = products.find(p => p.id === productId);
    if (!product) return res.status(404).json({ error: 'Produit introuvable' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Produit en rupture de stock' });

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    try {
      let session;
      if (stripe && stripe !== 'native') {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'eur',
              product_data: {
                name: product.name, description: product.description,
                images: product.image ? [product.image] : [],
              },
              unit_amount: product.price,
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${baseUrl}/cancel.html`,
          metadata:    { productId: product.id },
        });
      } else {
        session = await createStripeSession(product, baseUrl);
      }
      res.json({ url: session.url });
    } catch (err) {
      console.error('Erreur Stripe:', err.message);
      res.status(500).json({ error: 'Erreur lors de la création de la session de paiement' });
    }
  });

  // POST /api/products (admin)
  app.post('/api/products', requireAuth, (req, res) => {
    const { name, description, price, image, stock } = req.body || {};
    if (!name || !description || price === undefined) {
      return res.status(400).json({ error: 'Champs obligatoires manquants : name, description, price' });
    }
    const products   = readProducts();
    const newProduct = {
      id: generateId(), name: String(name).trim(),
      description: String(description).trim(), price: parseInt(price, 10),
      image: image ? String(image).trim() : '', stock: parseInt(stock, 10) || 0,
    };
    products.push(newProduct);
    writeProducts(products);
    res.status(201).json(newProduct);
  });

  // PUT /api/products/:id (admin)
  app.put('/api/products/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { name, description, price, image, stock } = req.body || {};
    const products = readProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Produit introuvable' });
    products[idx] = {
      ...products[idx],
      name:        name        !== undefined ? String(name).trim()        : products[idx].name,
      description: description !== undefined ? String(description).trim() : products[idx].description,
      price:       price       !== undefined ? parseInt(price, 10)        : products[idx].price,
      image:       image       !== undefined ? String(image).trim()       : products[idx].image,
      stock:       stock       !== undefined ? parseInt(stock, 10)        : products[idx].stock,
    };
    writeProducts(products);
    res.json(products[idx]);
  });

  // DELETE /api/products/:id (admin)
  app.delete('/api/products/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const products = readProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Produit introuvable' });
    const [deleted] = products.splice(idx, 1);
    writeProducts(products);
    res.json({ message: 'Produit supprimé', product: deleted });
  });

  app.get('/admin', (_req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

  app.listen(PORT, startupMessage);

} else {
  // ═══════════════════════════════════════════════════════════════════════════
  // MODE FALLBACK — serveur HTTP natif Node.js (zéro dépendance)
  // ═══════════════════════════════════════════════════════════════════════════

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname  = parsedUrl.pathname;
    const method    = req.method.toUpperCase();

    // Helper réponse JSON
    function jsonRes(status, obj) {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    }

    // Helper lire le body JSON
    function readBody() {
      return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => {
          try { resolve(JSON.parse(data || '{}')); }
          catch (_) { resolve({}); }
        });
      });
    }

    // Auth helper
    function authOk() { return checkAuth(req.headers['authorization']); }

    // ── API Routes ───────────────────────────────────────────
    if (pathname === '/api/products' && method === 'GET') {
      return jsonRes(200, readProducts());
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const { password } = await readBody();
      if (!password || password !== (process.env.ADMIN_PASSWORD || 'admin123')) {
        return jsonRes(401, { error: 'Mot de passe incorrect' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      validTokens.add(token);
      setTimeout(() => validTokens.delete(token), 8 * 60 * 60 * 1000);
      return jsonRes(200, { token });
    }

    if (pathname === '/api/create-checkout-session' && method === 'POST') {
      if (!stripeConfigured) {
        return jsonRes(503, { error: 'Stripe non configuré. Ajoutez STRIPE_SECRET_KEY dans .env' });
      }
      const { productId } = await readBody();
      if (!productId) return jsonRes(400, { error: 'productId manquant' });

      const products = readProducts();
      const product  = products.find(p => p.id === productId);
      if (!product)          return jsonRes(404, { error: 'Produit introuvable' });
      if (product.stock <= 0) return jsonRes(400, { error: 'Produit en rupture de stock' });

      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      try {
        const session = await createStripeSession(product, baseUrl);
        return jsonRes(200, { url: session.url });
      } catch (err) {
        console.error('Erreur Stripe:', err.message);
        return jsonRes(500, { error: 'Erreur lors de la création de la session de paiement' });
      }
    }

    if (pathname === '/api/products' && method === 'POST') {
      if (!authOk()) return jsonRes(401, { error: 'Non autorisé' });
      const { name, description, price, image, stock } = await readBody();
      if (!name || !description || price === undefined) {
        return jsonRes(400, { error: 'Champs obligatoires manquants : name, description, price' });
      }
      const products   = readProducts();
      const newProduct = {
        id: generateId(), name: String(name).trim(),
        description: String(description).trim(), price: parseInt(price, 10),
        image: image ? String(image).trim() : '', stock: parseInt(stock, 10) || 0,
      };
      products.push(newProduct);
      writeProducts(products);
      return jsonRes(201, newProduct);
    }

    // PUT /api/products/:id
    const putMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (putMatch && method === 'PUT') {
      if (!authOk()) return jsonRes(401, { error: 'Non autorisé' });
      const id = putMatch[1];
      const { name, description, price, image, stock } = await readBody();
      const products = readProducts();
      const idx = products.findIndex(p => p.id === id);
      if (idx === -1) return jsonRes(404, { error: 'Produit introuvable' });
      products[idx] = {
        ...products[idx],
        name:        name        !== undefined ? String(name).trim()        : products[idx].name,
        description: description !== undefined ? String(description).trim() : products[idx].description,
        price:       price       !== undefined ? parseInt(price, 10)        : products[idx].price,
        image:       image       !== undefined ? String(image).trim()       : products[idx].image,
        stock:       stock       !== undefined ? parseInt(stock, 10)        : products[idx].stock,
      };
      writeProducts(products);
      return jsonRes(200, products[idx]);
    }

    // DELETE /api/products/:id
    const delMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
    if (delMatch && method === 'DELETE') {
      if (!authOk()) return jsonRes(401, { error: 'Non autorisé' });
      const id = delMatch[1];
      const products = readProducts();
      const idx = products.findIndex(p => p.id === id);
      if (idx === -1) return jsonRes(404, { error: 'Produit introuvable' });
      const [deleted] = products.splice(idx, 1);
      writeProducts(products);
      return jsonRes(200, { message: 'Produit supprimé', product: deleted });
    }

    // ── Fichiers statiques ───────────────────────────────────
    let filePath = pathname === '/' ? '/index.html' : pathname;
    if (pathname === '/admin') filePath = '/admin.html';

    // Sécurisation : interdire les chemins avec ".."
    const absPath = path.join(PUBLIC_DIR, path.normalize(filePath));
    if (!absPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(absPath, (err, data) => {
      if (err) {
        // 404 — servir index.html par défaut
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(d2);
        });
        return;
      }
      const ext      = path.extname(absPath).toLowerCase();
      const mimeType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(data);
    });
  });

  server.listen(PORT, startupMessage);
}

// ─── Message de démarrage ─────────────────────────────────────────────────────
function startupMessage() {
  console.log(`\n L'Atelier Laser — serveur demarré (mode: ${useExpress ? 'Express' : 'natif Node.js'})`);
  console.log(`  Boutique  : http://localhost:${PORT}`);
  console.log(`  Admin     : http://localhost:${PORT}/admin`);
  if (!stripeConfigured) {
    console.log('\n  Stripe non configure - ajoutez STRIPE_SECRET_KEY dans .env pour activer les paiements');
  }
  console.log('');
}
