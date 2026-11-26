function crudeOilQuoteProvenance(symbol, priceSource, priceBasis, priceAt) {
  if (symbol !== 'BZ=F' && symbol !== 'CL=F') return {};
  return {
    priceSource,
    priceBasis,
    ...(Number.isFinite(priceAt) && priceAt > 0 ? { priceAt } : {}),
  };
}

module.exports = { crudeOilQuoteProvenance };
