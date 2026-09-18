'use strict';

/**
 * Accès ponctuel coach — vendeur Deciplus RAPHAEL.
 * grant : retrouve/crée la fiche + note fenêtre T−5 → fin de créneau.
 * revoke : annote la révocation (porte coupée côté note + callback app).
 */
const { logInfo, logWarn } = require('../lib/logger');
const { findOrCreateMember, findMemberByIdentity, openMemberEditForm, getMemberFormContext } = require('./member');
const { getGymConfig } = require('../lib/normalize');
const { switchDeciplusSite } = require('./deciplus-zone');
const { STATUS } = require('../lib/queue');

const MARKER = 'COACH-SLOT';

function parisStamp(iso) {
  try {
    return new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  } catch {
    return String(iso || '');
  }
}

function slotNote(order, verb) {
  const club = order.gym || order.club_id || '';
  const space = order.space_id || '';
  const from = parisStamp(order.qr_valid_from || order.valid_from);
  const to = parisStamp(order.qr_valid_to || order.valid_to || order.ends_at);
  return `${MARKER} ${verb} ${order.order_id} ${club}/${space} ${from} → ${to}`.slice(0, 480);
}

async function writeInfoCompta(page, memberId, line) {
  if (memberId) {
    await openMemberEditForm(page, memberId).catch(() => {});
    await page.waitForTimeout(600);
  }
  const ctx = await getMemberFormContext(page, { waitMs: 6000 });
  const ta = ctx
    .locator('textarea[name="info_compta"], input[name="info_compta"], textarea#info_compta')
    .first();
  if ((await ta.count()) === 0) {
    logWarn('Coach-slot — info_compta introuvable');
    return false;
  }
  const current = String((await ta.inputValue().catch(() => '')) || '');
  const next = current.includes(line) ? current : `${line}\n${current}`.slice(0, 1900);
  await ta.fill(next);
  const update = ctx
    .locator(
      'input[type="submit"][value*="Mettre"], button:has-text("Mettre à jour"), input[name="update"], input[type="submit"][value*="Valider"]'
    )
    .first();
  if ((await update.count()) > 0) {
    await update.click().catch(() => {});
    await page.waitForTimeout(700);
  }
  return true;
}

async function callbackApp(order, payload) {
  const base = String(
    order.status_callback_base || process.env.COACH_APP_URL || process.env.SITE_URL || ''
  ).replace(/\/$/, '');
  const secret = process.env.SYNC_SECRET || '';
  if (!base || !secret) {
    logWarn('Coach-slot — pas de callback app (COACH_APP_URL / SYNC_SECRET)');
    return false;
  }
  const url = `${base}/api/v1/internal/deciplus/callback`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      logWarn('Coach-slot callback HTTP', { status: res.status, url });
    }
    return res.ok;
  } catch (err) {
    logWarn('Coach-slot callback échoué', { error: err.message });
    return false;
  }
}

function gymFromOrder(order) {
  const slug = String(order.gym || order.club_id || 'minimes').toLowerCase();
  return getGymConfig(slug);
}

function identityFromOrder(order) {
  return {
    first_name: order.customer?.first_name,
    last_name: order.customer?.last_name,
    birthdate: order.customer?.birthdate || order.customer?.birth_date,
    phone: order.customer?.phone,
    email: order.customer?.email,
    address: order.customer?.address || order.customer?.address_line,
    postal_code: order.customer?.postal_code,
    city: order.customer?.city,
    gender: order.customer?.gender || 'M',
  };
}

async function resolveMember(page, order, gymConfig) {
  if (order.deciplus_member_id) {
    return { member_id: String(order.deciplus_member_id), action: 'existing_id' };
  }
  const saleOrder = {
    order_id: order.order_id,
    gym: gymConfig.key,
    customer: identityFromOrder(order),
  };
  const created = await findOrCreateMember(page, saleOrder, gymConfig);
  if (created?.duplicate) {
    throw new Error(`Doublon Deciplus: ${created.message || 'fiche existante'}`);
  }
  const id = created?.member_id || created?.id || null;
  if (!id) throw new Error('Membre Deciplus introuvable après grant');
  return { member_id: String(id), action: created.action || 'found' };
}

async function processCoachGrant(page, order) {
  const gymConfig = gymFromOrder(order);
  const label = gymConfig.deciplus_label || gymConfig.label;
  await switchDeciplusSite(page, label).catch((err) => {
    logWarn('Coach-slot switch site', { site: label, error: err.message });
  });
  const member = await resolveMember(page, order, gymConfig);
  await writeInfoCompta(page, member.member_id, slotNote(order, 'GRANT'));
  logInfo('Coach-slot grant', {
    order_id: order.order_id,
    member_id: member.member_id,
    gym: gymConfig.key,
    via: member.action,
  });
  await callbackApp(order, {
    reservation_id: order.reservation_id || order.order_id,
    deciplus_member_id: member.member_id,
    job_status: 'granted',
    club_id: gymConfig.key,
  });
  return {
    status: STATUS.SUCCESS,
    action: 'coach_grant',
    deciplus_member_id: member.member_id,
  };
}

async function processCoachRevoke(page, order) {
  const gymConfig = gymFromOrder(order);
  const label = gymConfig.deciplus_label || gymConfig.label;
  await switchDeciplusSite(page, label).catch(() => {});
  let memberId = order.deciplus_member_id || null;
  if (!memberId) {
    const found = await findMemberByIdentity(page, identityFromOrder(order)).catch(() => null);
    memberId = found?.member_id || null;
  }
  if (!memberId) {
    logWarn('Coach-slot revoke — membre introuvable', { order_id: order.order_id });
    await callbackApp(order, {
      reservation_id: order.reservation_id || order.order_id,
      deciplus_member_id: null,
      job_status: 'revoked',
      error: 'membre introuvable',
    });
    return { status: STATUS.SUCCESS, action: 'coach_revoke', deciplus_member_id: null };
  }
  await writeInfoCompta(page, memberId, slotNote(order, 'REVOKE'));
  logInfo('Coach-slot revoke', { order_id: order.order_id, member_id: memberId });
  await callbackApp(order, {
    reservation_id: order.reservation_id || order.order_id,
    deciplus_member_id: memberId,
    job_status: 'revoked',
  });
  return {
    status: STATUS.SUCCESS,
    action: order.action,
    deciplus_member_id: memberId,
  };
}

async function processCoachAccessJob(page, order) {
  const action = String(order.action || '').toLowerCase();
  if (action === 'coach_grant' || action === 'grant') {
    return processCoachGrant(page, order);
  }
  if (action === 'coach_revoke' || action === 'revoke' || action === 'coach_revoke_coach' || action === 'revoke_coach') {
    return processCoachRevoke(page, order);
  }
  throw new Error(`Action coach inconnue: ${action}`);
}

function isCoachAccessAction(action) {
  const a = String(action || '').toLowerCase();
  return [
    'coach_grant',
    'coach_revoke',
    'coach_revoke_coach',
    'grant',
    'revoke',
    'revoke_coach',
  ].includes(a);
}

module.exports = {
  processCoachAccessJob,
  isCoachAccessAction,
  MARKER,
};
