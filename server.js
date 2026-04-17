'use strict';

// ─── Chargement .env ──────────────────────────────────────────────────────────
try { require('dotenv').config(); } catch (_) {
  try { process.loadEnvFile('.env'); } catch (_2) {
    try {
      const fs = require('fs'), raw = fs.readFileSync('.env','utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim(); if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('='); if (i===-1) continue;
        const k=t.slice(0,i).trim(), v=t.slice(i+1).trim().replace(/^["']|["']$/g,'');
        if (k && !(k in process.env)) process.env[k]=v;
      }
    } catch(_3){}
  }
}

let useExpress=false, express;
try { express=require('express'); useExpress=true; } catch(_){}

const fs   = require('fs');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT      = parseInt(process.env.PORT||'3000',10);
const PROD_FILE = path.join(__dirname,'products.json');
const BASE_URL  = (process.env.BASE_URL||'http://localhost:'+PORT).replace(/\/$/,'');

// ─── Produits ─────────────────────────────────────────────────────────────────
function loadProducts() {
  try { return JSON.parse(fs.readFileSync(PROD_FILE,'utf-8')); } catch(_){ return []; }
}
function saveProducts(arr) {
  fs.writeFileSync(PROD_FILE, JSON.stringify(arr,null,2),'utf-8');
}

// ─── Auth admin ───────────────────────────────────────────────────────────────
const tokens = new Map();
function makeToken() {
  const t=randomUUID(); tokens.set(t,Date.now()+3600000); return t;
}
function checkToken(t) {
  if(!t||!tokens.has(t)) return false;
  if(Date.now()>tokens.get(t)){ tokens.delete(t); return false; }
  return true;
}
function getBearer(req) {
  const h=req.headers['authorization']||'';
  return h.startsWith('Bearer ')?h.slice(7):null;
}

// ─── Stripe helpers ───────────────────────────────────────────────────────────
let stripe=null;
try { stripe=require('stripe')(process.env.STRIPE_SECRET_KEY); } catch(_){}

async function stripeRequest(method,endpoint,body){
  const key=process.env.STRIPE_SECRET_KEY||'';
  const auth='Basic '+Buffer.from(key+':').toString('base64');
  const res=await fetch('https://api.stripe.com/v1'+endpoint,{
    method, headers:{ Authorization:auth,'Content-Type':'application/x-www-form-urlencoded' },
    body:body?new URLSearchParams(body).toString():undefined
  });
  return res.json();
}

// ─── Body parser ────────────────────────────────────────────────────────────
function readBody(req){
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data',c=>data+=c);
    req.on('end',()=>{ try{resolve(JSON.parse(data||'{}'));}catch(e){resolve({});} });
    req.on('error',reject);
  });
}

// ─── Helpers réponse ──────────────────────────────────────────────────────────
function json(res,status,obj){
  const b=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(b);
}

// ─── CORS preflight ───────────────────────────────────────────────────────────
function cors(res){
  res.writeHead(204,{
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization'
  }); res.end();
}

// ─── Serve static ─────────────────────────────────────────────────────────────
const MIME={
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.ico':'image/x-icon','.svg':'image/svg+xml','.webp':'image/webp'
};
function serveStatic(req,res,urlPath){
  let p=urlPath==='/'?'/index.html':urlPath;
  // route produit et panier
  if(p==='/product'||p.startsWith('/product?')) p='/product.html';
  if(p==='/cart')    p='/cart.html';
  const file=path.join(__dirname,'public',p);
  fs.readFile(file,(err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext=path.extname(file);
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
    res.end(data);
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function router(req,res){
  const url=new URL(req.url,'http://localhost');
  const method=req.method.toUpperCase();
  const pathname=url.pathname;

  if(method==='OPTIONS') return cors(res);

  // ── Produits (public) ──────────────────────────────────────────────────────
  if(pathname==='/api/products' && method==='GET'){
    return json(res,200,loadProducts());
  }
  if(/^\/api\/products\/[^/]+$/.test(pathname) && method==='GET'){
    const id=pathname.split('/').pop();
    const p=loadProducts().find(x=>x.id===id);
    return p?json(res,200,p):json(res,404,{error:'Produit introuvable'});
  }

  // ── Admin login ────────────────────────────────────────────────────────────
  if(pathname==='/api/admin/login' && method==='POST'){
    const body=await readBody(req);
    if(body.password===process.env.ADMIN_PASSWORD)
      return json(res,200,{token:makeToken()});
    return json(res,401,{error:'Mot de passe incorrect'});
  }

  // ── CRUD produits (admin) ──────────────────────────────────────────────────
  if(pathname==='/api/products' && method==='POST'){
    if(!checkToken(getBearer(req))) return json(res,401,{error:'Non autorisé'});
    const body=await readBody(req);
    const products=loadProducts();
    const p={
      id:randomUUID(), name:body.name||'', description:body.description||'',
      descriptionLong:body.descriptionLong||'',
      price:Number(body.price)||0, salePrice:body.salePrice?Number(body.salePrice):null,
      images:Array.isArray(body.images)?body.images:(body.image?[body.image]:[]),
      image:body.images?.[0]||body.image||'', stock:Number(body.stock)||0,
      allowText:!!body.allowText, allowImage:!!body.allowImage
    };
    products.push(p); saveProducts(products);
    return json(res,201,p);
  }
  if(/^\/api\/products\/[^/]+$/.test(pathname) && method==='PUT'){
    if(!checkToken(getBearer(req))) return json(res,401,{error:'Non autorisé'});
    const id=pathname.split('/').pop();
    const body=await readBody(req);
    const products=loadProducts();
    const idx=products.findIndex(x=>x.id===id);
    if(idx===-1) return json(res,404,{error:'Produit introuvable'});
    products[idx]={
      ...products[idx], name:body.name||products[idx].name,
      description:body.description||products[idx].description,
      descriptionLong:body.descriptionLong!==undefined?body.descriptionLong:products[idx].descriptionLong||'',
      price:body.price!==undefined?Number(body.price):products[idx].price,
      salePrice:body.salePrice!==undefined?(body.salePrice?Number(body.salePrice):null):products[idx].salePrice,
      images:Array.isArray(body.images)?body.images:products[idx].images||[],
      image:body.images?.[0]||products[idx].image||'',
      stock:body.stock!==undefined?Number(body.stock):products[idx].stock,
      allowText:body.allowText!==undefined?!!body.allowText:products[idx].allowText,
      allowImage:body.allowImage!==undefined?!!body.allowImage:products[idx].allowImage
    };
    saveProducts(products);
    return json(res,200,products[idx]);
  }
  if(/^\/api\/products\/[^/]+$/.test(pathname) && method==='DELETE'){
    if(!checkToken(getBearer(req))) return json(res,401,{error:'Non autorisé'});
    const id=pathname.split('/').pop();
    const products=loadProducts();
    const idx=products.findIndex(x=>x.id===id);
    if(idx===-1) return json(res,404,{error:'Produit introuvable'});
    products.splice(idx,1); saveProducts(products);
    return json(res,200,{success:true});
  }

  // ── Checkout Stripe ────────────────────────────────────────────────────────
  if(pathname==='/api/create-checkout-session' && method==='POST'){
    const body=await readBody(req);
    // body.cart = [{productId, quantity, customText, customImageUrl}]
    const cart=Array.isArray(body.cart)?body.cart:[];
    if(!cart.length) return json(res,400,{error:'Panier vide'});

    const products=loadProducts();
    const lineItems=[];
    for(const item of cart){
      const p=products.find(x=>x.id===item.productId);
      if(!p) return json(res,400,{error:`Produit introuvable: ${item.productId}`});
      const unitAmount=p.salePrice||p.price;
      lineItems.push({
        price_data:{ currency:'eur', unit_amount:unitAmount,
          product_data:{ name:p.name,
            images:p.images?.length?[p.images[0]]:p.image?[p.image]:[] }
        }, quantity:item.quantity||1
      });
    }

    try {
      let session;
      // Métadonnées de personnalisation
      const meta={};
      cart.forEach((item,i)=>{
        if(item.customText) meta[`item${i}_text`]=String(item.customText).slice(0,250);
        if(item.customImageUrl) meta[`item${i}_img`]=String(item.customImageUrl).slice(0,500);
      });

      if(stripe){
        session=await stripe.checkout.sessions.create({
          payment_method_types:['card'], line_items:lineItems,
          mode:'payment', metadata:meta,
          success_url:`${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:`${BASE_URL}/cancel`
        });
      } else {
        // Fallback API native
        const flat={
          mode:'payment',
          payment_method_types:['card'],
          success_url:`${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:`${BASE_URL}/cancel`
        };
        lineItems.forEach((li,i)=>{
          flat[`line_items[${i}][price_data][currency]`]='eur';
          flat[`line_items[${i}][price_data][unit_amount]`]=li.price_data.unit_amount;
          flat[`line_items[${i}][price_data][product_data][name]`]=li.price_data.product_data.name;
          if(li.price_data.product_data.images?.[0])
            flat[`line_items[${i}][price_data][product_data][images][0]`]=li.price_data.product_data.images[0];
          flat[`line_items[${i}][quantity]`]=li.quantity;
        });
        Object.entries(meta).forEach(([k,v])=>{ flat[`metadata[${k}]`]=v; });
        session=await stripeRequest('POST','/checkout/sessions',flat);
        if(session.error) return json(res,500,{error:session.error.message});
      }
      return json(res,200,{url:session.url});
    } catch(e){
      console.error('Stripe error',e.message);
      return json(res,500,{error:e.message});
    }
  }

  // ── Static ─────────────────────────────────────────────────────────────────
  serveStatic(req,res,url.pathname);
}

// ─── Démarrage serveur ────────────────────────────────────────────────────────
const server=http.createServer(router);
server.listen(PORT,()=>{
  console.log(`✅ L'Atelier Laser — http://localhost:${PORT}`);
  console.log(`   Mode: ${useExpress?'Express':'Node natif'} | Stripe: ${stripe?'OK':'clé manquante'}`);
});
