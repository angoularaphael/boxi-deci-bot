'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  assignSalesBot,
  normalizeSalesBot,
  pickSalesBotUrl,
  stampSalesBot,
  wrongSalesBotReject,
  SALES_BOT_RAPHAEL,
  SALES_BOT_EDDY,
} = require('../lib/sales-bot');
const { pickBotBase, isOpsOrder } = require('../lib/bot-forward');
const {
  failoverTarget,
  shouldFailoverSale,
  handoffFailedSale,
} = require('../lib/bot-failover');
const { normalizeOrder } = require('../lib/normalize');
const { hasPendingSalesFailover } = require('../lib/queue');
const { formatAlertText, DEFAULT_ALERT_EMAIL } = require('../lib/logger');

const SAVED = {
  BOXPLUS_BOT_URL: process.env.BOXPLUS_BOT_URL,
  BOXPLUS_BOT_URL_SALES_2: process.env.BOXPLUS_BOT_URL_SALES_2,
  BOXPLUS_BOT_URL_OPS: process.env.BOXPLUS_BOT_URL_OPS,
  BOT_ID: process.env.BOT_ID,
  BOT_FAILOVER_URL: process.env.BOT_FAILOVER_URL,
  BOT_FAILOVER_TARGET: process.env.BOT_FAILOVER_TARGET,
  BOT_MAX_FAILOVERS: process.env.BOT_MAX_FAILOVERS,
  SYNC_SECRET: process.env.SYNC_SECRET,
};

function restoreEnv() {
  for (const [key, val] of Object.entries(SAVED)) {
    if (val == null) delete process.env[key];
    else process.env[key] = val;
  }
}

describe('sales-bot split Raphaël / Eddy', () => {
  after(restoreEnv);

  it('normalise brad → raphael, eddy reste eddy', () => {
    assert.equal(normalizeSalesBot('BRAD'), SALES_BOT_RAPHAEL);
    assert.equal(normalizeSalesBot('raphael'), SALES_BOT_RAPHAEL);
    assert.equal(normalizeSalesBot('EDDY'), SALES_BOT_EDDY);
    assert.equal(normalizeSalesBot(''), '');
  });

  it('hash stable : même order_id → même bot', () => {
    const a = assignSalesBot({ order_id: 'BC-STABLE-1' });
    const b = assignSalesBot({ order_id: 'BC-STABLE-1' });
    assert.equal(a, b);
    assert.ok(a === SALES_BOT_RAPHAEL || a === SALES_BOT_EDDY);
  });

  it('sales_bot déjà posé n’est pas recalculé', () => {
    assert.equal(assignSalesBot({ order_id: 'x', sales_bot: 'eddy' }), SALES_BOT_EDDY);
    assert.equal(assignSalesBot({ order_id: 'x', sales_bot: 'raphael' }), SALES_BOT_RAPHAEL);
  });

  it('sans SALES_2, tout va sur Raphaël (rien ne casse)', () => {
    process.env.BOXPLUS_BOT_URL = 'http://prem-eu1.bot-hosting.net:20311';
    delete process.env.BOXPLUS_BOT_URL_SALES_2;
    process.env.BOXPLUS_BOT_URL_OPS = 'http://prem-eu2.bot-hosting.net:21268';
    const sale = { action: 'sale', order_id: 'BC-ONLY-1' };
    assert.equal(pickBotBase(sale), 'http://prem-eu1.bot-hosting.net:20311');
    const photo = { action: 'member_photo', order_id: 'BC-ONLY-1' };
    assert.equal(isOpsOrder(photo), false);
    assert.equal(pickBotBase(photo), 'http://prem-eu1.bot-hosting.net:20311');
  });

  it('avec SALES_2, ops reste sur 21268', () => {
    process.env.BOXPLUS_BOT_URL = 'http://prem-eu1.bot-hosting.net:20311';
    process.env.BOXPLUS_BOT_URL_SALES_2 = 'http://prem-eu2.bot-hosting.net:21871';
    process.env.BOXPLUS_BOT_URL_OPS = 'http://prem-eu2.bot-hosting.net:21268';
    assert.equal(pickBotBase({ action: 'cancel' }), 'http://prem-eu2.bot-hosting.net:21268');
    assert.equal(pickBotBase({ action: 'echeancier' }), 'http://prem-eu2.bot-hosting.net:21268');
    assert.equal(
      pickBotBase({ action: 'sale', cancel_reason: 'change_to_comptant' }),
      'http://prem-eu2.bot-hosting.net:21268'
    );
  });

  it('avec SALES_2, sticky eddy → 21871, raphael → 20311', () => {
    const eddyUrl = pickSalesBotUrl(
      { order_id: 'BC-1', sales_bot: 'eddy' },
      'http://eu1:20311',
      'http://eu2:21871'
    );
    const raphaelUrl = pickSalesBotUrl(
      { order_id: 'BC-1', sales_bot: 'raphael' },
      'http://eu1:20311',
      'http://eu2:21871'
    );
    assert.equal(eddyUrl, 'http://eu2:21871');
    assert.equal(raphaelUrl, 'http://eu1:20311');
  });

  it('BOT_ID eddy refuse un job raphael (sans le traiter)', () => {
    process.env.BOT_ID = 'eddy';
    const reject = wrongSalesBotReject({ sales_bot: 'raphael', order_id: 'BC-2' });
    assert.equal(reject.reason, 'wrong_bot');
    assert.equal(reject.queued, false);
    assert.equal(wrongSalesBotReject({ sales_bot: 'eddy' }), null);
    assert.equal(wrongSalesBotReject({ order_id: 'legacy-sans-stamp' }), null);
  });

  it('sans BOT_ID, pas de filtre (bot ops / ancien serveur)', () => {
    delete process.env.BOT_ID;
    assert.equal(wrongSalesBotReject({ sales_bot: 'eddy' }), null);
  });

  it('stampSalesBot pose le champ sur la commande', () => {
    process.env.BOXPLUS_BOT_URL_SALES_2 = 'http://prem-eu2.bot-hosting.net:21871';
    const order = { order_id: 'BC-STAMP' };
    stampSalesBot(order);
    assert.ok(order.sales_bot === 'raphael' || order.sales_bot === 'eddy');
  });

  it('normalize conserve le bot assigné et les métadonnées de relais', () => {
    const order = normalizeOrder({
      order_id: 'BC-FAILOVER-NORMALIZE',
      action: 'sale',
      gym: 'minimes',
      sales_bot: 'eddy',
      failover_count: 1,
      failover_from: 'raphael',
    });
    assert.equal(order.sales_bot, 'eddy');
    assert.equal(order.failover_count, 1);
    assert.equal(order.failover_from, 'raphael');
  });

  it('un échec technique Raphaël est éligible à un seul relais Eddy', () => {
    process.env.BOT_ID = 'raphael';
    process.env.BOT_FAILOVER_URL = 'http://eu2:21871';
    process.env.BOT_FAILOVER_TARGET = 'eddy';
    process.env.BOT_MAX_FAILOVERS = '1';
    assert.equal(failoverTarget(), 'eddy');
    assert.equal(
      shouldFailoverSale(
        { order_id: 'BC-FAILOVER-1', action: 'sale', sales_bot: 'raphael' },
        { retryable: true },
        {}
      ),
      true
    );
    assert.equal(
      shouldFailoverSale(
        {
          order_id: 'BC-FAILOVER-1',
          action: 'sale',
          sales_bot: 'eddy',
          failover_count: 1,
        },
        { retryable: true },
        {}
      ),
      false
    );
  });

  it('conserve un job épuisé dans la file tant que son relais reste possible', () => {
    process.env.BOT_FAILOVER_URL = 'http://eu2:21871';
    process.env.BOT_MAX_FAILOVERS = '1';
    assert.equal(
      hasPendingSalesFailover({
        action: 'sale',
        attempts: 3,
        failover_count: 0,
      }),
      true
    );
    assert.equal(
      hasPendingSalesFailover({
        action: 'sale',
        attempts: 3,
        failover_count: 1,
      }),
      false
    );
  });

  it('transmet le job au second bot avec compteur anti-boucle', async () => {
    process.env.BOT_ID = 'raphael';
    process.env.BOT_FAILOVER_URL = 'http://eu2:21871';
    process.env.BOT_FAILOVER_TARGET = 'eddy';
    process.env.SYNC_SECRET = 'test-secret';
    const originalFetch = global.fetch;
    let sent;
    global.fetch = async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({ queued: true, job_id: 'BC-FAILOVER-2' }),
      };
    };
    try {
      const result = await handoffFailedSale(
        { order_id: 'BC-FAILOVER-2', action: 'sale', sales_bot: 'raphael' },
        { error: 'session timeout' }
      );
      assert.equal(result.handed_off, true);
      assert.equal(result.target, 'eddy');
      assert.equal(sent.url, 'http://eu2:21871/api/jobs');
      assert.equal(sent.body.sales_bot, 'eddy');
      assert.equal(sent.body.failover_count, 1);
      assert.equal(sent.body.attempts, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('alerte mail : destinataire par défaut boxingcentertls', () => {
    assert.equal(DEFAULT_ALERT_EMAIL, 'boxingcentertls@gmail.com');
    const text = formatAlertText('Job impossible', {
      order_id: 'BC-9',
      job_id: 'BC-9',
      error: 'timeout',
    });
    assert.match(text, /BC-9/);
    assert.match(text, /timeout/);
  });
});
