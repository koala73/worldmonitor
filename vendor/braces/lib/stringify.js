'use strict';

const utils = require('./utils');
const { MAX_DEPTH } = require('./constants');

module.exports = (ast, options = {}) => {
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.min(MAX_DEPTH, options.maxDepth) : MAX_DEPTH;
  const stringify = (node, parent = {}, depth = 0) => {
    if (node.nodes && depth > maxDepth) {
      throw new RangeError(`AST depth (${depth}), exceeds max depth (${maxDepth})`);
    }
    const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    let output = '';

    if (node.value) {
      if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
        return '\\' + node.value;
      }
      return node.value;
    }

    if (node.value) {
      return node.value;
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        output += stringify(child, undefined, child.nodes ? depth + 1 : depth);
      }
    }
    return output;
  };

  return stringify(ast, {}, ast.type === 'root' ? 0 : 1);
};
