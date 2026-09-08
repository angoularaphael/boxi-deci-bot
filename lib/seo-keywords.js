'use strict';

const data = require('./seo-keywords.json');

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(value).trim());
  }
  return out;
}

function allKeywords() {
  const fromClusters = Object.values(data.clusters || {}).flat();
  return unique([
    ...fromClusters,
    ...(data.principaux || []),
    ...(data.longue_traine || []),
  ]);
}

function keywordsMeta(maxLength = 1800) {
  return allKeywords().join(', ').slice(0, maxLength);
}

function knowsAbout() {
  return allKeywords();
}

function cluster(name) {
  return data.clusters?.[name] || [];
}

module.exports = {
  data,
  allKeywords,
  keywordsMeta,
  knowsAbout,
  cluster,
};
