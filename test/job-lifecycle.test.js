'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lifecycleFromBotOutcome, coerceCompletedTrialLifecycle, STATES } = require('../lib/job-lifecycle');
const { boutiqueSaleDispatchAllowed } = require('../lib/sale-dispatch-policy');

describe('séance offerte — jobs', () => {
  it('ne met pas en revue manuelle un succès sans vente Deciplus', () => {
    assert.equal(
      lifecycleFromBotOutcome({ status: 'success', deciplus_member_id: '22341', deciplus_sale_id: null }),
      STATES.VERIFIED
    );
    assert.equal(
      coerceCompletedTrialLifecycle({
        status: 'completed',
        member_id: '22341',
        lifecycle_state: STATES.MANUAL_REVIEW,
      }),
      STATES.VERIFIED
    );
  });

  it('laisse passer un job SO- même sans signature boutique', () => {
    assert.equal(
      boutiqueSaleDispatchAllowed({
        order_id: 'SO-99',
        sale_type: 'none',
        create_sale: false,
        product_id: 'seance-essai-offerte',
      }),
      true
    );
    assert.equal(boutiqueSaleDispatchAllowed({ order_id: 'BC-1' }), false);
  });
});
