'use strict';

const zlib = require('node:zlib');

function delayFirstGeneration(methodName) {
  const original = zlib[methodName].bind(zlib);
  let calls = 0;
  zlib[methodName] = (...args) => {
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    const delayCallback = calls++ < 2;
    if (delayCallback && typeof callback === 'function') {
      args[callbackIndex] = (error, result) => {
        setTimeout(() => callback(error, result), 500);
      };
    }
    return original(...args);
  };
}

delayFirstGeneration('gzip');
delayFirstGeneration('brotliCompress');
