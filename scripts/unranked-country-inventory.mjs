function compareByCoverage(left, right) {
  return Number(left.coverage) - Number(right.coverage) || left.id.localeCompare(right.id);
}

function formatProseList(items) {
  const values = [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function partitionInventory(dimensions, inventoryLimit) {
  const notApplicable = dimensions
    .filter((dimension) => dimension.isNotApplicable)
    .sort((left, right) => left.id.localeCompare(right.id));
  const gaps = dimensions.filter((dimension) => dimension.isCoverageGap).sort(compareByCoverage);
  const observed = dimensions
    .filter((dimension) => (
      !dimension.isCoverageGap
      && !dimension.isNotApplicable
      && Number(dimension.coverage) < 1
    ))
    .sort(compareByCoverage);
  const pool = [];
  const pooled = new Set();
  for (const dimension of [...notApplicable, ...gaps, ...observed]) {
    if (pooled.has(dimension.id)) continue;
    pooled.add(dimension.id);
    pool.push(dimension);
  }
  const unpooled = dimensions.filter((dimension) => !pooled.has(dimension.id));
  return {
    total: new Set(dimensions.map((dimension) => dimension.id)).size,
    rowCount: dimensions.length,
    shown: pool.slice(0, inventoryLimit),
    droppedByCap: pool.slice(inventoryLimit),
    fullCoverage: unpooled.filter((dimension) => Number(dimension.coverage) >= 1),
    unclassified: unpooled.filter((dimension) => !(Number(dimension.coverage) >= 1)),
  };
}

function inventoryScope(partition) {
  return {
    total: partition.total,
    shown: partition.shown.length,
    omittedClauses: [
      { count: partition.fullCoverage.length, text: 'more at full coverage' },
      { count: partition.droppedByCap.length, text: 'omitted for brevity' },
    ].filter((clause) => clause.count > 0),
  };
}

function describeInventoryScope(scope) {
  if (scope.omittedClauses.length === 0) return null;
  const omittedTail = scope.omittedClauses
    .map((clause) => `; ${clause.count} ${clause.text}`)
    .join('');
  return `Showing ${scope.shown} of ${scope.total} active dimensions, weakest evidence first${omittedTail}.`;
}

function describeSupportThreshold(dimensions, supportFloor) {
  if (dimensions.length === 0) return null;
  const labels = formatProseList(dimensions.map((dimension) => dimension.label));
  const verb = dimensions.length === 1 ? 'is' : 'are';
  const pronoun = dimensions.length === 1 ? 'it is' : 'they are';
  const floor = `${Math.round(supportFloor * 100)}%`;
  return `${labels} ${verb} observed but below the ${floor} coverage a supported reading needs, so ${pronoun} recorded here without counting as supported readings.`;
}

export function buildUnrankedCountryInventory({
  countryCode,
  dimensions,
  inventoryLimit,
  supportFloor,
}) {
  const partition = partitionInventory(dimensions, inventoryLimit);
  const scope = inventoryScope(partition);
  const unsupportedObserved = partition.shown
    .filter((dimension) => dimension.inventoryNote === 'observed' && !dimension.supported)
    .sort(compareByCoverage);
  const belowThreshold = unsupportedObserved.filter((dimension) => (
    Number(dimension.coverage) < supportFloor
  ));
  const aboveThreshold = unsupportedObserved.filter((dimension) => (
    Number(dimension.coverage) >= supportFloor
  ));
  const inventoryScopeNote = describeInventoryScope(scope);
  const supportThresholdNote = describeSupportThreshold(belowThreshold, supportFloor);
  const floor = `${Math.round(supportFloor * 100)}%`;

  function assertIntegrity(rendered = {}) {
    if (partition.rowCount !== partition.total) {
      throw new Error(
        `${countryCode} repeats a dimension id across its domains, so the inventory`
        + ` would publish ${partition.rowCount} rows as ${partition.total} distinct dimensions`,
      );
    }
    if (partition.unclassified.length > 0) {
      throw new Error(
        `${countryCode} would publish ${partition.unclassified.map((dimension) => (
          `${dimension.id} (coverage ${dimension.coverage})`
        )).join(', ')} as "at full coverage" without reaching full coverage`,
      );
    }
    if (partition.droppedByCap.length > 0 && partition.shown.length !== inventoryLimit) {
      throw new Error(
        `${countryCode} omits ${partition.droppedByCap.length} dimensions for brevity while showing`
        + ` only ${partition.shown.length} of the ${inventoryLimit} the cap allows`,
      );
    }

    const accounted = scope.omittedClauses.reduce((sum, clause) => sum + clause.count, scope.shown);
    if (accounted !== scope.total) {
      throw new Error(
        `${countryCode} evidence inventory scope does not close: ${scope.shown} shown`
        + `${scope.omittedClauses.map((clause) => ` + ${clause.count} ${clause.text}`).join('')}`
        + ` = ${accounted}, not the ${scope.total} active dimensions the page claims`,
      );
    }

    const renderedScope = rendered.inventoryScope === undefined
      ? inventoryScopeNote
      : rendered.inventoryScope;
    if (accounted !== scope.shown) {
      const head = String(renderedScope ?? '').match(/^Showing (\d+) of (\d+) active dimensions/);
      const statedOmitted = scope.omittedClauses.map((clause) => (
        String(renderedScope ?? '').match(new RegExp(`(\\d+) ${clause.text}`))?.[1]
      ));
      if (
        !head
        || Number(head[1]) !== scope.shown
        || Number(head[2]) !== scope.total
        || statedOmitted.some((count, index) => Number(count) !== scope.omittedClauses[index].count)
        || statedOmitted.reduce((sum, count) => sum + Number(count), scope.shown) !== scope.total
      ) {
        throw new Error(
          `${countryCode} publishes an inventory scope note a reader cannot add up to`
          + ` its ${scope.total} active dimensions: "${renderedScope}"`,
        );
      }
    } else if (renderedScope !== null) {
      throw new Error(
        `${countryCode} publishes an inventory scope note although nothing is omitted: "${renderedScope}"`,
      );
    }

    if (aboveThreshold.length > 0) {
      throw new Error(
        `${countryCode} lists ${aboveThreshold.map((dimension) => dimension.id).join(', ')} as observed`
        + ` at or above the ${floor} support threshold yet omits them from the supported readings.`
        + ' Either the dimension carries no usable score, or its inventory classification is not'
        + ' recognised; the threshold note explains neither.',
      );
    }

    const renderedThreshold = rendered.supportThreshold === undefined
      ? supportThresholdNote
      : rendered.supportThreshold;
    if (belowThreshold.length > 0 && renderedThreshold !== supportThresholdNote) {
      throw new Error(
        `${countryCode} lists ${belowThreshold.map((dimension) => dimension.id).join(', ')} as observed`
        + ` outside the supported readings without publishing the ${floor} support threshold exactly:`
        + ` expected "${supportThresholdNote}", got "${renderedThreshold}"`,
      );
    }
    if (belowThreshold.length === 0 && renderedThreshold !== null) {
      throw new Error(
        `${countryCode} publishes a support threshold note although no shown observed dimension`
        + ` falls below the ${floor} floor: "${renderedThreshold}"`,
      );
    }
  }

  return {
    shown: partition.shown.map((dimension) => dimension.value),
    inventoryScope: inventoryScopeNote,
    supportThreshold: supportThresholdNote,
    assertIntegrity,
  };
}
