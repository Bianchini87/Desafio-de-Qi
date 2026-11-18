const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const PRICE_CENTS = 490;
const PAGBANK_BASE = process.env.PAGBANK_ENV === 'sandbox'
  ? 'https://sandbox.api.pagseguro.com'
  : 'https://api.pagseguro.com';
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;



app.get('/api/health', (_req,res) => res.json({ok:true, database:!!supabase, paymentConfigured:!!process.env.PAGBANK_TOKEN}));
async function loadQuestions() {
  if (!supabase) throw new Error('Banco de dados ainda nao configurado.');
  const { data, error } = await supabase
    .from('qi_questions')
    .select('id,question,option_a,option_b,option_c,option_d,correct_answer')
    .order('id', { ascending: true });
  if (error) throw error;
  if (!data || data.length !== 25) throw new Error('O banco precisa conter exatamente 25 perguntas.');
  return data;
}

app.get('/api/questions', async (_req,res) => {
  try {
    const rows = await loadQuestions();
    const questions = rows.map(row => ({
      q: row.question,
      o: [row.option_a,row.option_b,row.option_c,row.option_d]
    }));
    res.json({questions,total:25,price:4.90});
  } catch (error) {
    console.error('questions:', error);
    res.status(503).json({error:'Nao foi possivel carregar as perguntas.'});
  }
});

function isValidCPF(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

async function pagbankRequest(url, options={}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + process.env.PAGBANK_TOKEN, Accept:'application/json', 'Content-Type':'application/json', ...(options.headers||{}) }
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error('PagBank HTTP ' + response.status + ': ' + (data.error_messages?.[0]?.description || data.message || JSON.stringify(data) || 'Falha ao comunicar com PagBank'));
  return data;
}

app.post('/api/checkout', async (req,res) => {
  try {
    if (!supabase) return res.status(503).json({error:'Banco de dados ainda nao configurado.'});
    if (!process.env.PAGBANK_TOKEN) return res.status(503).json({error:'Pagamento ainda nao configurado.'});
    const {name,email,cpf,answers} = req.body || {};
    const cpfDigits = String(cpf || '').replace(/\D/g, '');
    if (!isValidCPF(cpfDigits)) return res.status(400).json({error:'Informe um CPF válido com 11 dígitos.'});
    if (!name || String(name).trim().length < 2 || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Informe nome e e-mail validos.'});
    const cpfDigits = String(cpf || '').replace(/\D/g, '');
    if (!isValidCPF(cpfDigits)) return res.status(400).json({error:'Informe um CPF válido com 11 dígitos.'});
    if (!Array.isArray(answers) || answers.length !== 25 || answers.some(x=>!Number.isInteger(x)||x<0||x>3)) return res.status(400).json({error:'Responda as 25 perguntas antes de continuar.'});
    const questionRows = await loadQuestions();
    const score = answers.reduce((sum,answer,i)=>sum+(answer === 'ABCD'.indexOf(String(questionRows[i].correct_answer).toUpperCase()) ? 1 : 0),0);
    const attemptId = crypto.randomUUID();
    const baseUrl = process.env.APP_BASE_URL;
    if (!baseUrl) return res.status(503).json({error:'APP_BASE_URL nao configurada no servidor.'});
    const {error:dbError} = await supabase.from('qi_attempts').insert({id:attemptId,buyer_name:String(name).trim().slice(0,100),buyer_email:String(email).trim().toLowerCase(),answers,score,total:25});
    if (dbError) throw dbError;
    const order = await pagbankRequest(PAGBANK_BASE+'/orders', {
      method:'POST',
      body:JSON.stringify({
        reference_id:attemptId,
        customer:{name:String(name).trim().slice(0,100),email:String(email).trim().toLowerCase(),tax_id:cpfDigits},
        items:[{reference_id:'desafio-qi-25',name:'Desafio de QI - Teste com 25 perguntas',quantity:1,unit_amount:PRICE_CENTS}],
        charges:[{description:'Acesso ao resultado do Desafio de QI',amount:{value:PRICE_CENTS,currency:'BRL'},payment_method:{type:'PIX',pix:{expiration_date:new Date(Date.now()+30*60*1000).toISOString()}}}],
        notification_urls:[baseUrl.replace(/\/$/,'')+'/api/pagbank/webhook']
      })
    });
    const charge = order.charges?.[0] || {};
    // Na API Order do PagBank, qr_code e links ficam diretamente na cobrança.
    const qr = charge.qr_code || {};
    const qrImage = charge.links?.find(x=>x.rel==='QRCODE.PNG')?.href || null;
    const {error:updateError} = await supabase.from('qi_attempts').update({pagbank_order_id:order.id}).eq('id',attemptId);
    if (updateError) throw updateError;
    res.json({attemptId,orderId:order.id,copyPaste:qr.text||null,qrImage,status:charge.status||'WAITING'});
  } catch (error) {
    console.error('checkout:',error);
    res.status(500).json({error:'Nao foi possivel gerar o PIX. Tente novamente.'});
  }
});

async function verifiedOrderStatus(orderId) {
  const order = await pagbankRequest(PAGBANK_BASE+'/orders/'+encodeURIComponent(orderId));
  const charges = order.charges || [];
  return charges.some(c=>c.status==='PAID') ? 'PAID' : (charges[0]?.status || 'WAITING');
}

app.get('/api/payment/:attemptId', async (req,res) => {
  try {
    if (!supabase) return res.status(503).json({error:'Banco de dados nao configurado.'});
    const {data,error} = await supabase.from('qi_attempts').select('id,pagbank_order_id,payment_status,score,total').eq('id',req.params.attemptId).maybeSingle();
    if (error || !data) return res.status(404).json({error:'Pedido nao encontrado.'});
    let status = data.payment_status;
    if (data.pagbank_order_id && status !== 'PAID' && process.env.PAGBANK_TOKEN) {
      status = await verifiedOrderStatus(data.pagbank_order_id);
      if (status === 'PAID') await supabase.from('qi_attempts').update({payment_status:'PAID',paid_at:new Date().toISOString()}).eq('id',data.id);
    }
    const result = {status};
    if (status === 'PAID') result.result = {score:data.score,total:data.total,percentage:Math.round(data.score/data.total*100)};
    res.json(result);
  } catch (error) {
    console.error('payment status:',error);
    res.status(500).json({error:'Nao foi possivel consultar o pagamento.'});
  }
});

app.post('/api/pagbank/webhook', async (req,res) => {
  try {
    const orderId = req.body?.id;
    if (!orderId || !supabase || !process.env.PAGBANK_TOKEN) return res.sendStatus(200);
    // Confere o status diretamente na API PagBank; nao confia apenas no corpo recebido.
    const status = await verifiedOrderStatus(orderId);
    if (status === 'PAID') await supabase.from('qi_attempts').update({payment_status:'PAID',paid_at:new Date().toISOString()}).eq('pagbank_order_id',orderId);
    res.sendStatus(200);
  } catch (error) {
    console.error('webhook:',error);
    res.sendStatus(500);
  }
});

app.use((req,res,next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname,'public','index.html'));
});
app.listen(PORT,()=>console.log('Desafio de QI rodando na porta '+PORT));