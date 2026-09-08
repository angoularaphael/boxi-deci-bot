#!/usr/bin/env node
'use strict';
/**
 * Ramène vers Minimes des fiches Boxing Center envoyées par erreur sur Balma.
 *   node scripts/fix-minimes-migrated-to-balma.js --check --names="Manoelle Gamon,Leo Blanchier"
 *   node scripts/fix-minimes-migrated-to-balma.js --apply --names="Manoelle Gamon,Leo Blanchier"
 */
require('dotenv').config();
process.env.BOXPLUS_ORDERS_REMOTE = '1';
process.env.DECIPLUS_FAST = process.env.DECIPLUS_FAST || '1';
process.env.DECIPLUS_HEADLESS = process.env.DECIPLUS_HEADLESS || 'true';
delete process.env.PLAYWRIGHT_BROWSERS_PATH;
delete process.env.BOXPLUS_HOSTED;
delete process.env.BOXPLUS_BOT_URL;
delete process.env.BOXPLUS_BOT_URL_OPS;

const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../storefront/lib/supabase');
const { getGymConfig } = require('../lib/normalize');
const { isBalmaSaleTarget } = require('../lib/gym-slugs');
const { login } = require('../bot/auth');
const { runWithSession, closeBrowser } = require('../bot/browser-pool');
const { switchDeciplusSite } = require('../bot/deciplus-zone');
const { openMemberCheck, closeGreyboxIfOpen } = require('../bot/wallet');
const { searchMember, searchMemberByName, detectMemberGymConfig } = require('../bot/member');
const { migrateMemberToGym } = require('../bot/migrate-gym');
const { findActiveContracts } = require('../bot/cancel-sale');

const APPLY = process.argv.includes('--apply');
const NAMES = (process.argv.find((a) => a.startsWith('--names=')) || '')
  .slice(8)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_NAMES = ['Manoelle Gamon', 'Leo Blanchier', 'Léa Blanchier', 'Léo Blanchier'];
const TARGETS = NAMES.length ? NAMES : DEFAULT_NAMES;
const OUT = path.join(__dirname, '..', 'data', `fix-minimes-to-balma-${Date.now()}.json`);

function fold(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseName(raw) {
  const parts = String(raw || '').trim().split(/\s+/);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') };
}

function rowName(p) {
  const cs = p.customer_short || {};
  const cf = p.customer_full || {};
  return `${cs.first_name || cf.first_name || ''} ${cs.last_name || cf.last_name || ''}`.trim();
}

function matchesTarget(hay, targets) {
  const folded = fold(hay);
  return targets.some((name) => {
    const parsed = parseName(name);
    return folded.includes(fold(parsed.last_name)) && folded.includes(fold(parsed.first_name).slice(0, 4));
  });
}

async function loadOrders() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('boxplus_orders')
    .select('order_id, created_at, payload')
    .order('created_at', { ascending: false })
    .limit(3000);
  if (error) throw error;
  return (data || [])
    .map((row) => {
      const p = row.payload || {};
      const cs = p.customer_short || {};
      const cf = p.customer_full || {};
      return {
        order_id: row.order_id,
        created_at: row.created_at,
        name: rowName(p),
        gym: String(p.customer_full?.gym || p.gym || '').toLowerCase(),
        email: cs.email || cf.email || null,
        first_name: cs.first_name || cf.first_name || '',
        last_name: cs.last_name || cf.last_name || '',
        member_id: p.deciplus_member_id || null,
        sale_id: p.deciplus_sale_id || null,
        bot_status: p.bot_status || null,
      };
    })
    .filter((row) => matchesTarget(`${row.name} ${row.email || ''} ${row.order_id}`, TARGETS));
}

function slim(c) {
  return {
    idc: c.idc,
    badge: Boolean(c.isBadge),
    label: String(c.label || '').replace(/\s+/g, ' ').slice(0, 140),
  };
}

async function inspect(page, memberId, siteCfg) {
  await closeGreyboxIfOpen(page).catch(() => {});
  await openMemberCheck(page, memberId, siteCfg).catch(() => {});
  const site = await detectMemberGymConfig(page, siteCfg).catch(() => siteCfg);
  const contracts = await findActiveContracts(page, { includeExpiredPrestation: true }).catch(() => []);
  return {
    site: site?.deciplus_label || siteCfg.deciplus_label,
    zone: site?.deciplus_zone_id || siteCfg.deciplus_zone_id,
    contracts: contracts.map(slim),
  };
}

async function locate(page, row) {
  const sites = [
    { name: 'Balma', cfg: getGymConfig('balma') },
    { name: 'Minimes', cfg: getGymConfig('minimes') },
  ];
  for (const site of sites) {
    await closeGreyboxIfOpen(page).catch(() => {});
    const switched = await switchDeciplusSite(page, site.name).catch(() => false);
    if (!switched) continue;
    if (row.member_id) {
      await openMemberCheck(page, String(row.member_id), site.cfg).catch(() => {});
      const live = await detectMemberGymConfig(page, site.cfg).catch(() => null);
      if (live?.deciplus_label) {
        return { member_id: String(row.member_id), via: 'id', opened_on: site.name, live };
      }
    }
    let hit = null;
    if (row.email) {
      const found = await searchMember(page, row.email).catch(() => null);
      if (found?.found && found.member_id) hit = found;
    }
    if (!hit && row.last_name) {
      const found = await searchMemberByName(page, row.last_name, row.first_name).catch(() => null);
      if (found?.found && found.member_id) hit = found;
    }
    if (hit?.member_id) {
      const live = await detectMemberGymConfig(page, site.cfg).catch(() => site.cfg);
      return { member_id: String(hit.member_id), via: row.email ? 'email' : 'name', opened_on: site.name, live };
    }
  }
  return null;
}

async function main() {
  const browsers = path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;

  const orders = await loadOrders();
  const minimes = getGymConfig('minimes');
  const report = { apply: APPLY, targets: TARGETS, orders, results: [] };

  await runWithSession('fix-minimes-to-balma', async (page) => {
    await login(page, { siteLabel: 'Balma' }).catch(async () => {
      await login(page, { siteLabel: 'Minimes' });
    });

    const people = orders.length
      ? orders
      : TARGETS.map((name) => ({ ...parseName(name), name, member_id: null, email: null, gym: null }));

    const seen = new Set();
    for (const row of people) {
      const key = fold(row.member_id || row.email || row.name);
      if (seen.has(key)) continue;
      seen.add(key);
      const found = await locate(page, row);
      if (!found) {
        report.results.push({ ...row, status: 'not_found' });
        continue;
      }
      const before = await inspect(page, found.member_id, found.live || getGymConfig('balma'));
      const onBalma = isBalmaSaleTarget(
        { deciplus_label: before.site, deciplus_zone_id: before.zone },
        {}
      );
      const item = {
        name: row.name,
        order_id: row.order_id || null,
        member_id: found.member_id,
        via: found.via,
        before,
        on_balma: onBalma,
      };
      if (onBalma && APPLY) {
        await migrateMemberToGym(page, found.member_id, minimes);
        item.after = await inspect(page, found.member_id, minimes);
        item.status = String(item.after.zone) === '2' ? 'migrated_minimes' : 'migrate_failed';
      } else {
        item.status = onBalma ? 'needs_minimes' : 'already_ok';
      }
      report.results.push(item);
      console.log(item.status, item.name, item.member_id, item.before?.site, '→', item.after?.site || item.before?.site);
    }
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: OUT, results: report.results.map((r) => ({ name: r.name, status: r.status, member_id: r.member_id, site: r.after?.site || r.before?.site })) }, null, 2));
  await closeBrowser().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
