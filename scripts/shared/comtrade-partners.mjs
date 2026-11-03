export function createComtradePartnerNormalizer(registry, standardCodes) {
  /** Resolve provider semantics first; reporter overrides are not partner identities. */
  function normalizeComtradePartner(code) {
    const key = String(code ?? '');
    if (!/^\d{1,3}$/.test(key)) return { iso2: '', kind: 'unknown', label: 'Unknown partner', note: '' };
    const provider = registry.partners[String(Number(key))];
    if (provider) return provider;
    const iso2 = standardCodes[key.padStart(3, '0')] ?? '';
    return { iso2, kind: iso2 ? 'standard' : 'unknown', label: iso2 || 'Unknown partner', note: iso2 ? 'UN M49 standard-code fallback; provider area scope unverified.' : '' };
  }

  /** Preserve the cached denominator, numeric partner code and all other evidence. */
  function normalizeComtradeProducts(products) {
    return products.map(product => ({
      ...product,
      topExporters: (product.topExporters ?? []).map(exporter => ({
        ...exporter,
        partnerIso2: normalizeComtradePartner(exporter.partnerCode).iso2,
      })),
    }));
  }

  return { normalizeComtradePartner, normalizeComtradeProducts };

}
