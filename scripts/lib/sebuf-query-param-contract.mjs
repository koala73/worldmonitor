import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';

export const NOOP_QUERY_DESCRIPTION_RE = /\b(?:accepted but currently ignored|currently (?:ignored|a no-op)|no-op|no op)\b/i;

const DEFAULT_SCOPED_PROTO_FILES = new Set([
  'worldmonitor/aviation/v1/list_airport_delays.proto',
  'worldmonitor/climate/v1/list_climate_anomalies.proto',
  'worldmonitor/conflict/v1/list_acled_events.proto',
  'worldmonitor/conflict/v1/list_ucdp_events.proto',
  'worldmonitor/cyber/v1/list_cyber_threats.proto',
  'worldmonitor/economic/v1/get_economic_calendar.proto',
  'worldmonitor/economic/v1/get_energy_capacity.proto',
  'worldmonitor/economic/v1/list_world_bank_indicators.proto',
  'worldmonitor/infrastructure/v1/list_internet_outages.proto',
  'worldmonitor/intelligence/v1/search_gdelt_documents.proto',
  'worldmonitor/maritime/v1/list_navigational_warnings.proto',
  'worldmonitor/market/v1/get_sector_summary.proto',
  'worldmonitor/market/v1/list_earnings_calendar.proto',
  'worldmonitor/military/v1/get_theater_posture.proto',
  'worldmonitor/military/v1/list_military_flights.proto',
  'worldmonitor/natural/v1/list_natural_events.proto',
  'worldmonitor/prediction/v1/list_prediction_markets.proto',
  'worldmonitor/research/v1/list_arxiv_papers.proto',
  'worldmonitor/seismology/v1/list_earthquakes.proto',
  'worldmonitor/trade/v1/get_trade_barriers.proto',
  'worldmonitor/trade/v1/get_trade_restrictions.proto',
  'worldmonitor/unrest/v1/list_unrest_events.proto',
  'worldmonitor/wildfire/v1/list_fire_detections.proto',
]);

const DEFAULT_FORCED_NOOP_QUERY_PARAMS = new Set([
  'worldmonitor/aviation/v1/list_airport_delays.proto:page_size',
  'worldmonitor/aviation/v1/list_airport_delays.proto:cursor',
  'worldmonitor/aviation/v1/list_airport_delays.proto:region',
  'worldmonitor/aviation/v1/list_airport_delays.proto:min_severity',
  'worldmonitor/climate/v1/list_climate_anomalies.proto:page_size',
  'worldmonitor/climate/v1/list_climate_anomalies.proto:cursor',
  'worldmonitor/climate/v1/list_climate_anomalies.proto:min_severity',
  'worldmonitor/conflict/v1/list_acled_events.proto:page_size',
  'worldmonitor/conflict/v1/list_acled_events.proto:cursor',
  'worldmonitor/conflict/v1/list_ucdp_events.proto:start',
  'worldmonitor/conflict/v1/list_ucdp_events.proto:end',
  'worldmonitor/conflict/v1/list_ucdp_events.proto:page_size',
  'worldmonitor/conflict/v1/list_ucdp_events.proto:cursor',
  'worldmonitor/cyber/v1/list_cyber_threats.proto:start',
  'worldmonitor/cyber/v1/list_cyber_threats.proto:end',
  'worldmonitor/economic/v1/get_economic_calendar.proto:fromDate',
  'worldmonitor/economic/v1/get_economic_calendar.proto:toDate',
  'worldmonitor/economic/v1/get_energy_capacity.proto:years',
  'worldmonitor/economic/v1/list_world_bank_indicators.proto:page_size',
  'worldmonitor/economic/v1/list_world_bank_indicators.proto:cursor',
  'worldmonitor/infrastructure/v1/list_internet_outages.proto:page_size',
  'worldmonitor/infrastructure/v1/list_internet_outages.proto:cursor',
  'worldmonitor/intelligence/v1/search_gdelt_documents.proto:timespan',
  'worldmonitor/intelligence/v1/search_gdelt_documents.proto:tone_filter',
  'worldmonitor/intelligence/v1/search_gdelt_documents.proto:sort',
  'worldmonitor/maritime/v1/list_navigational_warnings.proto:page_size',
  'worldmonitor/maritime/v1/list_navigational_warnings.proto:cursor',
  'worldmonitor/market/v1/get_sector_summary.proto:period',
  'worldmonitor/market/v1/list_earnings_calendar.proto:fromDate',
  'worldmonitor/market/v1/list_earnings_calendar.proto:toDate',
  'worldmonitor/military/v1/get_theater_posture.proto:theater',
  'worldmonitor/military/v1/list_military_flights.proto:cursor',
  'worldmonitor/military/v1/list_military_flights.proto:operator',
  'worldmonitor/military/v1/list_military_flights.proto:aircraft_type',
  'worldmonitor/natural/v1/list_natural_events.proto:days',
  'worldmonitor/prediction/v1/list_prediction_markets.proto:cursor',
  'worldmonitor/research/v1/list_arxiv_papers.proto:cursor',
  'worldmonitor/research/v1/list_arxiv_papers.proto:query',
  'worldmonitor/seismology/v1/list_earthquakes.proto:start',
  'worldmonitor/seismology/v1/list_earthquakes.proto:end',
  'worldmonitor/seismology/v1/list_earthquakes.proto:cursor',
  'worldmonitor/seismology/v1/list_earthquakes.proto:min_magnitude',
  'worldmonitor/trade/v1/get_trade_barriers.proto:countries',
  'worldmonitor/trade/v1/get_trade_barriers.proto:measure_type',
  'worldmonitor/trade/v1/get_trade_restrictions.proto:countries',
  'worldmonitor/unrest/v1/list_unrest_events.proto:page_size',
  'worldmonitor/unrest/v1/list_unrest_events.proto:cursor',
  'worldmonitor/unrest/v1/list_unrest_events.proto:min_severity',
  'worldmonitor/unrest/v1/list_unrest_events.proto:ne_lat',
  'worldmonitor/unrest/v1/list_unrest_events.proto:ne_lon',
  'worldmonitor/unrest/v1/list_unrest_events.proto:sw_lat',
  'worldmonitor/unrest/v1/list_unrest_events.proto:sw_lon',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:start',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:end',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:page_size',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:cursor',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:ne_lat',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:ne_lon',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:sw_lat',
  'worldmonitor/wildfire/v1/list_fire_detections.proto:sw_lon',
]);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function slash(path) {
  return path.split(sep).join('/');
}

function snakeToCamel(value) {
  return value.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function snakeToKebab(value) {
  return value.replace(/_/g, '-');
}

function parseProtoQueryFields(protoFile) {
  const lines = readFileSync(protoFile, 'utf8').split('\n');
  const fields = [];
  let comments = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('//')) {
      comments.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    if (trimmed === '') {
      comments = [];
      continue;
    }

    const fieldMatch = trimmed.match(/^(?:optional\s+|repeated\s+)?(?:map<[^>]+>|[A-Za-z_][\w.]*)\s+([a-z][a-z0-9_]*)\s*=\s*\d+\b/);
    if (!fieldMatch) {
      comments = [];
      continue;
    }

    const startLine = i + 1;
    let declaration = trimmed;
    while (!declaration.includes(';') && i + 1 < lines.length) {
      i++;
      declaration += ' ' + lines[i].trim();
    }

    if (declaration.includes('(sebuf.http.query)')) {
      const fieldName = fieldMatch[1];
      const queryName = declaration.match(/\(sebuf\.http\.query\)\s*=\s*\{[^}]*\bname\s*:\s*"([^"]+)"/)?.[1] ?? fieldName;
      fields.push({
        file: protoFile,
        line: startLine,
        fieldName,
        tsName: snakeToCamel(fieldName),
        queryName,
        unimplemented: /\(sebuf\.http\.unimplemented\)\s*=\s*true\b/.test(declaration),
        comment: comments.join(' '),
      });
    }

    comments = [];
  }

  return fields;
}

function handlerPathForProto(root, protoFile) {
  const rel = slash(relative(join(root, 'proto'), protoFile));
  const parts = rel.split('/');
  if (parts[0] !== 'worldmonitor' || parts.length < 4) return null;

  const snakeDomain = parts[1];
  const version = parts[2];
  const filename = parts[3];
  const handlerName = snakeToKebab(basename(filename, '.proto'));
  return join(root, 'server', 'worldmonitor', snakeToKebab(snakeDomain), version, handlerName + '.ts');
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function bindingElementUsesField(node, field) {
  const candidates = [node.propertyName, node.name].filter(Boolean);
  return candidates.some((candidate) => {
    if (ts.isIdentifier(candidate)) return candidate.text === field.tsName;
    if (isStringLiteralLike(candidate)) return candidate.text === field.tsName || candidate.text === field.queryName;
    return false;
  });
}

function bindingPatternUsesField(pattern, field) {
  return pattern.elements.some((element) => ts.isBindingElement(element) && bindingElementUsesField(element, field));
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function collectHandlerRequestNames(source, field) {
  const requestNames = new Set();
  let requestParamUsesField = false;

  function collectFunctionLike(node) {
    const requestParam = node.parameters[1];
    if (!requestParam) return;
    if (ts.isIdentifier(requestParam.name)) {
      requestNames.add(requestParam.name.text);
    } else if (ts.isObjectBindingPattern(requestParam.name) && bindingPatternUsesField(requestParam.name, field)) {
      requestParamUsesField = true;
    }
  }

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      collectFunctionLike(statement);
      continue;
    }

    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        collectFunctionLike(initializer);
      }
    }
  }

  return { requestNames, requestParamUsesField };
}

function isRequestIdentifier(expression, requestNames) {
  return ts.isIdentifier(expression) && requestNames.has(expression.text);
}

function collectRequestAliases(source, requestNames) {
  const aliases = new Set(requestNames);
  let changed = true;

  while (changed) {
    changed = false;
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isRequestIdentifier(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  return aliases;
}

function bindingElementIsFromRequest(node, requestNames) {
  const pattern = node.parent;
  if (!ts.isObjectBindingPattern(pattern)) return false;
  const declaration = pattern.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    isRequestIdentifier(declaration.initializer, requestNames)
  );
}

function handlerUsesField(handlerPath, field) {
  const source = ts.createSourceFile(
    handlerPath,
    readFileSync(handlerPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { requestNames, requestParamUsesField } = collectHandlerRequestNames(source, field);
  if (requestParamUsesField) return true;

  const requestAliases = collectRequestAliases(source, requestNames);
  if (requestAliases.size === 0) return false;

  let used = false;

  function visit(node) {
    if (used) return;

    if (
      ts.isPropertyAccessExpression(node) &&
      isRequestIdentifier(node.expression, requestAliases) &&
      node.name.text === field.tsName
    ) {
      used = true;
      return;
    }

    if (
      ts.isElementAccessExpression(node) &&
      isRequestIdentifier(node.expression, requestAliases) &&
      node.argumentExpression &&
      isStringLiteralLike(node.argumentExpression) &&
      (node.argumentExpression.text === field.tsName || node.argumentExpression.text === field.queryName)
    ) {
      used = true;
      return;
    }

    if (ts.isBindingElement(node) && bindingElementIsFromRequest(node, requestAliases) && bindingElementUsesField(node, field)) {
      used = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return used;
}

export function collectQueryParamContractViolations(root, options = {}) {
  const scopedProtoFiles = options.scopedProtoFiles ?? DEFAULT_SCOPED_PROTO_FILES;
  const forcedNoopQueryParams = options.forcedNoopQueryParams ?? DEFAULT_FORCED_NOOP_QUERY_PARAMS;
  const seenQueryParams = new Set();
  const protoRoot = join(root, 'proto', 'worldmonitor');
  const protoFiles = walk(protoRoot).filter((file) => file.endsWith('.proto'));
  const violations = [];
  const stats = {
    protoFiles: protoFiles.length,
    queryFields: 0,
    unimplementedFields: 0,
    scopedQueryFields: 0,
  };

  for (const protoFile of protoFiles) {
    const handlerPath = handlerPathForProto(root, protoFile);
    const fields = parseProtoQueryFields(protoFile);
    if (fields.length === 0) continue;

    const protoRel = slash(relative(join(root, 'proto'), protoFile));
    const isScopedProto = scopedProtoFiles.has(protoRel);
    const hasAnnotatedField = fields.some((field) => field.unimplemented);
    if (!isScopedProto && !hasAnnotatedField) continue;

    if (!handlerPath || !existsSync(handlerPath)) {
      for (const field of fields) {
        violations.push({
          file: slash(relative(root, field.file)) + ':' + field.line,
          message: 'query param "' + field.queryName + '" has no matching handler file to verify',
          remedy: 'Restore the server/worldmonitor handler or move/remove the query annotation.',
        });
      }
      continue;
    }

    for (const field of fields) {
      stats.queryFields++;
      if (isScopedProto) stats.scopedQueryFields++;
      if (field.unimplemented) stats.unimplementedFields++;

      const queryParamKey = protoRel + ':' + field.queryName;
      seenQueryParams.add(queryParamKey);
      const mustBeNoop = forcedNoopQueryParams.has(queryParamKey);
      const relativeField = slash(relative(root, field.file)) + ':' + field.line;
      if (field.unimplemented && !NOOP_QUERY_DESCRIPTION_RE.test(field.comment)) {
        violations.push({
          file: relativeField,
          message: 'query param "' + field.queryName + '" is marked unimplemented but its proto comment does not disclose accepted-but-ignored/no-op behavior',
          remedy: 'Update the field comment so generated OpenAPI explicitly states the parameter is currently a no-op.',
        });
      }

      if (mustBeNoop && !field.unimplemented) {
        violations.push({
          file: relativeField,
          message: 'query param "' + field.queryName + '" is in the #4607 no-op registry but is not marked unimplemented',
          remedy: 'Mark the proto field with (sebuf.http.unimplemented) = true and document the accepted-but-ignored behavior.',
        });
      }

      if (isScopedProto && !field.unimplemented && !handlerUsesField(handlerPath, field)) {
        violations.push({
          file: relativeField,
          message: 'query param "' + field.queryName + '" is declared but not referenced by ' + slash(relative(root, handlerPath)),
          remedy: 'Implement the parameter in the handler, or mark the proto field with (sebuf.http.unimplemented) = true and document the no-op behavior in the field comment.',
        });
      }
    }
  }

  for (const forced of forcedNoopQueryParams) {
    if (!seenQueryParams.has(forced)) {
      violations.push({
        file: 'scripts/lib/sebuf-query-param-contract.mjs',
        message: '#4607 no-op registry entry "' + forced + '" no longer matches a proto query param',
        remedy: 'Update the registry after renaming/removing the query param, or restore the proto annotation.',
      });
    }
  }

  return { violations, stats };
}
