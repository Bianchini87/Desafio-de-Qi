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

const questions = [
  {q:'Qual numero completa a sequencia: 2, 4, 8, 16, __?',o:['20','24','32','36'],a:2},
  {q:'Se todos os bloops sao razzies e todos os razzies sao lazzies, todo bloop e certamente um:',o:['Lazzie','Animal','Razzies e nao lazzie','Nenhum'],a:0},
  {q:'Qual item nao pertence ao grupo?',o:['Triangulo','Quadrado','Circulo','Retangulo'],a:2},
  {q:'Maria tem 3 irmas. Cada irma tem um irmao. Quantos filhos ha na familia?',o:['4','5','7','8'],a:1},
  {q:'Qual numero vem a seguir: 1, 1, 2, 3, 5, 8, __?',o:['11','12','13','15'],a:2},
  {q:'Um relogio marca 3h. Qual o menor angulo entre os ponteiros?',o:['45 graus','60 graus','90 graus','180 graus'],a:2},
  {q:'Se ontem foi domingo, que dia sera amanha?',o:['Segunda','Terca','Quarta','Sabado'],a:1},
  {q:'Qual palavra pode ser formada com as letras de "ROMA"?',o:['AMOR','MORRO','RAMOES','AROMA'],a:0},
  {q:'5 maquinas fazem 5 pecas em 5 minutos. Quanto tempo 100 maquinas levam para fazer 100 pecas?',o:['5 minutos','20 minutos','100 minutos','500 minutos'],a:0},
  {q:'Complete: A, C, E, G, __?',o:['H','I','J','K'],a:1},
  {q:'Um pai tem 40 anos e o filho 10. Daqui a quantos anos o pai tera o dobro da idade do filho?',o:['10','15','20','25'],a:2},
  {q:'Qual numero e diferente dos demais?',o:['16','25','36','48'],a:3},
  {q:'Se  acompanhamos a direcao: norte, leste, sul, oeste, __?',o:['Norte','Nordeste','Sudeste','Sul'],a:0},
  {q:'Ana e mais alta que Bia. Bia e mais alta que Clara. Quem e a mais baixa?',o:['Ana','Bia','Clara','Nao e possivel saber'],a:2},
  {q:'Qual e 15% de 200?',o:['15','20','30','35'],a:2},
  {q:'Complete a analogia: livro esta para ler assim como garfo esta para:',o:['Cozinhar','Comer','Cortar','Escrever'],a:1},
  {q:'Um produto de R$ 80 recebe desconto de 25%. Qual o preco final?',o:['R$ 55','R$ 60','R$ 65','R$ 70'],a:1},
  {q:'Qual numero completa: 100, 90, 81, 73, 66, __?',o:['58','59','60','61'],a:2},
  {q:'Se 3 gatos cacam 3 ratos em 3 minutos, quantos gatos sao necessarios para cacar 100 ratos em 100 minutos?',o:['1','3','9','100'],a:1},
  {q:'Qual figura tem sempre quatro lados?',o:['Triangulo','Pentagono','Quadrilatero','Hexagono'],a:2},
  {q:'Joao chegou antes de Pedro, e Pedro antes de Lucas. Quem chegou por ultimo?',o:['Joao','Pedro','Lucas','Empatados'],a:2},
  {q:'Qual e o proximo numero: 2, 6, 12, 20, 30, __?',o:['36','40','42','44'],a:2},
  {q:'Uma cesta tem 6 macas. Voce pega 2. Com quantas macas voce fica?',o:['2','4','6','8'],a:0},
  {q:'Qual palavra e o oposto de "escasso"?',o:['Raro','Abundante','Pequeno','Limitado'],a:1},
  {q:'Se A=1, B=2, C=3, quanto vale CAB?',o:['312','321','123','213'],a:0}
];

app.get('/api/health', (_req,res) => res.json({ok:true, database:!!supabase, paymentConfigured:!!process.env.PAGBANK_TOKEN}));
app.get('/api/questions', (_req,res) => res.json({questions:questions.map(({q,o})=>({q,o})),total:25,price:4.90}));

async function pagbankRequest(url, options={}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + process.env.PAGBANK_TOKEN, Accept:'application/json', 'Content-Type':'application/json', ...(options.headers||{}) }
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error_messages?.[0]?.description || data.message || 'Falha ao comunicar com PagBank');
  return data;
}

app.post('/api/checkout', async (req,res) => {
  try {
    if (!supabase) return res.status(503).json({error:'Banco de dados ainda nao configurado.'});
    if (!process.env.PAGBANK_TOKEN) return res.status(503).json({error:'Pagamento ainda nao configurado.'});
    const {name,email,answers} = req.body || {};
    if (!name || String(name).trim().length < 2 || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Informe nome e e-mail validos.'});
    if (!Array.isArray(answers) || answers.length !== 25 || answers.some(x=>!Number.isInteger(x)||x<0||x>3)) return res.status(400).json({error:'Responda as 25 perguntas antes de continuar.'});
    const score = answers.reduce((sum,answer,i)=>sum+(answer===questions[i].a?1:0),0);
    const attemptId = crypto.randomUUID();
    const baseUrl = process.env.APP_BASE_URL;
    if (!baseUrl) return res.status(503).json({error:'APP_BASE_URL nao configurada no servidor.'});
    const {error:dbError} = await supabase.from('qi_attempts').insert({id:attemptId,buyer_name:String(name).trim().slice(0,100),buyer_email:String(email).trim().toLowerCase(),answers,score,total:25});
    if (dbError) throw dbError;
    const order = await pagbankRequest(PAGBANK_BASE+'/orders', {
      method:'POST',
      body:JSON.stringify({
        reference_id:attemptId,
        customer:{name:String(name).trim().slice(0,100),email:String(email).trim().toLowerCase()},
        items:[{reference_id:'desafio-qi-25',name:'Desafio de QI - Teste com 25 perguntas',quantity:1,unit_amount:PRICE_CENTS}],
        charges:[{description:'Acesso ao resultado do Desafio de QI',amount:{value:PRICE_CENTS,currency:'BRL'},payment_method:{type:'PIX',pix:{}}}],
        notification_urls:[baseUrl.replace(/\/$/,'')+'/api/pagbank/webhook']
      })
    });
    const charge = order.charges?.[0] || {};
    const pix = charge.payment_method?.pix || charge;
    const qr = charge.qr_code || pix.qr_code || {};
    const {error:updateError} = await supabase.from('qi_attempts').update({pagbank_order_id:order.id}).eq('id',attemptId);
    if (updateError) throw updateError;
    res.json({attemptId,orderId:order.id,copyPaste:qr.text||null,qrImage:qr.links?.find(x=>x.rel==='QRCODE.PNG')?.href||null,status:charge.status||'WAITING'});
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

app.get('*', (req,res,next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname,'public','index.html'));
});
app.listen(PORT,()=>console.log('Desafio de QI rodando na porta '+PORT));