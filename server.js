
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const PRICE_CENTS = 490;
const PRICE_REAIS = 4.90;
const MP_BASE = 'https://api.mercadopago.com';

const supabase =
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

async function mpRequest(endpoint, options = {}) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!token) throw new Error('Mercado Pago nao configurado.');

  const response = await fetch(MP_BASE + endpoint, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('Mercado Pago:', response.status, data);
    throw new Error('Mercado Pago HTTP ' + response.status);
  }

  return data;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    database: !!supabase,
    paymentConfigured: !!process.env.MERCADOPAGO_ACCESS_TOKEN
  });
});

async function loadQuestions() {
  if (!supabase) throw new Error('Banco de dados nao configurado.');

  const { data, error } = await supabase
    .from('qi_questions')
    .select('id,question,option_a,option_b,option_c,option_d,correct_answer')
    .order('id', { ascending: true });

  if (error) throw error;

  if (!data || data.length !== 25) {
    throw new Error('O banco precisa conter exatamente 25 perguntas.');
  }

  return data;
}

app.get('/api/questions', async (_req, res) => {
  try {
    const rows = await loadQuestions();

    const questions = rows.map(row => ({
      q: row.question,
      o: [
        row.option_a,
        row.option_b,
        row.option_c,
        row.option_d
      ]
    }));

    res.json({ questions, total: 25, price: PRICE_REAIS });
  } catch (error) {
    console.error('questions:', error);
    res.status(503).json({
      error: 'Nao foi possivel carregar as perguntas.'
    });
  }
});

function isValidCPF(value) {
  const cpf = String(value || '').replace(/\D/g, '');

  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;

  return digit === Number(cpf[10]);
}

// Criar checkout Mercado Pago
app.post('/api/checkout', async (req, res) => {
  let attemptId;

  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Banco de dados nao configurado.'
      });
    }

    if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
      return res.status(503).json({
        error: 'Mercado Pago ainda nao configurado.'
      });
    }

    const { name, email, cpf, answers } = req.body || {};

    const cpfDigits = String(cpf || '').replace(/\D/g, '');

    if (!isValidCPF(cpfDigits)) {
      return res.status(400).json({
        error: 'Informe um CPF valido.'
      });
    }

    if (
      !name ||
      String(name).trim().length < 2 ||
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: 'Informe nome e e-mail validos.'
      });
    }

    if (
      !Array.isArray(answers) ||
      answers.length !== 25 ||
      answers.some(x => !Number.isInteger(x) || x < 0 || x > 3)
    ) {
      return res.status(400).json({
        error: 'Responda as 25 perguntas antes de continuar.'
      });
    }

    const questionRows = await loadQuestions();

    const score = answers.reduce((sum, answer, i) => {
      const correct = 'ABCD'.indexOf(
        String(questionRows[i].correct_answer).toUpperCase()
      );
      return sum + (answer === correct ? 1 : 0);
    }, 0);

    attemptId = crypto.randomUUID();

    const baseUrl = process.env.APP_BASE_URL;

    if (!baseUrl) {
      return res.status(503).json({
        error: 'APP_BASE_URL nao configurada no servidor.'
      });
    }

    const siteUrl = baseUrl.replace(/\/$/, '');

    const { error: dbError } = await supabase
      .from('qi_attempts')
      .insert({
        id: attemptId,
        buyer_name: String(name).trim().slice(0, 100),
        buyer_email: String(email).trim().toLowerCase(),
        answers,
        score,
        total: 25,
        payment_status: 'WAITING'
      });

    if (dbError) throw dbError;

    const preference = await mpRequest('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            id: 'desafio-qi-25',
            title: 'Desafio de QI - Resultado completo',
            description: 'Acesso ao resultado de 25 perguntas',
            quantity: 1,
            currency_id: 'BRL',
            unit_price: PRICE_REAIS
          }
        ],

        payer: {
          name: String(name).trim().slice(0, 100),
          email: String(email).trim().toLowerCase(),
          identification: {
            type: 'CPF',
            number: cpfDigits
          }
        },

        external_reference: attemptId,

        back_urls: {
          success: siteUrl + '/?payment=success&attempt=' + attemptId,
          pending: siteUrl + '/?payment=pending&attempt=' + attemptId,
          failure: siteUrl + '/?payment=failure&attempt=' + attemptId
        },

        auto_return: 'approved',

        notification_url: siteUrl + '/api/mercadopago/webhook',

        statement_descriptor: 'DESAFIO DE QI'
      })
    });

    const isTestToken =
      process.env.MERCADOPAGO_ACCESS_TOKEN.startsWith('TEST-');

    const initPoint = isTestToken
      ? (preference.sandbox_init_point || preference.init_point)
      : preference.init_point;

    if (!initPoint) {
      throw new Error('Mercado Pago nao retornou o link de pagamento.');
    }

    res.json({
      attemptId,
      initPoint,
      preferenceId: preference.id
    });

  } catch (error) {
    console.error('checkout:', error);
    res.status(500).json({
      error: 'Nao foi possivel iniciar o pagamento. Tente novamente.'
    });
  }
});

// Consultar pagamento diretamente no Mercado Pago
async function verifyPayment(attemptId) {
  const result = await mpRequest(
    '/v1/payments/search?external_reference=' +
    encodeURIComponent(attemptId) +
    '&sort=date_created&criteria=desc&limit=10'
  );

  const payments = result.results || [];

  return payments.some(payment =>
    payment.status === 'approved' &&
    payment.external_reference === attemptId &&
    payment.currency_id === 'BRL' &&
    Math.abs(Number(payment.transaction_amount) - PRICE_REAIS) < 0.01
  );
}

async function markAsPaid(attemptId) {
  const { error } = await supabase
    .from('qi_attempts')
    .update({
      payment_status: 'PAID',
      paid_at: new Date().toISOString()
    })
    .eq('id', attemptId);

  if (error) throw error;
}

// Consultar situação do pagamento
app.get('/api/payment/:attemptId', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({
        error: 'Banco de dados nao configurado.'
      });
    }

    const { data, error } = await supabase
      .from('qi_attempts')
      .select('id,payment_status,score,total')
      .eq('id', req.params.attemptId)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({
        error: 'Pedido nao encontrado.'
      });
    }

    let status = data.payment_status;

    if (status !== 'PAID') {
      const approved = await verifyPayment(data.id);

      if (approved) {
        await markAsPaid(data.id);
        status = 'PAID';
      }
    }

    const result = { status };

    if (status === 'PAID') {
      result.result = {
        score: data.score,
        total: data.total,
        percentage: Math.round(data.score / data.total * 100)
      };
    }

    res.json(result);

  } catch (error) {
    console.error('payment status:', error);
    res.status(500).json({
      error: 'Nao foi possivel consultar o pagamento.'
    });
  }
});

// Webhook Mercado Pago
app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    if (!supabase) return res.sendStatus(200);

    const paymentId =
      req.body?.data?.id ||
      req.query['data.id'] ||
      req.query.id;

    const type = req.body?.type || req.query.type;

    if (!paymentId || (type && type !== 'payment')) {
      return res.sendStatus(200);
    }

    const payment = await mpRequest(
      '/v1/payments/' + encodeURIComponent(paymentId)
    );

    const attemptId = payment.external_reference;

    if (
      payment.status === 'approved' &&
      attemptId &&
      payment.currency_id === 'BRL' &&
      Math.abs(Number(payment.transaction_amount) - PRICE_REAIS) < 0.01
    ) {
      await markAsPaid(attemptId);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('Mercado Pago webhook:', error);
    res.sendStatus(500);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Desafio de QI rodando na porta ' + PORT);
});
