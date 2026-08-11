import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STOCK_WORKSPACE_SYMBOL,
  isStockWorkspacePath,
  normalizeStockWorkspaceSymbol,
  stockWorkspaceSymbolFromPath,
  stockWorkspaceUrl,
} from '../src/features/pokieticker/stock-workspace-route.ts';

test('stock workspace routes accept only owned stock URLs and normalize the selected symbol', () => {
  assert.equal(isStockWorkspacePath('/stocks'), true);
  assert.equal(isStockWorkspacePath('/stocks/AAPL'), true);
  assert.equal(isStockWorkspacePath('/stocks/BABA/'), true);
  assert.equal(isStockWorkspacePath('/stocks/AAPL/extra'), false);
  assert.equal(isStockWorkspacePath('/market/AAPL'), false);

  assert.equal(normalizeStockWorkspaceSymbol(' msft '), 'MSFT');
  assert.equal(normalizeStockWorkspaceSymbol('BRK.B'), 'BRK.B');
  assert.equal(normalizeStockWorkspaceSymbol('AAPL;DROP'), null);
  assert.equal(stockWorkspaceSymbolFromPath('/stocks/nvda'), 'NVDA');
  assert.equal(stockWorkspaceSymbolFromPath('/stocks/AAPL;DROP'), DEFAULT_STOCK_WORKSPACE_SYMBOL);
  assert.equal(stockWorkspaceUrl(' meta '), '/stocks/META');
});
