import harfbuzzWasm from "./harfbuzz.js";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __require = /* @__PURE__ */ ((x2) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x2, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x2)(function(x2) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw new Error('Dynamic require of "' + x2 + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to2, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// node_modules/.pnpm/escape-html@1.0.3/node_modules/escape-html/index.js
var require_escape_html = __commonJS({
  "node_modules/.pnpm/escape-html@1.0.3/node_modules/escape-html/index.js"(exports2, module) {
    "use strict";
    var matchHtmlRegExp = /["'&<>]/;
    module.exports = escapeHtml;
    function escapeHtml(string) {
      var str = "" + string;
      var match = matchHtmlRegExp.exec(str);
      if (!match) {
        return str;
      }
      var escape;
      var html = "";
      var index = 0;
      var lastIndex = 0;
      for (index = match.index; index < str.length; index++) {
        switch (str.charCodeAt(index)) {
          case 34:
            escape = "&quot;";
            break;
          case 38:
            escape = "&amp;";
            break;
          case 39:
            escape = "&#39;";
            break;
          case 60:
            escape = "&lt;";
            break;
          case 62:
            escape = "&gt;";
            break;
          default:
            continue;
        }
        if (lastIndex !== index) {
          html += str.substring(lastIndex, index);
        }
        lastIndex = index + 1;
        html += escape;
      }
      return lastIndex !== index ? html + str.substring(lastIndex, index) : html;
    }
  }
});

// node_modules/.pnpm/tiny-inflate@1.0.3/node_modules/tiny-inflate/index.js
var require_tiny_inflate = __commonJS({
  "node_modules/.pnpm/tiny-inflate@1.0.3/node_modules/tiny-inflate/index.js"(exports2, module) {
    var TINF_OK = 0;
    var TINF_DATA_ERROR = -3;
    function Tree() {
      this.table = new Uint16Array(16);
      this.trans = new Uint16Array(288);
    }
    function Data(source, dest) {
      this.source = source;
      this.sourceIndex = 0;
      this.tag = 0;
      this.bitcount = 0;
      this.dest = dest;
      this.destLen = 0;
      this.ltree = new Tree();
      this.dtree = new Tree();
    }
    var sltree = new Tree();
    var sdtree = new Tree();
    var length_bits = new Uint8Array(30);
    var length_base = new Uint16Array(30);
    var dist_bits = new Uint8Array(30);
    var dist_base = new Uint16Array(30);
    var clcidx = new Uint8Array([
      16,
      17,
      18,
      0,
      8,
      7,
      9,
      6,
      10,
      5,
      11,
      4,
      12,
      3,
      13,
      2,
      14,
      1,
      15
    ]);
    var code_tree = new Tree();
    var lengths = new Uint8Array(288 + 32);
    function tinf_build_bits_base(bits3, base, delta, first) {
      var i, sum;
      for (i = 0; i < delta; ++i)
        bits3[i] = 0;
      for (i = 0; i < 30 - delta; ++i)
        bits3[i + delta] = i / delta | 0;
      for (sum = first, i = 0; i < 30; ++i) {
        base[i] = sum;
        sum += 1 << bits3[i];
      }
    }
    function tinf_build_fixed_trees(lt, dt2) {
      var i;
      for (i = 0; i < 7; ++i)
        lt.table[i] = 0;
      lt.table[7] = 24;
      lt.table[8] = 152;
      lt.table[9] = 112;
      for (i = 0; i < 24; ++i)
        lt.trans[i] = 256 + i;
      for (i = 0; i < 144; ++i)
        lt.trans[24 + i] = i;
      for (i = 0; i < 8; ++i)
        lt.trans[24 + 144 + i] = 280 + i;
      for (i = 0; i < 112; ++i)
        lt.trans[24 + 144 + 8 + i] = 144 + i;
      for (i = 0; i < 5; ++i)
        dt2.table[i] = 0;
      dt2.table[5] = 32;
      for (i = 0; i < 32; ++i)
        dt2.trans[i] = i;
    }
    var offs = new Uint16Array(16);
    function tinf_build_tree(t, lengths2, off, num) {
      var i, sum;
      for (i = 0; i < 16; ++i)
        t.table[i] = 0;
      for (i = 0; i < num; ++i)
        t.table[lengths2[off + i]]++;
      t.table[0] = 0;
      for (sum = 0, i = 0; i < 16; ++i) {
        offs[i] = sum;
        sum += t.table[i];
      }
      for (i = 0; i < num; ++i) {
        if (lengths2[off + i])
          t.trans[offs[lengths2[off + i]]++] = i;
      }
    }
    function tinf_getbit(d2) {
      if (!d2.bitcount--) {
        d2.tag = d2.source[d2.sourceIndex++];
        d2.bitcount = 7;
      }
      var bit = d2.tag & 1;
      d2.tag >>>= 1;
      return bit;
    }
    function tinf_read_bits(d2, num, base) {
      if (!num)
        return base;
      while (d2.bitcount < 24) {
        d2.tag |= d2.source[d2.sourceIndex++] << d2.bitcount;
        d2.bitcount += 8;
      }
      var val = d2.tag & 65535 >>> 16 - num;
      d2.tag >>>= num;
      d2.bitcount -= num;
      return val + base;
    }
    function tinf_decode_symbol(d2, t) {
      while (d2.bitcount < 24) {
        d2.tag |= d2.source[d2.sourceIndex++] << d2.bitcount;
        d2.bitcount += 8;
      }
      var sum = 0, cur = 0, len = 0;
      var tag = d2.tag;
      do {
        cur = 2 * cur + (tag & 1);
        tag >>>= 1;
        ++len;
        sum += t.table[len];
        cur -= t.table[len];
      } while (cur >= 0);
      d2.tag = tag;
      d2.bitcount -= len;
      return t.trans[sum + cur];
    }
    function tinf_decode_trees(d2, lt, dt2) {
      var hlit, hdist, hclen;
      var i, num, length;
      hlit = tinf_read_bits(d2, 5, 257);
      hdist = tinf_read_bits(d2, 5, 1);
      hclen = tinf_read_bits(d2, 4, 4);
      for (i = 0; i < 19; ++i)
        lengths[i] = 0;
      for (i = 0; i < hclen; ++i) {
        var clen = tinf_read_bits(d2, 3, 0);
        lengths[clcidx[i]] = clen;
      }
      tinf_build_tree(code_tree, lengths, 0, 19);
      for (num = 0; num < hlit + hdist; ) {
        var sym = tinf_decode_symbol(d2, code_tree);
        switch (sym) {
          case 16:
            var prev = lengths[num - 1];
            for (length = tinf_read_bits(d2, 2, 3); length; --length) {
              lengths[num++] = prev;
            }
            break;
          case 17:
            for (length = tinf_read_bits(d2, 3, 3); length; --length) {
              lengths[num++] = 0;
            }
            break;
          case 18:
            for (length = tinf_read_bits(d2, 7, 11); length; --length) {
              lengths[num++] = 0;
            }
            break;
          default:
            lengths[num++] = sym;
            break;
        }
      }
      tinf_build_tree(lt, lengths, 0, hlit);
      tinf_build_tree(dt2, lengths, hlit, hdist);
    }
    function tinf_inflate_block_data(d2, lt, dt2) {
      while (1) {
        var sym = tinf_decode_symbol(d2, lt);
        if (sym === 256) {
          return TINF_OK;
        }
        if (sym < 256) {
          d2.dest[d2.destLen++] = sym;
        } else {
          var length, dist, offs2;
          var i;
          sym -= 257;
          length = tinf_read_bits(d2, length_bits[sym], length_base[sym]);
          dist = tinf_decode_symbol(d2, dt2);
          offs2 = d2.destLen - tinf_read_bits(d2, dist_bits[dist], dist_base[dist]);
          for (i = offs2; i < offs2 + length; ++i) {
            d2.dest[d2.destLen++] = d2.dest[i];
          }
        }
      }
    }
    function tinf_inflate_uncompressed_block(d2) {
      var length, invlength;
      var i;
      while (d2.bitcount > 8) {
        d2.sourceIndex--;
        d2.bitcount -= 8;
      }
      length = d2.source[d2.sourceIndex + 1];
      length = 256 * length + d2.source[d2.sourceIndex];
      invlength = d2.source[d2.sourceIndex + 3];
      invlength = 256 * invlength + d2.source[d2.sourceIndex + 2];
      if (length !== (~invlength & 65535))
        return TINF_DATA_ERROR;
      d2.sourceIndex += 4;
      for (i = length; i; --i)
        d2.dest[d2.destLen++] = d2.source[d2.sourceIndex++];
      d2.bitcount = 0;
      return TINF_OK;
    }
    function tinf_uncompress(source, dest) {
      var d2 = new Data(source, dest);
      var bfinal, btype, res;
      do {
        bfinal = tinf_getbit(d2);
        btype = tinf_read_bits(d2, 2, 0);
        switch (btype) {
          case 0:
            res = tinf_inflate_uncompressed_block(d2);
            break;
          case 1:
            res = tinf_inflate_block_data(d2, sltree, sdtree);
            break;
          case 2:
            tinf_decode_trees(d2, d2.ltree, d2.dtree);
            res = tinf_inflate_block_data(d2, d2.ltree, d2.dtree);
            break;
          default:
            res = TINF_DATA_ERROR;
        }
        if (res !== TINF_OK)
          throw new Error("Data error");
      } while (!bfinal);
      if (d2.destLen < d2.dest.length) {
        if (typeof d2.dest.slice === "function")
          return d2.dest.slice(0, d2.destLen);
        else
          return d2.dest.subarray(0, d2.destLen);
      }
      return d2.dest;
    }
    tinf_build_fixed_trees(sltree, sdtree);
    tinf_build_bits_base(length_bits, length_base, 4, 3);
    tinf_build_bits_base(dist_bits, dist_base, 2, 1);
    length_bits[28] = 0;
    length_base[28] = 258;
    module.exports = tinf_uncompress;
  }
});

// node_modules/.pnpm/unicode-trie@2.0.0/node_modules/unicode-trie/swap.js
var require_swap = __commonJS({
  "node_modules/.pnpm/unicode-trie@2.0.0/node_modules/unicode-trie/swap.js"(exports2, module) {
    var isBigEndian = new Uint8Array(new Uint32Array([305419896]).buffer)[0] === 18;
    var swap = (b, n, m2) => {
      let i = b[n];
      b[n] = b[m2];
      b[m2] = i;
    };
    var swap32 = (array) => {
      const len = array.length;
      for (let i = 0; i < len; i += 4) {
        swap(array, i, i + 3);
        swap(array, i + 1, i + 2);
      }
    };
    var swap32LE = (array) => {
      if (isBigEndian) {
        swap32(array);
      }
    };
    module.exports = {
      swap32LE
    };
  }
});

// node_modules/.pnpm/unicode-trie@2.0.0/node_modules/unicode-trie/index.js
var require_unicode_trie = __commonJS({
  "node_modules/.pnpm/unicode-trie@2.0.0/node_modules/unicode-trie/index.js"(exports2, module) {
    var inflate = require_tiny_inflate();
    var { swap32LE } = require_swap();
    var SHIFT_1 = 6 + 5;
    var SHIFT_2 = 5;
    var SHIFT_1_2 = SHIFT_1 - SHIFT_2;
    var OMITTED_BMP_INDEX_1_LENGTH = 65536 >> SHIFT_1;
    var INDEX_2_BLOCK_LENGTH = 1 << SHIFT_1_2;
    var INDEX_2_MASK = INDEX_2_BLOCK_LENGTH - 1;
    var INDEX_SHIFT = 2;
    var DATA_BLOCK_LENGTH = 1 << SHIFT_2;
    var DATA_MASK = DATA_BLOCK_LENGTH - 1;
    var LSCP_INDEX_2_OFFSET = 65536 >> SHIFT_2;
    var LSCP_INDEX_2_LENGTH = 1024 >> SHIFT_2;
    var INDEX_2_BMP_LENGTH = LSCP_INDEX_2_OFFSET + LSCP_INDEX_2_LENGTH;
    var UTF8_2B_INDEX_2_OFFSET = INDEX_2_BMP_LENGTH;
    var UTF8_2B_INDEX_2_LENGTH = 2048 >> 6;
    var INDEX_1_OFFSET = UTF8_2B_INDEX_2_OFFSET + UTF8_2B_INDEX_2_LENGTH;
    var DATA_GRANULARITY = 1 << INDEX_SHIFT;
    var UnicodeTrie = class {
      constructor(data) {
        const isBuffer = typeof data.readUInt32BE === "function" && typeof data.slice === "function";
        if (isBuffer || data instanceof Uint8Array) {
          let uncompressedLength;
          if (isBuffer) {
            this.highStart = data.readUInt32LE(0);
            this.errorValue = data.readUInt32LE(4);
            uncompressedLength = data.readUInt32LE(8);
            data = data.slice(12);
          } else {
            const view = new DataView(data.buffer);
            this.highStart = view.getUint32(0, true);
            this.errorValue = view.getUint32(4, true);
            uncompressedLength = view.getUint32(8, true);
            data = data.subarray(12);
          }
          data = inflate(data, new Uint8Array(uncompressedLength));
          data = inflate(data, new Uint8Array(uncompressedLength));
          swap32LE(data);
          this.data = new Uint32Array(data.buffer);
        } else {
          ({ data: this.data, highStart: this.highStart, errorValue: this.errorValue } = data);
        }
      }
      get(codePoint) {
        let index;
        if (codePoint < 0 || codePoint > 1114111) {
          return this.errorValue;
        }
        if (codePoint < 55296 || codePoint > 56319 && codePoint <= 65535) {
          index = (this.data[codePoint >> SHIFT_2] << INDEX_SHIFT) + (codePoint & DATA_MASK);
          return this.data[index];
        }
        if (codePoint <= 65535) {
          index = (this.data[LSCP_INDEX_2_OFFSET + (codePoint - 55296 >> SHIFT_2)] << INDEX_SHIFT) + (codePoint & DATA_MASK);
          return this.data[index];
        }
        if (codePoint < this.highStart) {
          index = this.data[INDEX_1_OFFSET - OMITTED_BMP_INDEX_1_LENGTH + (codePoint >> SHIFT_1)];
          index = this.data[index + (codePoint >> SHIFT_2 & INDEX_2_MASK)];
          index = (index << INDEX_SHIFT) + (codePoint & DATA_MASK);
          return this.data[index];
        }
        return this.data[this.data.length - DATA_GRANULARITY];
      }
    };
    module.exports = UnicodeTrie;
  }
});

// node_modules/.pnpm/base64-js@0.0.8/node_modules/base64-js/lib/b64.js
var require_b64 = __commonJS({
  "node_modules/.pnpm/base64-js@0.0.8/node_modules/base64-js/lib/b64.js"(exports2) {
    var lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    (function(exports3) {
      "use strict";
      var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
      var PLUS = "+".charCodeAt(0);
      var SLASH = "/".charCodeAt(0);
      var NUMBER = "0".charCodeAt(0);
      var LOWER = "a".charCodeAt(0);
      var UPPER = "A".charCodeAt(0);
      var PLUS_URL_SAFE = "-".charCodeAt(0);
      var SLASH_URL_SAFE = "_".charCodeAt(0);
      function decode2(elt) {
        var code = elt.charCodeAt(0);
        if (code === PLUS || code === PLUS_URL_SAFE)
          return 62;
        if (code === SLASH || code === SLASH_URL_SAFE)
          return 63;
        if (code < NUMBER)
          return -1;
        if (code < NUMBER + 10)
          return code - NUMBER + 26 + 26;
        if (code < UPPER + 26)
          return code - UPPER;
        if (code < LOWER + 26)
          return code - LOWER + 26;
      }
      function b64ToByteArray(b64) {
        var i, j, l2, tmp, placeHolders, arr;
        if (b64.length % 4 > 0) {
          throw new Error("Invalid string. Length must be a multiple of 4");
        }
        var len = b64.length;
        placeHolders = "=" === b64.charAt(len - 2) ? 2 : "=" === b64.charAt(len - 1) ? 1 : 0;
        arr = new Arr(b64.length * 3 / 4 - placeHolders);
        l2 = placeHolders > 0 ? b64.length - 4 : b64.length;
        var L = 0;
        function push(v2) {
          arr[L++] = v2;
        }
        for (i = 0, j = 0; i < l2; i += 4, j += 3) {
          tmp = decode2(b64.charAt(i)) << 18 | decode2(b64.charAt(i + 1)) << 12 | decode2(b64.charAt(i + 2)) << 6 | decode2(b64.charAt(i + 3));
          push((tmp & 16711680) >> 16);
          push((tmp & 65280) >> 8);
          push(tmp & 255);
        }
        if (placeHolders === 2) {
          tmp = decode2(b64.charAt(i)) << 2 | decode2(b64.charAt(i + 1)) >> 4;
          push(tmp & 255);
        } else if (placeHolders === 1) {
          tmp = decode2(b64.charAt(i)) << 10 | decode2(b64.charAt(i + 1)) << 4 | decode2(b64.charAt(i + 2)) >> 2;
          push(tmp >> 8 & 255);
          push(tmp & 255);
        }
        return arr;
      }
      function uint8ToBase64(uint8) {
        var i, extraBytes = uint8.length % 3, output = "", temp, length;
        function encode(num) {
          return lookup.charAt(num);
        }
        function tripletToBase64(num) {
          return encode(num >> 18 & 63) + encode(num >> 12 & 63) + encode(num >> 6 & 63) + encode(num & 63);
        }
        for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
          temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + uint8[i + 2];
          output += tripletToBase64(temp);
        }
        switch (extraBytes) {
          case 1:
            temp = uint8[uint8.length - 1];
            output += encode(temp >> 2);
            output += encode(temp << 4 & 63);
            output += "==";
            break;
          case 2:
            temp = (uint8[uint8.length - 2] << 8) + uint8[uint8.length - 1];
            output += encode(temp >> 10);
            output += encode(temp >> 4 & 63);
            output += encode(temp << 2 & 63);
            output += "=";
            break;
        }
        return output;
      }
      exports3.toByteArray = b64ToByteArray;
      exports3.fromByteArray = uint8ToBase64;
    })(typeof exports2 === "undefined" ? exports2.base64js = {} : exports2);
  }
});

// node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/parse.js"(exports2, module) {
    var openParentheses = "(".charCodeAt(0);
    var closeParentheses = ")".charCodeAt(0);
    var singleQuote = "'".charCodeAt(0);
    var doubleQuote = '"'.charCodeAt(0);
    var backslash = "\\".charCodeAt(0);
    var slash = "/".charCodeAt(0);
    var comma = ",".charCodeAt(0);
    var colon = ":".charCodeAt(0);
    var star = "*".charCodeAt(0);
    var uLower = "u".charCodeAt(0);
    var uUpper = "U".charCodeAt(0);
    var plus = "+".charCodeAt(0);
    var isUnicodeRange = /^[a-f0-9?-]+$/i;
    module.exports = function(input) {
      var tokens = [];
      var value = input;
      var next, quote, prev, token, escape, escapePos, whitespacePos, parenthesesOpenPos;
      var pos = 0;
      var code = value.charCodeAt(pos);
      var max3 = value.length;
      var stack = [{ nodes: tokens }];
      var balanced = 0;
      var parent;
      var name = "";
      var before = "";
      var after = "";
      while (pos < max3) {
        if (code <= 32) {
          next = pos;
          do {
            next += 1;
            code = value.charCodeAt(next);
          } while (code <= 32);
          token = value.slice(pos, next);
          prev = tokens[tokens.length - 1];
          if (code === closeParentheses && balanced) {
            after = token;
          } else if (prev && prev.type === "div") {
            prev.after = token;
            prev.sourceEndIndex += token.length;
          } else if (code === comma || code === colon || code === slash && value.charCodeAt(next + 1) !== star && (!parent || parent && parent.type === "function" && parent.value !== "calc")) {
            before = token;
          } else {
            tokens.push({
              type: "space",
              sourceIndex: pos,
              sourceEndIndex: next,
              value: token
            });
          }
          pos = next;
        } else if (code === singleQuote || code === doubleQuote) {
          next = pos;
          quote = code === singleQuote ? "'" : '"';
          token = {
            type: "string",
            sourceIndex: pos,
            quote
          };
          do {
            escape = false;
            next = value.indexOf(quote, next + 1);
            if (~next) {
              escapePos = next;
              while (value.charCodeAt(escapePos - 1) === backslash) {
                escapePos -= 1;
                escape = !escape;
              }
            } else {
              value += quote;
              next = value.length - 1;
              token.unclosed = true;
            }
          } while (escape);
          token.value = value.slice(pos + 1, next);
          token.sourceEndIndex = token.unclosed ? next : next + 1;
          tokens.push(token);
          pos = next + 1;
          code = value.charCodeAt(pos);
        } else if (code === slash && value.charCodeAt(pos + 1) === star) {
          next = value.indexOf("*/", pos);
          token = {
            type: "comment",
            sourceIndex: pos,
            sourceEndIndex: next + 2
          };
          if (next === -1) {
            token.unclosed = true;
            next = value.length;
            token.sourceEndIndex = next;
          }
          token.value = value.slice(pos + 2, next);
          tokens.push(token);
          pos = next + 2;
          code = value.charCodeAt(pos);
        } else if ((code === slash || code === star) && parent && parent.type === "function" && parent.value === "calc") {
          token = value[pos];
          tokens.push({
            type: "word",
            sourceIndex: pos - before.length,
            sourceEndIndex: pos + token.length,
            value: token
          });
          pos += 1;
          code = value.charCodeAt(pos);
        } else if (code === slash || code === comma || code === colon) {
          token = value[pos];
          tokens.push({
            type: "div",
            sourceIndex: pos - before.length,
            sourceEndIndex: pos + token.length,
            value: token,
            before,
            after: ""
          });
          before = "";
          pos += 1;
          code = value.charCodeAt(pos);
        } else if (openParentheses === code) {
          next = pos;
          do {
            next += 1;
            code = value.charCodeAt(next);
          } while (code <= 32);
          parenthesesOpenPos = pos;
          token = {
            type: "function",
            sourceIndex: pos - name.length,
            value: name,
            before: value.slice(parenthesesOpenPos + 1, next)
          };
          pos = next;
          if (name === "url" && code !== singleQuote && code !== doubleQuote) {
            next -= 1;
            do {
              escape = false;
              next = value.indexOf(")", next + 1);
              if (~next) {
                escapePos = next;
                while (value.charCodeAt(escapePos - 1) === backslash) {
                  escapePos -= 1;
                  escape = !escape;
                }
              } else {
                value += ")";
                next = value.length - 1;
                token.unclosed = true;
              }
            } while (escape);
            whitespacePos = next;
            do {
              whitespacePos -= 1;
              code = value.charCodeAt(whitespacePos);
            } while (code <= 32);
            if (parenthesesOpenPos < whitespacePos) {
              if (pos !== whitespacePos + 1) {
                token.nodes = [
                  {
                    type: "word",
                    sourceIndex: pos,
                    sourceEndIndex: whitespacePos + 1,
                    value: value.slice(pos, whitespacePos + 1)
                  }
                ];
              } else {
                token.nodes = [];
              }
              if (token.unclosed && whitespacePos + 1 !== next) {
                token.after = "";
                token.nodes.push({
                  type: "space",
                  sourceIndex: whitespacePos + 1,
                  sourceEndIndex: next,
                  value: value.slice(whitespacePos + 1, next)
                });
              } else {
                token.after = value.slice(whitespacePos + 1, next);
                token.sourceEndIndex = next;
              }
            } else {
              token.after = "";
              token.nodes = [];
            }
            pos = next + 1;
            token.sourceEndIndex = token.unclosed ? next : pos;
            code = value.charCodeAt(pos);
            tokens.push(token);
          } else {
            balanced += 1;
            token.after = "";
            token.sourceEndIndex = pos + 1;
            tokens.push(token);
            stack.push(token);
            tokens = token.nodes = [];
            parent = token;
          }
          name = "";
        } else if (closeParentheses === code && balanced) {
          pos += 1;
          code = value.charCodeAt(pos);
          parent.after = after;
          parent.sourceEndIndex += after.length;
          after = "";
          balanced -= 1;
          stack[stack.length - 1].sourceEndIndex = pos;
          stack.pop();
          parent = stack[balanced];
          tokens = parent.nodes;
        } else {
          next = pos;
          do {
            if (code === backslash) {
              next += 1;
            }
            next += 1;
            code = value.charCodeAt(next);
          } while (next < max3 && !(code <= 32 || code === singleQuote || code === doubleQuote || code === comma || code === colon || code === slash || code === openParentheses || code === star && parent && parent.type === "function" && parent.value === "calc" || code === slash && parent.type === "function" && parent.value === "calc" || code === closeParentheses && balanced));
          token = value.slice(pos, next);
          if (openParentheses === code) {
            name = token;
          } else if ((uLower === token.charCodeAt(0) || uUpper === token.charCodeAt(0)) && plus === token.charCodeAt(1) && isUnicodeRange.test(token.slice(2))) {
            tokens.push({
              type: "unicode-range",
              sourceIndex: pos,
              sourceEndIndex: next,
              value: token
            });
          } else {
            tokens.push({
              type: "word",
              sourceIndex: pos,
              sourceEndIndex: next,
              value: token
            });
          }
          pos = next;
        }
      }
      for (pos = stack.length - 1; pos; pos -= 1) {
        stack[pos].unclosed = true;
        stack[pos].sourceEndIndex = value.length;
      }
      return stack[0].nodes;
    };
  }
});

// node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/walk.js
var require_walk = __commonJS({
  "node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/walk.js"(exports2, module) {
    module.exports = function walk(nodes, cb, bubble) {
      var i, max3, node, result;
      for (i = 0, max3 = nodes.length; i < max3; i += 1) {
        node = nodes[i];
        if (!bubble) {
          result = cb(node, i, nodes);
        }
        if (result !== false && node.type === "function" && Array.isArray(node.nodes)) {
          walk(node.nodes, cb, bubble);
        }
        if (bubble) {
          cb(node, i, nodes);
        }
      }
    };
  }
});

// node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/stringify.js
var require_stringify = __commonJS({
  "node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/stringify.js"(exports2, module) {
    function stringifyNode(node, custom) {
      var type = node.type;
      var value = node.value;
      var buf;
      var customResult;
      if (custom && (customResult = custom(node)) !== void 0) {
        return customResult;
      } else if (type === "word" || type === "space") {
        return value;
      } else if (type === "string") {
        buf = node.quote || "";
        return buf + value + (node.unclosed ? "" : buf);
      } else if (type === "comment") {
        return "/*" + value + (node.unclosed ? "" : "*/");
      } else if (type === "div") {
        return (node.before || "") + value + (node.after || "");
      } else if (Array.isArray(node.nodes)) {
        buf = stringify(node.nodes, custom);
        if (type !== "function") {
          return buf;
        }
        return value + "(" + (node.before || "") + buf + (node.after || "") + (node.unclosed ? "" : ")");
      }
      return value;
    }
    function stringify(nodes, custom) {
      var result, i;
      if (Array.isArray(nodes)) {
        result = "";
        for (i = nodes.length - 1; ~i; i -= 1) {
          result = stringifyNode(nodes[i], custom) + result;
        }
        return result;
      }
      return stringifyNode(nodes, custom);
    }
    module.exports = stringify;
  }
});

// node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/unit.js
var require_unit = __commonJS({
  "node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/unit.js"(exports2, module) {
    var minus = "-".charCodeAt(0);
    var plus = "+".charCodeAt(0);
    var dot = ".".charCodeAt(0);
    var exp = "e".charCodeAt(0);
    var EXP = "E".charCodeAt(0);
    function likeNumber(value) {
      var code = value.charCodeAt(0);
      var nextCode;
      if (code === plus || code === minus) {
        nextCode = value.charCodeAt(1);
        if (nextCode >= 48 && nextCode <= 57) {
          return true;
        }
        var nextNextCode = value.charCodeAt(2);
        if (nextCode === dot && nextNextCode >= 48 && nextNextCode <= 57) {
          return true;
        }
        return false;
      }
      if (code === dot) {
        nextCode = value.charCodeAt(1);
        if (nextCode >= 48 && nextCode <= 57) {
          return true;
        }
        return false;
      }
      if (code >= 48 && code <= 57) {
        return true;
      }
      return false;
    }
    module.exports = function(value) {
      var pos = 0;
      var length = value.length;
      var code;
      var nextCode;
      var nextNextCode;
      if (length === 0 || !likeNumber(value)) {
        return false;
      }
      code = value.charCodeAt(pos);
      if (code === plus || code === minus) {
        pos++;
      }
      while (pos < length) {
        code = value.charCodeAt(pos);
        if (code < 48 || code > 57) {
          break;
        }
        pos += 1;
      }
      code = value.charCodeAt(pos);
      nextCode = value.charCodeAt(pos + 1);
      if (code === dot && nextCode >= 48 && nextCode <= 57) {
        pos += 2;
        while (pos < length) {
          code = value.charCodeAt(pos);
          if (code < 48 || code > 57) {
            break;
          }
          pos += 1;
        }
      }
      code = value.charCodeAt(pos);
      nextCode = value.charCodeAt(pos + 1);
      nextNextCode = value.charCodeAt(pos + 2);
      if ((code === exp || code === EXP) && (nextCode >= 48 && nextCode <= 57 || (nextCode === plus || nextCode === minus) && nextNextCode >= 48 && nextNextCode <= 57)) {
        pos += nextCode === plus || nextCode === minus ? 3 : 2;
        while (pos < length) {
          code = value.charCodeAt(pos);
          if (code < 48 || code > 57) {
            break;
          }
          pos += 1;
        }
      }
      return {
        number: value.slice(0, pos),
        unit: value.slice(pos)
      };
    };
  }
});

// node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/index.js
var require_lib = __commonJS({
  "node_modules/.pnpm/postcss-value-parser@4.2.0/node_modules/postcss-value-parser/lib/index.js"(exports2, module) {
    var parse2 = require_parse();
    var walk = require_walk();
    var stringify = require_stringify();
    function ValueParser(value) {
      if (this instanceof ValueParser) {
        this.nodes = parse2(value);
        return this;
      }
      return new ValueParser(value);
    }
    ValueParser.prototype.toString = function() {
      return Array.isArray(this.nodes) ? stringify(this.nodes) : "";
    };
    ValueParser.prototype.walk = function(cb, bubble) {
      walk(this.nodes, cb, bubble);
      return this;
    };
    ValueParser.unit = require_unit();
    ValueParser.walk = walk;
    ValueParser.stringify = stringify;
    module.exports = ValueParser;
  }
});

// node_modules/.pnpm/camelize@1.0.1/node_modules/camelize/index.js
var require_camelize = __commonJS({
  "node_modules/.pnpm/camelize@1.0.1/node_modules/camelize/index.js"(exports2, module) {
    "use strict";
    module.exports = function(obj) {
      if (typeof obj === "string") {
        return camelCase(obj);
      }
      return walk(obj);
    };
    function walk(obj) {
      if (!obj || typeof obj !== "object") {
        return obj;
      }
      if (isDate(obj) || isRegex(obj)) {
        return obj;
      }
      if (isArray(obj)) {
        return map(obj, walk);
      }
      return reduce(objectKeys(obj), function(acc, key) {
        var camel = camelCase(key);
        acc[camel] = walk(obj[key]);
        return acc;
      }, {});
    }
    function camelCase(str) {
      return str.replace(/[_.-](\w|$)/g, function(_, x2) {
        return x2.toUpperCase();
      });
    }
    var isArray = Array.isArray || function(obj) {
      return Object.prototype.toString.call(obj) === "[object Array]";
    };
    var isDate = function(obj) {
      return Object.prototype.toString.call(obj) === "[object Date]";
    };
    var isRegex = function(obj) {
      return Object.prototype.toString.call(obj) === "[object RegExp]";
    };
    var has = Object.prototype.hasOwnProperty;
    var objectKeys = Object.keys || function(obj) {
      var keys = [];
      for (var key in obj) {
        if (has.call(obj, key)) {
          keys.push(key);
        }
      }
      return keys;
    };
    function map(xs, f) {
      if (xs.map) {
        return xs.map(f);
      }
      var res = [];
      for (var i = 0; i < xs.length; i++) {
        res.push(f(xs[i], i));
      }
      return res;
    }
    function reduce(xs, f, acc) {
      if (xs.reduce) {
        return xs.reduce(f, acc);
      }
      for (var i = 0; i < xs.length; i++) {
        acc = f(acc, xs[i], i);
      }
      return acc;
    }
  }
});

// node_modules/.pnpm/css-color-keywords@1.0.0/node_modules/css-color-keywords/colors.json
var require_colors = __commonJS({
  "node_modules/.pnpm/css-color-keywords@1.0.0/node_modules/css-color-keywords/colors.json"(exports2, module) {
    module.exports = {
      black: "#000000",
      silver: "#c0c0c0",
      gray: "#808080",
      white: "#ffffff",
      maroon: "#800000",
      red: "#ff0000",
      purple: "#800080",
      fuchsia: "#ff00ff",
      green: "#008000",
      lime: "#00ff00",
      olive: "#808000",
      yellow: "#ffff00",
      navy: "#000080",
      blue: "#0000ff",
      teal: "#008080",
      aqua: "#00ffff",
      orange: "#ffa500",
      aliceblue: "#f0f8ff",
      antiquewhite: "#faebd7",
      aquamarine: "#7fffd4",
      azure: "#f0ffff",
      beige: "#f5f5dc",
      bisque: "#ffe4c4",
      blanchedalmond: "#ffebcd",
      blueviolet: "#8a2be2",
      brown: "#a52a2a",
      burlywood: "#deb887",
      cadetblue: "#5f9ea0",
      chartreuse: "#7fff00",
      chocolate: "#d2691e",
      coral: "#ff7f50",
      cornflowerblue: "#6495ed",
      cornsilk: "#fff8dc",
      crimson: "#dc143c",
      darkblue: "#00008b",
      darkcyan: "#008b8b",
      darkgoldenrod: "#b8860b",
      darkgray: "#a9a9a9",
      darkgreen: "#006400",
      darkgrey: "#a9a9a9",
      darkkhaki: "#bdb76b",
      darkmagenta: "#8b008b",
      darkolivegreen: "#556b2f",
      darkorange: "#ff8c00",
      darkorchid: "#9932cc",
      darkred: "#8b0000",
      darksalmon: "#e9967a",
      darkseagreen: "#8fbc8f",
      darkslateblue: "#483d8b",
      darkslategray: "#2f4f4f",
      darkslategrey: "#2f4f4f",
      darkturquoise: "#00ced1",
      darkviolet: "#9400d3",
      deeppink: "#ff1493",
      deepskyblue: "#00bfff",
      dimgray: "#696969",
      dimgrey: "#696969",
      dodgerblue: "#1e90ff",
      firebrick: "#b22222",
      floralwhite: "#fffaf0",
      forestgreen: "#228b22",
      gainsboro: "#dcdcdc",
      ghostwhite: "#f8f8ff",
      gold: "#ffd700",
      goldenrod: "#daa520",
      greenyellow: "#adff2f",
      grey: "#808080",
      honeydew: "#f0fff0",
      hotpink: "#ff69b4",
      indianred: "#cd5c5c",
      indigo: "#4b0082",
      ivory: "#fffff0",
      khaki: "#f0e68c",
      lavender: "#e6e6fa",
      lavenderblush: "#fff0f5",
      lawngreen: "#7cfc00",
      lemonchiffon: "#fffacd",
      lightblue: "#add8e6",
      lightcoral: "#f08080",
      lightcyan: "#e0ffff",
      lightgoldenrodyellow: "#fafad2",
      lightgray: "#d3d3d3",
      lightgreen: "#90ee90",
      lightgrey: "#d3d3d3",
      lightpink: "#ffb6c1",
      lightsalmon: "#ffa07a",
      lightseagreen: "#20b2aa",
      lightskyblue: "#87cefa",
      lightslategray: "#778899",
      lightslategrey: "#778899",
      lightsteelblue: "#b0c4de",
      lightyellow: "#ffffe0",
      limegreen: "#32cd32",
      linen: "#faf0e6",
      mediumaquamarine: "#66cdaa",
      mediumblue: "#0000cd",
      mediumorchid: "#ba55d3",
      mediumpurple: "#9370db",
      mediumseagreen: "#3cb371",
      mediumslateblue: "#7b68ee",
      mediumspringgreen: "#00fa9a",
      mediumturquoise: "#48d1cc",
      mediumvioletred: "#c71585",
      midnightblue: "#191970",
      mintcream: "#f5fffa",
      mistyrose: "#ffe4e1",
      moccasin: "#ffe4b5",
      navajowhite: "#ffdead",
      oldlace: "#fdf5e6",
      olivedrab: "#6b8e23",
      orangered: "#ff4500",
      orchid: "#da70d6",
      palegoldenrod: "#eee8aa",
      palegreen: "#98fb98",
      paleturquoise: "#afeeee",
      palevioletred: "#db7093",
      papayawhip: "#ffefd5",
      peachpuff: "#ffdab9",
      peru: "#cd853f",
      pink: "#ffc0cb",
      plum: "#dda0dd",
      powderblue: "#b0e0e6",
      rosybrown: "#bc8f8f",
      royalblue: "#4169e1",
      saddlebrown: "#8b4513",
      salmon: "#fa8072",
      sandybrown: "#f4a460",
      seagreen: "#2e8b57",
      seashell: "#fff5ee",
      sienna: "#a0522d",
      skyblue: "#87ceeb",
      slateblue: "#6a5acd",
      slategray: "#708090",
      slategrey: "#708090",
      snow: "#fffafa",
      springgreen: "#00ff7f",
      steelblue: "#4682b4",
      tan: "#d2b48c",
      thistle: "#d8bfd8",
      tomato: "#ff6347",
      turquoise: "#40e0d0",
      violet: "#ee82ee",
      wheat: "#f5deb3",
      whitesmoke: "#f5f5f5",
      yellowgreen: "#9acd32",
      rebeccapurple: "#663399"
    };
  }
});

// node_modules/.pnpm/css-color-keywords@1.0.0/node_modules/css-color-keywords/index.js
var require_css_color_keywords = __commonJS({
  "node_modules/.pnpm/css-color-keywords@1.0.0/node_modules/css-color-keywords/index.js"(exports2, module) {
    "use strict";
    module.exports = require_colors();
  }
});

// node_modules/.pnpm/css-to-react-native@3.2.0/node_modules/css-to-react-native/index.js
var require_css_to_react_native = __commonJS({
  "node_modules/.pnpm/css-to-react-native@3.2.0/node_modules/css-to-react-native/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", {
      value: true
    });
    function _interopDefault(ex) {
      return ex && typeof ex === "object" && "default" in ex ? ex["default"] : ex;
    }
    var parse2 = require_lib();
    var parse__default = _interopDefault(parse2);
    var camelizeStyleName = _interopDefault(require_camelize());
    var cssColorKeywords = _interopDefault(require_css_color_keywords());
    var matchString = function matchString2(node) {
      if (node.type !== "string")
        return null;
      return node.value.replace(/\\([0-9a-f]{1,6})(?:\s|$)/gi, function(match, charCode) {
        return String.fromCharCode(parseInt(charCode, 16));
      }).replace(/\\/g, "");
    };
    var hexColorRe = /^(#(?:[0-9a-f]{3,4}){1,2})$/i;
    var cssFunctionNameRe = /^(rgba?|hsla?|hwb|lab|lch|gray|color)$/;
    var matchColor = function matchColor2(node) {
      if (node.type === "word" && (hexColorRe.test(node.value) || node.value in cssColorKeywords || node.value === "transparent")) {
        return node.value;
      } else if (node.type === "function" && cssFunctionNameRe.test(node.value)) {
        return parse2.stringify(node);
      }
      return null;
    };
    var noneRe = /^(none)$/i;
    var autoRe = /^(auto)$/i;
    var identRe = /(^-?[_a-z][_a-z0-9-]*$)/i;
    var numberRe = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)$/i;
    var lengthRe = /^(0$|(?:[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(?=px$))/i;
    var unsupportedUnitRe = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(ch|em|ex|rem|vh|vw|vmin|vmax|cm|mm|in|pc|pt))$/i;
    var angleRe = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?(?:deg|rad))$/i;
    var percentRe = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?%)$/i;
    var noopToken = function noopToken2(predicate) {
      return function(node) {
        return predicate(node) ? "<token>" : null;
      };
    };
    var valueForTypeToken = function valueForTypeToken2(type) {
      return function(node) {
        return node.type === type ? node.value : null;
      };
    };
    var regExpToken = function regExpToken2(regExp, transform2) {
      if (transform2 === void 0) {
        transform2 = String;
      }
      return function(node) {
        if (node.type !== "word")
          return null;
        var match = node.value.match(regExp);
        if (match === null)
          return null;
        var value = transform2(match[1]);
        return value;
      };
    };
    var SPACE = noopToken(function(node) {
      return node.type === "space";
    });
    var SLASH = noopToken(function(node) {
      return node.type === "div" && node.value === "/";
    });
    var COMMA = noopToken(function(node) {
      return node.type === "div" && node.value === ",";
    });
    var WORD = valueForTypeToken("word");
    var NONE = regExpToken(noneRe);
    var AUTO = regExpToken(autoRe);
    var NUMBER = regExpToken(numberRe, Number);
    var LENGTH = regExpToken(lengthRe, Number);
    var UNSUPPORTED_LENGTH_UNIT = regExpToken(unsupportedUnitRe);
    var ANGLE = regExpToken(angleRe, function(angle) {
      return angle.toLowerCase();
    });
    var PERCENT = regExpToken(percentRe);
    var IDENT = regExpToken(identRe);
    var STRING = matchString;
    var COLOR = matchColor;
    var LINE = regExpToken(/^(none|underline|line-through)$/i);
    var aspectRatio = function aspectRatio2(tokenStream) {
      var aspectRatio3 = tokenStream.expect(NUMBER);
      if (tokenStream.hasTokens()) {
        tokenStream.expect(SLASH);
        aspectRatio3 /= tokenStream.expect(NUMBER);
      }
      return {
        aspectRatio: aspectRatio3
      };
    };
    var BORDER_STYLE = regExpToken(/^(solid|dashed|dotted)$/);
    var defaultBorderWidth = 1;
    var defaultBorderColor = "black";
    var defaultBorderStyle = "solid";
    var border = function border2(tokenStream) {
      var borderWidth2;
      var borderColor2;
      var borderStyle;
      if (tokenStream.matches(NONE)) {
        tokenStream.expectEmpty();
        return {
          borderWidth: 0,
          borderColor: "black",
          borderStyle: "solid"
        };
      }
      var partsParsed = 0;
      while (partsParsed < 3 && tokenStream.hasTokens()) {
        if (partsParsed !== 0)
          tokenStream.expect(SPACE);
        if (borderWidth2 === void 0 && tokenStream.matches(LENGTH, UNSUPPORTED_LENGTH_UNIT)) {
          borderWidth2 = tokenStream.lastValue;
        } else if (borderColor2 === void 0 && tokenStream.matches(COLOR)) {
          borderColor2 = tokenStream.lastValue;
        } else if (borderStyle === void 0 && tokenStream.matches(BORDER_STYLE)) {
          borderStyle = tokenStream.lastValue;
        } else {
          tokenStream["throw"]();
        }
        partsParsed += 1;
      }
      tokenStream.expectEmpty();
      if (borderWidth2 === void 0)
        borderWidth2 = defaultBorderWidth;
      if (borderColor2 === void 0)
        borderColor2 = defaultBorderColor;
      if (borderStyle === void 0)
        borderStyle = defaultBorderStyle;
      return {
        borderWidth: borderWidth2,
        borderColor: borderColor2,
        borderStyle
      };
    };
    var directionFactory = function directionFactory2(_ref) {
      var _ref$types = _ref.types, types = _ref$types === void 0 ? [LENGTH, UNSUPPORTED_LENGTH_UNIT, PERCENT] : _ref$types, _ref$directions = _ref.directions, directions = _ref$directions === void 0 ? ["Top", "Right", "Bottom", "Left"] : _ref$directions, _ref$prefix = _ref.prefix, prefix = _ref$prefix === void 0 ? "" : _ref$prefix, _ref$suffix = _ref.suffix, suffix = _ref$suffix === void 0 ? "" : _ref$suffix;
      return function(tokenStream) {
        var _ref2;
        var values = [];
        values.push(tokenStream.expect.apply(tokenStream, types));
        while (values.length < 4 && tokenStream.hasTokens()) {
          tokenStream.expect(SPACE);
          values.push(tokenStream.expect.apply(tokenStream, types));
        }
        tokenStream.expectEmpty();
        var top = values[0], _values$ = values[1], right = _values$ === void 0 ? top : _values$, _values$2 = values[2], bottom = _values$2 === void 0 ? top : _values$2, _values$3 = values[3], left = _values$3 === void 0 ? right : _values$3;
        var keyFor = function keyFor2(n) {
          return "" + prefix + directions[n] + suffix;
        };
        return _ref2 = {}, _ref2[keyFor(0)] = top, _ref2[keyFor(1)] = right, _ref2[keyFor(2)] = bottom, _ref2[keyFor(3)] = left, _ref2;
      };
    };
    var parseShadowOffset = function parseShadowOffset2(tokenStream) {
      var width = tokenStream.expect(LENGTH);
      var height = tokenStream.matches(SPACE) ? tokenStream.expect(LENGTH) : width;
      tokenStream.expectEmpty();
      return {
        width,
        height
      };
    };
    var parseShadow = function parseShadow2(tokenStream) {
      var offsetX;
      var offsetY;
      var radius;
      var color;
      if (tokenStream.matches(NONE)) {
        tokenStream.expectEmpty();
        return {
          offset: {
            width: 0,
            height: 0
          },
          radius: 0,
          color: "black"
        };
      }
      var didParseFirst = false;
      while (tokenStream.hasTokens()) {
        if (didParseFirst)
          tokenStream.expect(SPACE);
        if (offsetX === void 0 && tokenStream.matches(LENGTH, UNSUPPORTED_LENGTH_UNIT)) {
          offsetX = tokenStream.lastValue;
          tokenStream.expect(SPACE);
          offsetY = tokenStream.expect(LENGTH, UNSUPPORTED_LENGTH_UNIT);
          tokenStream.saveRewindPoint();
          if (tokenStream.matches(SPACE) && tokenStream.matches(LENGTH, UNSUPPORTED_LENGTH_UNIT)) {
            radius = tokenStream.lastValue;
          } else {
            tokenStream.rewind();
          }
        } else if (color === void 0 && tokenStream.matches(COLOR)) {
          color = tokenStream.lastValue;
        } else {
          tokenStream["throw"]();
        }
        didParseFirst = true;
      }
      if (offsetX === void 0)
        tokenStream["throw"]();
      return {
        offset: {
          width: offsetX,
          height: offsetY
        },
        radius: radius !== void 0 ? radius : 0,
        color: color !== void 0 ? color : "black"
      };
    };
    var boxShadow = function boxShadow2(tokenStream) {
      var _parseShadow = parseShadow(tokenStream), offset = _parseShadow.offset, radius = _parseShadow.radius, color = _parseShadow.color;
      return {
        shadowOffset: offset,
        shadowRadius: radius,
        shadowColor: color,
        shadowOpacity: 1
      };
    };
    var defaultFlexGrow = 1;
    var defaultFlexShrink = 1;
    var defaultFlexBasis = 0;
    var flex = function flex2(tokenStream) {
      var flexGrow;
      var flexShrink;
      var flexBasis;
      if (tokenStream.matches(NONE)) {
        tokenStream.expectEmpty();
        return {
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: "auto"
        };
      }
      tokenStream.saveRewindPoint();
      if (tokenStream.matches(AUTO) && !tokenStream.hasTokens()) {
        return {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: "auto"
        };
      }
      tokenStream.rewind();
      var partsParsed = 0;
      while (partsParsed < 2 && tokenStream.hasTokens()) {
        if (partsParsed !== 0)
          tokenStream.expect(SPACE);
        if (flexGrow === void 0 && tokenStream.matches(NUMBER)) {
          flexGrow = tokenStream.lastValue;
          tokenStream.saveRewindPoint();
          if (tokenStream.matches(SPACE) && tokenStream.matches(NUMBER)) {
            flexShrink = tokenStream.lastValue;
          } else {
            tokenStream.rewind();
          }
        } else if (flexBasis === void 0 && tokenStream.matches(LENGTH, UNSUPPORTED_LENGTH_UNIT, PERCENT)) {
          flexBasis = tokenStream.lastValue;
        } else if (flexBasis === void 0 && tokenStream.matches(AUTO)) {
          flexBasis = "auto";
        } else {
          tokenStream["throw"]();
        }
        partsParsed += 1;
      }
      tokenStream.expectEmpty();
      if (flexGrow === void 0)
        flexGrow = defaultFlexGrow;
      if (flexShrink === void 0)
        flexShrink = defaultFlexShrink;
      if (flexBasis === void 0)
        flexBasis = defaultFlexBasis;
      return {
        flexGrow,
        flexShrink,
        flexBasis
      };
    };
    var FLEX_WRAP = regExpToken(/(nowrap|wrap|wrap-reverse)/);
    var FLEX_DIRECTION = regExpToken(/(row|row-reverse|column|column-reverse)/);
    var defaultFlexWrap = "nowrap";
    var defaultFlexDirection = "row";
    var flexFlow = function flexFlow2(tokenStream) {
      var flexWrap;
      var flexDirection;
      var partsParsed = 0;
      while (partsParsed < 2 && tokenStream.hasTokens()) {
        if (partsParsed !== 0)
          tokenStream.expect(SPACE);
        if (flexWrap === void 0 && tokenStream.matches(FLEX_WRAP)) {
          flexWrap = tokenStream.lastValue;
        } else if (flexDirection === void 0 && tokenStream.matches(FLEX_DIRECTION)) {
          flexDirection = tokenStream.lastValue;
        } else {
          tokenStream["throw"]();
        }
        partsParsed += 1;
      }
      tokenStream.expectEmpty();
      if (flexWrap === void 0)
        flexWrap = defaultFlexWrap;
      if (flexDirection === void 0)
        flexDirection = defaultFlexDirection;
      return {
        flexWrap,
        flexDirection
      };
    };
    var fontFamily = function fontFamily2(tokenStream) {
      var fontFamily3;
      if (tokenStream.matches(STRING)) {
        fontFamily3 = tokenStream.lastValue;
      } else {
        fontFamily3 = tokenStream.expect(IDENT);
        while (tokenStream.hasTokens()) {
          tokenStream.expect(SPACE);
          var nextIdent = tokenStream.expect(IDENT);
          fontFamily3 += " " + nextIdent;
        }
      }
      tokenStream.expectEmpty();
      return {
        fontFamily: fontFamily3
      };
    };
    var NORMAL = regExpToken(/^(normal)$/);
    var STYLE = regExpToken(/^(italic)$/);
    var WEIGHT = regExpToken(/^([1-9]00|bold)$/);
    var VARIANT = regExpToken(/^(small-caps)$/);
    var defaultFontStyle = "normal";
    var defaultFontWeight = "normal";
    var defaultFontVariant = [];
    var font = function font2(tokenStream) {
      var fontStyle;
      var fontWeight2;
      var fontVariant2;
      var lineHeight;
      var numStyleWeightVariantMatched = 0;
      while (numStyleWeightVariantMatched < 3 && tokenStream.hasTokens()) {
        if (tokenStream.matches(NORMAL))
          ;
        else if (fontStyle === void 0 && tokenStream.matches(STYLE)) {
          fontStyle = tokenStream.lastValue;
        } else if (fontWeight2 === void 0 && tokenStream.matches(WEIGHT)) {
          fontWeight2 = tokenStream.lastValue;
        } else if (fontVariant2 === void 0 && tokenStream.matches(VARIANT)) {
          fontVariant2 = [tokenStream.lastValue];
        } else {
          break;
        }
        tokenStream.expect(SPACE);
        numStyleWeightVariantMatched += 1;
      }
      var fontSize = tokenStream.expect(LENGTH, UNSUPPORTED_LENGTH_UNIT);
      if (tokenStream.matches(SLASH)) {
        lineHeight = tokenStream.expect(LENGTH, UNSUPPORTED_LENGTH_UNIT);
      }
      tokenStream.expect(SPACE);
      var _fontFamily = fontFamily(tokenStream), fontFamily$1 = _fontFamily.fontFamily;
      if (fontStyle === void 0)
        fontStyle = defaultFontStyle;
      if (fontWeight2 === void 0)
        fontWeight2 = defaultFontWeight;
      if (fontVariant2 === void 0)
        fontVariant2 = defaultFontVariant;
      var out = {
        fontStyle,
        fontWeight: fontWeight2,
        fontVariant: fontVariant2,
        fontSize,
        fontFamily: fontFamily$1
      };
      if (lineHeight !== void 0)
        out.lineHeight = lineHeight;
      return out;
    };
    var fontVariant = function fontVariant2(tokenStream) {
      var values = [tokenStream.expect(IDENT)];
      while (tokenStream.hasTokens()) {
        tokenStream.expect(SPACE);
        values.push(tokenStream.expect(IDENT));
      }
      return {
        fontVariant: values
      };
    };
    var ALIGN_CONTENT = regExpToken(/(flex-(?:start|end)|center|stretch|space-(?:between|around))/);
    var JUSTIFY_CONTENT = regExpToken(/(flex-(?:start|end)|center|space-(?:between|around|evenly))/);
    var placeContent = function placeContent2(tokenStream) {
      var alignContent = tokenStream.expect(ALIGN_CONTENT);
      var justifyContent;
      if (tokenStream.hasTokens()) {
        tokenStream.expect(SPACE);
        justifyContent = tokenStream.expect(JUSTIFY_CONTENT);
      } else {
        justifyContent = "stretch";
      }
      tokenStream.expectEmpty();
      return {
        alignContent,
        justifyContent
      };
    };
    var STYLE$1 = regExpToken(/^(solid|double|dotted|dashed)$/);
    var defaultTextDecorationLine = "none";
    var defaultTextDecorationStyle = "solid";
    var defaultTextDecorationColor = "black";
    var textDecoration = function textDecoration2(tokenStream) {
      var line;
      var style;
      var color;
      var didParseFirst = false;
      while (tokenStream.hasTokens()) {
        if (didParseFirst)
          tokenStream.expect(SPACE);
        if (line === void 0 && tokenStream.matches(LINE)) {
          var lines = [tokenStream.lastValue.toLowerCase()];
          tokenStream.saveRewindPoint();
          if (lines[0] !== "none" && tokenStream.matches(SPACE) && tokenStream.matches(LINE)) {
            lines.push(tokenStream.lastValue.toLowerCase());
            lines.sort().reverse();
          } else {
            tokenStream.rewind();
          }
          line = lines.join(" ");
        } else if (style === void 0 && tokenStream.matches(STYLE$1)) {
          style = tokenStream.lastValue;
        } else if (color === void 0 && tokenStream.matches(COLOR)) {
          color = tokenStream.lastValue;
        } else {
          tokenStream["throw"]();
        }
        didParseFirst = true;
      }
      return {
        textDecorationLine: line !== void 0 ? line : defaultTextDecorationLine,
        textDecorationColor: color !== void 0 ? color : defaultTextDecorationColor,
        textDecorationStyle: style !== void 0 ? style : defaultTextDecorationStyle
      };
    };
    var textDecorationLine = function textDecorationLine2(tokenStream) {
      var lines = [];
      var didParseFirst = false;
      while (tokenStream.hasTokens()) {
        if (didParseFirst)
          tokenStream.expect(SPACE);
        lines.push(tokenStream.expect(LINE).toLowerCase());
        didParseFirst = true;
      }
      lines.sort().reverse();
      return {
        textDecorationLine: lines.join(" ")
      };
    };
    var textShadow = function textShadow2(tokenStream) {
      var _parseShadow2 = parseShadow(tokenStream), offset = _parseShadow2.offset, radius = _parseShadow2.radius, color = _parseShadow2.color;
      return {
        textShadowOffset: offset,
        textShadowRadius: radius,
        textShadowColor: color
      };
    };
    var oneOfType = function oneOfType2(tokenType) {
      return function(functionStream) {
        var value = functionStream.expect(tokenType);
        functionStream.expectEmpty();
        return value;
      };
    };
    var singleNumber = oneOfType(NUMBER);
    var singleLength = oneOfType(LENGTH);
    var singleAngle = oneOfType(ANGLE);
    var xyTransformFactory = function xyTransformFactory2(tokenType) {
      return function(key, valueIfOmitted) {
        return function(functionStream) {
          var _ref3, _ref4;
          var x2 = functionStream.expect(tokenType);
          var y;
          if (functionStream.hasTokens()) {
            functionStream.expect(COMMA);
            y = functionStream.expect(tokenType);
          } else if (valueIfOmitted !== void 0) {
            y = valueIfOmitted;
          } else {
            return x2;
          }
          functionStream.expectEmpty();
          return [(_ref3 = {}, _ref3[key + "Y"] = y, _ref3), (_ref4 = {}, _ref4[key + "X"] = x2, _ref4)];
        };
      };
    };
    var xyNumber = xyTransformFactory(NUMBER);
    var xyLength = xyTransformFactory(LENGTH);
    var xyAngle = xyTransformFactory(ANGLE);
    var partTransforms = {
      perspective: singleNumber,
      scale: xyNumber("scale"),
      scaleX: singleNumber,
      scaleY: singleNumber,
      translate: xyLength("translate", 0),
      translateX: singleLength,
      translateY: singleLength,
      rotate: singleAngle,
      rotateX: singleAngle,
      rotateY: singleAngle,
      rotateZ: singleAngle,
      skewX: singleAngle,
      skewY: singleAngle,
      skew: xyAngle("skew", "0deg")
    };
    var transform = function transform2(tokenStream) {
      var transforms2 = [];
      var didParseFirst = false;
      while (tokenStream.hasTokens()) {
        if (didParseFirst)
          tokenStream.expect(SPACE);
        var functionStream = tokenStream.expectFunction();
        var functionName = functionStream.functionName;
        var transformedValues = partTransforms[functionName](functionStream);
        if (!Array.isArray(transformedValues)) {
          var _ref5;
          transformedValues = [(_ref5 = {}, _ref5[functionName] = transformedValues, _ref5)];
        }
        transforms2 = transformedValues.concat(transforms2);
        didParseFirst = true;
      }
      return {
        transform: transforms2
      };
    };
    var background = function background2(tokenStream) {
      return {
        backgroundColor: tokenStream.expect(COLOR)
      };
    };
    var borderColor = directionFactory({
      types: [COLOR],
      prefix: "border",
      suffix: "Color"
    });
    var borderRadius = directionFactory({
      directions: ["TopLeft", "TopRight", "BottomRight", "BottomLeft"],
      prefix: "border",
      suffix: "Radius"
    });
    var borderWidth = directionFactory({
      prefix: "border",
      suffix: "Width"
    });
    var margin = directionFactory({
      types: [LENGTH, UNSUPPORTED_LENGTH_UNIT, PERCENT, AUTO],
      prefix: "margin"
    });
    var padding = directionFactory({
      prefix: "padding"
    });
    var fontWeight = function fontWeight2(tokenStream) {
      return {
        fontWeight: tokenStream.expect(WORD)
        // Also match numbers as strings
      };
    };
    var shadowOffset = function shadowOffset2(tokenStream) {
      return {
        shadowOffset: parseShadowOffset(tokenStream)
      };
    };
    var textShadowOffset = function textShadowOffset2(tokenStream) {
      return {
        textShadowOffset: parseShadowOffset(tokenStream)
      };
    };
    var transforms = {
      aspectRatio,
      background,
      border,
      borderColor,
      borderRadius,
      borderWidth,
      boxShadow,
      flex,
      flexFlow,
      font,
      fontFamily,
      fontVariant,
      fontWeight,
      margin,
      padding,
      placeContent,
      shadowOffset,
      textShadow,
      textShadowOffset,
      textDecoration,
      textDecorationLine,
      transform
    };
    var propertiesWithoutUnits;
    if (process.env.NODE_ENV !== "production") {
      propertiesWithoutUnits = ["aspectRatio", "elevation", "flexGrow", "flexShrink", "opacity", "shadowOpacity", "zIndex"];
    }
    var devPropertiesWithUnitsRegExp = propertiesWithoutUnits != null ? new RegExp(propertiesWithoutUnits.join("|")) : null;
    var SYMBOL_MATCH = "SYMBOL_MATCH";
    var TokenStream = /* @__PURE__ */ function() {
      function TokenStream2(nodes, parent) {
        this.index = 0;
        this.nodes = nodes;
        this.functionName = parent != null ? parent.value : null;
        this.lastValue = null;
        this.rewindIndex = -1;
      }
      var _proto = TokenStream2.prototype;
      _proto.hasTokens = function hasTokens() {
        return this.index <= this.nodes.length - 1;
      };
      _proto[SYMBOL_MATCH] = function() {
        if (!this.hasTokens())
          return null;
        var node = this.nodes[this.index];
        for (var i = 0; i < arguments.length; i += 1) {
          var tokenDescriptor = i < 0 || arguments.length <= i ? void 0 : arguments[i];
          var value = tokenDescriptor(node);
          if (value !== null) {
            this.index += 1;
            this.lastValue = value;
            return value;
          }
        }
        return null;
      };
      _proto.matches = function matches() {
        return this[SYMBOL_MATCH].apply(this, arguments) !== null;
      };
      _proto.expect = function expect() {
        var value = this[SYMBOL_MATCH].apply(this, arguments);
        return value !== null ? value : this["throw"]();
      };
      _proto.matchesFunction = function matchesFunction() {
        var node = this.nodes[this.index];
        if (node.type !== "function")
          return null;
        var value = new TokenStream2(node.nodes, node);
        this.index += 1;
        this.lastValue = null;
        return value;
      };
      _proto.expectFunction = function expectFunction() {
        var value = this.matchesFunction();
        return value !== null ? value : this["throw"]();
      };
      _proto.expectEmpty = function expectEmpty() {
        if (this.hasTokens())
          this["throw"]();
      };
      _proto["throw"] = function _throw() {
        throw new Error("Unexpected token type: " + this.nodes[this.index].type);
      };
      _proto.saveRewindPoint = function saveRewindPoint() {
        this.rewindIndex = this.index;
      };
      _proto.rewind = function rewind() {
        if (this.rewindIndex === -1)
          throw new Error("Internal error");
        this.index = this.rewindIndex;
        this.lastValue = null;
      };
      return TokenStream2;
    }();
    var numberOrLengthRe = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(?:px)?$/i;
    var numberOnlyRe = /^[+-]?(?:\d*\.\d*|[1-9]\d*)(?:e[+-]?\d+)?$/i;
    var boolRe = /^true|false$/i;
    var nullRe = /^null$/i;
    var undefinedRe = /^undefined$/i;
    var transformRawValue = function transformRawValue2(propName, value) {
      if (process.env.NODE_ENV !== "production") {
        var needsUnit = !devPropertiesWithUnitsRegExp.test(propName);
        var isNumberWithoutUnit = numberOnlyRe.test(value);
        if (needsUnit && isNumberWithoutUnit) {
          console.warn('Expected style "' + propName + ": " + value + '" to contain units');
        }
        if (!needsUnit && value !== "0" && !isNumberWithoutUnit) {
          console.warn('Expected style "' + propName + ": " + value + '" to be unitless');
        }
      }
      var numberMatch = value.match(numberOrLengthRe);
      if (numberMatch !== null)
        return Number(numberMatch[1]);
      var boolMatch = value.match(boolRe);
      if (boolMatch !== null)
        return boolMatch[0].toLowerCase() === "true";
      var nullMatch = value.match(nullRe);
      if (nullMatch !== null)
        return null;
      var undefinedMatch = value.match(undefinedRe);
      if (undefinedMatch !== null)
        return void 0;
      return value;
    };
    var baseTransformShorthandValue = function baseTransformShorthandValue2(propName, value) {
      var ast = parse__default(value);
      var tokenStream = new TokenStream(ast.nodes);
      return transforms[propName](tokenStream);
    };
    var transformShorthandValue = process.env.NODE_ENV === "production" ? baseTransformShorthandValue : function(propName, value) {
      try {
        return baseTransformShorthandValue(propName, value);
      } catch (e) {
        throw new Error('Failed to parse declaration "' + propName + ": " + value + '"');
      }
    };
    var getStylesForProperty = function getStylesForProperty2(propName, inputValue, allowShorthand) {
      var _ref6;
      var isRawValue = allowShorthand === false || !(propName in transforms);
      var value = inputValue.trim();
      var propValues = isRawValue ? (_ref6 = {}, _ref6[propName] = transformRawValue(propName, value), _ref6) : transformShorthandValue(propName, value);
      return propValues;
    };
    var getPropertyName = function getPropertyName2(propName) {
      var isCustomProp = /^--\w+/.test(propName);
      if (isCustomProp) {
        return propName;
      }
      return camelizeStyleName(propName);
    };
    var index = function index2(rules, shorthandBlacklist) {
      if (shorthandBlacklist === void 0) {
        shorthandBlacklist = [];
      }
      return rules.reduce(function(accum, rule) {
        var propertyName = getPropertyName(rule[0]);
        var value = rule[1];
        var allowShorthand = shorthandBlacklist.indexOf(propertyName) === -1;
        return Object.assign(accum, getStylesForProperty(propertyName, value, allowShorthand));
      }, {});
    };
    exports2["default"] = index;
    exports2.getPropertyName = getPropertyName;
    exports2.getStylesForProperty = getStylesForProperty;
    exports2.transformRawValue = transformRawValue;
  }
});

// node_modules/.pnpm/css-background-parser@0.1.0/node_modules/css-background-parser/index.js
var require_css_background_parser = __commonJS({
  "node_modules/.pnpm/css-background-parser@0.1.0/node_modules/css-background-parser/index.js"(exports2, module) {
    (function(exports3) {
      function BackgroundList(backgrounds) {
        if (!(this instanceof BackgroundList)) {
          return new BackgroundList();
        }
        this.backgrounds = backgrounds || [];
      }
      BackgroundList.prototype.toString = function() {
        return this.backgrounds.join(", ");
      };
      function Background(props) {
        if (!(this instanceof Background)) {
          return new Background(props);
        }
        props = props || {};
        var bg = this;
        function defprop(name, defaultValue) {
          bg[name] = name in props ? props[name] : defaultValue;
        }
        defprop("color", "");
        defprop("image", "none");
        defprop("attachment", "scroll");
        defprop("clip", "border-box");
        defprop("origin", "padding-box");
        defprop("position", "0% 0%");
        defprop("repeat", "repeat");
        defprop("size", "auto");
      }
      Background.prototype.toString = function() {
        var list = [
          this.image,
          this.repeat,
          this.attachment,
          this.position + " / " + this.size,
          this.origin,
          this.clip
        ];
        if (this.color) {
          list.unshift(this.color);
        }
        return list.join(" ");
      };
      exports3.BackgroundList = BackgroundList;
      exports3.Background = Background;
      function parseImages(cssText) {
        var images = [];
        var tokens = /[,\(\)]/;
        var parens = 0;
        var buffer = "";
        if (cssText == null) {
          return images;
        }
        while (cssText.length) {
          var match = tokens.exec(cssText);
          if (!match) {
            break;
          }
          var char = match[0];
          var ignoreChar = false;
          switch (char) {
            case ",":
              if (!parens) {
                images.push(buffer.trim());
                buffer = "";
                ignoreChar = true;
              }
              break;
            case "(":
              parens++;
              break;
            case ")":
              parens--;
              break;
          }
          var index = match.index + 1;
          buffer += cssText.slice(0, ignoreChar ? index - 1 : index);
          cssText = cssText.slice(index);
        }
        if (buffer.length || cssText.length) {
          images.push((buffer + cssText).trim());
        }
        return images;
      }
      function trim(str) {
        return str.trim();
      }
      function parseSimpleList(cssText) {
        return (cssText || "").split(",").map(trim);
      }
      exports3.parseElementStyle = function(styleObject) {
        var list = new BackgroundList();
        if (styleObject == null) {
          return list;
        }
        var bgImage = parseImages(styleObject.backgroundImage);
        var bgColor = styleObject.backgroundColor;
        var bgAttachment = parseSimpleList(styleObject.backgroundAttachment);
        var bgClip = parseSimpleList(styleObject.backgroundClip);
        var bgOrigin = parseSimpleList(styleObject.backgroundOrigin);
        var bgPosition = parseSimpleList(styleObject.backgroundPosition);
        var bgRepeat = parseSimpleList(styleObject.backgroundRepeat);
        var bgSize = parseSimpleList(styleObject.backgroundSize);
        var background;
        for (var i = 0, ii2 = bgImage.length; i < ii2; i++) {
          background = new Background({
            image: bgImage[i],
            attachment: bgAttachment[i % bgAttachment.length],
            clip: bgClip[i % bgClip.length],
            origin: bgOrigin[i % bgOrigin.length],
            position: bgPosition[i % bgPosition.length],
            repeat: bgRepeat[i % bgRepeat.length],
            size: bgSize[i % bgSize.length]
          });
          if (i === ii2 - 1) {
            background.color = bgColor;
          }
          list.backgrounds.push(background);
        }
        return list;
      };
    })(function(root) {
      if (typeof module !== "undefined" && module.exports !== void 0)
        return module.exports;
      return root.cssBgParser = {};
    }(exports2));
  }
});

// node_modules/.pnpm/css-box-shadow@1.0.0-3/node_modules/css-box-shadow/index.js
var require_css_box_shadow = __commonJS({
  "node_modules/.pnpm/css-box-shadow@1.0.0-3/node_modules/css-box-shadow/index.js"(exports2, module) {
    var VALUES_REG = /,(?![^\(]*\))/;
    var PARTS_REG = /\s(?![^(]*\))/;
    var LENGTH_REG = /^[0-9]+[a-zA-Z%]+?$/;
    var parseValue = (str) => {
      const parts = str.split(PARTS_REG);
      const inset = parts.includes("inset");
      const last = parts.slice(-1)[0];
      const color = !isLength(last) ? last : void 0;
      const nums = parts.filter((n) => n !== "inset").filter((n) => n !== color).map(toNum);
      const [offsetX, offsetY, blurRadius, spreadRadius] = nums;
      return {
        inset,
        offsetX,
        offsetY,
        blurRadius,
        spreadRadius,
        color
      };
    };
    var stringifyValue = (obj) => {
      const {
        inset,
        offsetX = 0,
        offsetY = 0,
        blurRadius = 0,
        spreadRadius,
        color
      } = obj || {};
      return [
        inset ? "inset" : null,
        offsetX,
        offsetY,
        blurRadius,
        spreadRadius,
        color
      ].filter((v2) => v2 !== null && v2 !== void 0).map(toPx).map((s) => ("" + s).trim()).join(" ");
    };
    var isLength = (v2) => v2 === "0" || LENGTH_REG.test(v2);
    var toNum = (v2) => {
      if (!/px$/.test(v2) && v2 !== "0")
        return v2;
      const n = parseFloat(v2);
      return !isNaN(n) ? n : v2;
    };
    var toPx = (n) => typeof n === "number" && n !== 0 ? n + "px" : n;
    var parse2 = (str) => str.split(VALUES_REG).map((s) => s.trim()).map(parseValue);
    var stringify = (arr) => arr.map(stringifyValue).join(", ");
    module.exports = {
      parse: parse2,
      stringify
    };
  }
});

// node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/index.js
var require_color_name = __commonJS({
  "node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/index.js"(exports2, module) {
    "use strict";
    module.exports = {
      "aliceblue": [240, 248, 255],
      "antiquewhite": [250, 235, 215],
      "aqua": [0, 255, 255],
      "aquamarine": [127, 255, 212],
      "azure": [240, 255, 255],
      "beige": [245, 245, 220],
      "bisque": [255, 228, 196],
      "black": [0, 0, 0],
      "blanchedalmond": [255, 235, 205],
      "blue": [0, 0, 255],
      "blueviolet": [138, 43, 226],
      "brown": [165, 42, 42],
      "burlywood": [222, 184, 135],
      "cadetblue": [95, 158, 160],
      "chartreuse": [127, 255, 0],
      "chocolate": [210, 105, 30],
      "coral": [255, 127, 80],
      "cornflowerblue": [100, 149, 237],
      "cornsilk": [255, 248, 220],
      "crimson": [220, 20, 60],
      "cyan": [0, 255, 255],
      "darkblue": [0, 0, 139],
      "darkcyan": [0, 139, 139],
      "darkgoldenrod": [184, 134, 11],
      "darkgray": [169, 169, 169],
      "darkgreen": [0, 100, 0],
      "darkgrey": [169, 169, 169],
      "darkkhaki": [189, 183, 107],
      "darkmagenta": [139, 0, 139],
      "darkolivegreen": [85, 107, 47],
      "darkorange": [255, 140, 0],
      "darkorchid": [153, 50, 204],
      "darkred": [139, 0, 0],
      "darksalmon": [233, 150, 122],
      "darkseagreen": [143, 188, 143],
      "darkslateblue": [72, 61, 139],
      "darkslategray": [47, 79, 79],
      "darkslategrey": [47, 79, 79],
      "darkturquoise": [0, 206, 209],
      "darkviolet": [148, 0, 211],
      "deeppink": [255, 20, 147],
      "deepskyblue": [0, 191, 255],
      "dimgray": [105, 105, 105],
      "dimgrey": [105, 105, 105],
      "dodgerblue": [30, 144, 255],
      "firebrick": [178, 34, 34],
      "floralwhite": [255, 250, 240],
      "forestgreen": [34, 139, 34],
      "fuchsia": [255, 0, 255],
      "gainsboro": [220, 220, 220],
      "ghostwhite": [248, 248, 255],
      "gold": [255, 215, 0],
      "goldenrod": [218, 165, 32],
      "gray": [128, 128, 128],
      "green": [0, 128, 0],
      "greenyellow": [173, 255, 47],
      "grey": [128, 128, 128],
      "honeydew": [240, 255, 240],
      "hotpink": [255, 105, 180],
      "indianred": [205, 92, 92],
      "indigo": [75, 0, 130],
      "ivory": [255, 255, 240],
      "khaki": [240, 230, 140],
      "lavender": [230, 230, 250],
      "lavenderblush": [255, 240, 245],
      "lawngreen": [124, 252, 0],
      "lemonchiffon": [255, 250, 205],
      "lightblue": [173, 216, 230],
      "lightcoral": [240, 128, 128],
      "lightcyan": [224, 255, 255],
      "lightgoldenrodyellow": [250, 250, 210],
      "lightgray": [211, 211, 211],
      "lightgreen": [144, 238, 144],
      "lightgrey": [211, 211, 211],
      "lightpink": [255, 182, 193],
      "lightsalmon": [255, 160, 122],
      "lightseagreen": [32, 178, 170],
      "lightskyblue": [135, 206, 250],
      "lightslategray": [119, 136, 153],
      "lightslategrey": [119, 136, 153],
      "lightsteelblue": [176, 196, 222],
      "lightyellow": [255, 255, 224],
      "lime": [0, 255, 0],
      "limegreen": [50, 205, 50],
      "linen": [250, 240, 230],
      "magenta": [255, 0, 255],
      "maroon": [128, 0, 0],
      "mediumaquamarine": [102, 205, 170],
      "mediumblue": [0, 0, 205],
      "mediumorchid": [186, 85, 211],
      "mediumpurple": [147, 112, 219],
      "mediumseagreen": [60, 179, 113],
      "mediumslateblue": [123, 104, 238],
      "mediumspringgreen": [0, 250, 154],
      "mediumturquoise": [72, 209, 204],
      "mediumvioletred": [199, 21, 133],
      "midnightblue": [25, 25, 112],
      "mintcream": [245, 255, 250],
      "mistyrose": [255, 228, 225],
      "moccasin": [255, 228, 181],
      "navajowhite": [255, 222, 173],
      "navy": [0, 0, 128],
      "oldlace": [253, 245, 230],
      "olive": [128, 128, 0],
      "olivedrab": [107, 142, 35],
      "orange": [255, 165, 0],
      "orangered": [255, 69, 0],
      "orchid": [218, 112, 214],
      "palegoldenrod": [238, 232, 170],
      "palegreen": [152, 251, 152],
      "paleturquoise": [175, 238, 238],
      "palevioletred": [219, 112, 147],
      "papayawhip": [255, 239, 213],
      "peachpuff": [255, 218, 185],
      "peru": [205, 133, 63],
      "pink": [255, 192, 203],
      "plum": [221, 160, 221],
      "powderblue": [176, 224, 230],
      "purple": [128, 0, 128],
      "rebeccapurple": [102, 51, 153],
      "red": [255, 0, 0],
      "rosybrown": [188, 143, 143],
      "royalblue": [65, 105, 225],
      "saddlebrown": [139, 69, 19],
      "salmon": [250, 128, 114],
      "sandybrown": [244, 164, 96],
      "seagreen": [46, 139, 87],
      "seashell": [255, 245, 238],
      "sienna": [160, 82, 45],
      "silver": [192, 192, 192],
      "skyblue": [135, 206, 235],
      "slateblue": [106, 90, 205],
      "slategray": [112, 128, 144],
      "slategrey": [112, 128, 144],
      "snow": [255, 250, 250],
      "springgreen": [0, 255, 127],
      "steelblue": [70, 130, 180],
      "tan": [210, 180, 140],
      "teal": [0, 128, 128],
      "thistle": [216, 191, 216],
      "tomato": [255, 99, 71],
      "turquoise": [64, 224, 208],
      "violet": [238, 130, 238],
      "wheat": [245, 222, 179],
      "white": [255, 255, 255],
      "whitesmoke": [245, 245, 245],
      "yellow": [255, 255, 0],
      "yellowgreen": [154, 205, 50]
    };
  }
});

// node_modules/.pnpm/hex-rgb@4.3.0/node_modules/hex-rgb/index.js
var require_hex_rgb = __commonJS({
  "node_modules/.pnpm/hex-rgb@4.3.0/node_modules/hex-rgb/index.js"(exports2, module) {
    "use strict";
    var hexCharacters = "a-f\\d";
    var match3or4Hex = `#?[${hexCharacters}]{3}[${hexCharacters}]?`;
    var match6or8Hex = `#?[${hexCharacters}]{6}([${hexCharacters}]{2})?`;
    var nonHexChars = new RegExp(`[^#${hexCharacters}]`, "gi");
    var validHexSize = new RegExp(`^${match3or4Hex}$|^${match6or8Hex}$`, "i");
    module.exports = (hex, options = {}) => {
      if (typeof hex !== "string" || nonHexChars.test(hex) || !validHexSize.test(hex)) {
        throw new TypeError("Expected a valid hex string");
      }
      hex = hex.replace(/^#/, "");
      let alphaFromHex = 1;
      if (hex.length === 8) {
        alphaFromHex = Number.parseInt(hex.slice(6, 8), 16) / 255;
        hex = hex.slice(0, 6);
      }
      if (hex.length === 4) {
        alphaFromHex = Number.parseInt(hex.slice(3, 4).repeat(2), 16) / 255;
        hex = hex.slice(0, 3);
      }
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const number2 = Number.parseInt(hex, 16);
      const red = number2 >> 16;
      const green = number2 >> 8 & 255;
      const blue = number2 & 255;
      const alpha = typeof options.alpha === "number" ? options.alpha : alphaFromHex;
      if (options.format === "array") {
        return [red, green, blue, alpha];
      }
      if (options.format === "css") {
        const alphaString = alpha === 1 ? "" : ` / ${Number((alpha * 100).toFixed(2))}%`;
        return `rgb(${red} ${green} ${blue}${alphaString})`;
      }
      return { red, green, blue, alpha };
    };
  }
});

// node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/hbjs.js
var require_hbjs = __commonJS({
  "node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/hbjs.js"(exports2, module) {
    function hbjs(Module) {
      "use strict";
      var exports3 = Module.wasmExports;
      var utf8Decoder = new TextDecoder("utf8");
      var utf8Encoder = new TextEncoder("utf8");
      let addFunction = Module.addFunction;
      let removeFunction = Module.removeFunction;
      let stackSave = Module.stackSave;
      let stackRestore = Module.stackRestore;
      let stackAlloc = Module.stackAlloc;
      var freeFuncPtr = addFunction(function(ptr) {
        exports3.free(ptr);
      }, "vi");
      const TRACE_PHASE_DONT_STOP = 0;
      const TRACE_PHASE_GSUB = 1;
      const TRACE_PHASE_GPOS = 2;
      const STATIC_ARRAY_SIZE = 128;
      const HB_MEMORY_MODE_WRITABLE = 2;
      const HB_SET_VALUE_INVALID = -1;
      const HB_OT_NAME_ID_INVALID = 65535;
      const bufferContentType = {
        0: "INVALID",
        1: "UNICODE",
        2: "GLYPHS"
      };
      const bufferSerializeFlags = {
        "DEFAULT": 0,
        "NO_CLUSTERS": 1,
        "NO_POSITIONS": 2,
        "NO_GLYPH_NAMES": 4,
        "GLYPH_EXTENTS": 8,
        "GLYPH_FLAGS": 16,
        "NO_ADVANCES": 32
      };
      const bufferFlags = {
        "DEFAULT": 0,
        "BOT": 1,
        "EOT": 2,
        "PRESERVE_DEFAULT_IGNORABLES": 4,
        "REMOVE_DEFAULT_IGNORABLES": 8,
        "DO_NOT_INSERT_DOTTED_CIRCLE": 16,
        "VERIFY": 32,
        "PRODUCE_UNSAFE_TO_CONCAT": 64,
        "PRODUCE_SAFE_TO_INSERT_TATWEEL": 128
      };
      function _hb_tag(s) {
        return (s.charCodeAt(0) & 255) << 24 | (s.charCodeAt(1) & 255) << 16 | (s.charCodeAt(2) & 255) << 8 | (s.charCodeAt(3) & 255) << 0;
      }
      function _hb_untag(tag) {
        return [
          String.fromCharCode(tag >> 24 & 255),
          String.fromCharCode(tag >> 16 & 255),
          String.fromCharCode(tag >> 8 & 255),
          String.fromCharCode(tag >> 0 & 255)
        ].join("");
      }
      function _utf8_ptr_to_string(ptr, length) {
        let end;
        if (length === void 0)
          end = Module.HEAPU8.indexOf(0, ptr);
        else
          end = ptr + length;
        return utf8Decoder.decode(Module.HEAPU8.subarray(ptr, end));
      }
      function _utf16_ptr_to_string(ptr, length) {
        let end = ptr / 2 + length;
        return String.fromCharCode.apply(null, Module.HEAPU16.subarray(ptr / 2, end));
      }
      function _string_to_ascii_ptr(text) {
        const ptr = exports3.malloc(text.length + 1);
        for (let i = 0; i < text.length; ++i) {
          const char = text.charCodeAt(i);
          if (char > 127)
            throw new Error("Expected ASCII text");
          Module.HEAPU8[ptr + i] = char;
        }
        Module.HEAPU8[ptr + text.length] = 0;
        return {
          ptr,
          length: text.length,
          free: function() {
            exports3.free(ptr);
          }
        };
      }
      function _string_to_utf8_ptr(text) {
        const ptr = exports3.malloc(text.length);
        utf8Encoder.encodeInto(text, Module.HEAPU8.subarray(ptr, ptr + text.length));
        return {
          ptr,
          length: text.length,
          free: function() {
            exports3.free(ptr);
          }
        };
      }
      function _string_to_utf16_ptr(text) {
        const ptr = exports3.malloc(text.length * 2);
        const words = Module.HEAPU16.subarray(ptr / 2, ptr / 2 + text.length);
        for (let i = 0; i < words.length; ++i)
          words[i] = text.charCodeAt(i);
        return {
          ptr,
          length: words.length,
          free: function() {
            exports3.free(ptr);
          }
        };
      }
      function _language_to_string(language) {
        var ptr = exports3.hb_language_to_string(language);
        return _utf8_ptr_to_string(ptr);
      }
      function _language_from_string(str) {
        var languageStr = _string_to_ascii_ptr(str);
        var languagePtr = exports3.hb_language_from_string(languageStr.ptr, -1);
        languageStr.free();
        return languagePtr;
      }
      function createBlob(blob) {
        var blobPtr = exports3.malloc(blob.byteLength);
        Module.HEAPU8.set(new Uint8Array(blob), blobPtr);
        var ptr = exports3.hb_blob_create(blobPtr, blob.byteLength, HB_MEMORY_MODE_WRITABLE, blobPtr, freeFuncPtr);
        return {
          ptr,
          /**
          * Free the object.
          */
          destroy: function() {
            exports3.hb_blob_destroy(ptr);
          }
        };
      }
      function _typed_array_from_set(setPtr) {
        const setCount = exports3.hb_set_get_population(setPtr);
        const arrayPtr = exports3.malloc(setCount << 2);
        const arrayOffset = arrayPtr >> 2;
        const array = Module.HEAPU32.subarray(arrayOffset, arrayOffset + setCount);
        Module.HEAPU32.set(array, arrayOffset);
        exports3.hb_set_next_many(setPtr, HB_SET_VALUE_INVALID, arrayPtr, setCount);
        return array;
      }
      function createFace(blob, index) {
        var ptr = exports3.hb_face_create(blob.ptr, index);
        const upem = exports3.hb_face_get_upem(ptr);
        return {
          ptr,
          upem,
          /**
           * Return the binary contents of an OpenType table.
           * @param {string} table Table name
           */
          reference_table: function(table) {
            var blob2 = exports3.hb_face_reference_table(ptr, _hb_tag(table));
            var length = exports3.hb_blob_get_length(blob2);
            if (!length) {
              return;
            }
            var blobptr = exports3.hb_blob_get_data(blob2, null);
            var table_string = Module.HEAPU8.subarray(blobptr, blobptr + length);
            return table_string;
          },
          /**
           * Return variation axis infos
           */
          getAxisInfos: function() {
            var sp2 = stackSave();
            var axis = stackAlloc(64 * 32);
            var c2 = stackAlloc(4);
            Module.HEAPU32[c2 / 4] = 64;
            exports3.hb_ot_var_get_axis_infos(ptr, 0, c2, axis);
            var result = {};
            Array.from({ length: Module.HEAPU32[c2 / 4] }).forEach(function(_, i) {
              result[_hb_untag(Module.HEAPU32[axis / 4 + i * 8 + 1])] = {
                min: Module.HEAPF32[axis / 4 + i * 8 + 4],
                default: Module.HEAPF32[axis / 4 + i * 8 + 5],
                max: Module.HEAPF32[axis / 4 + i * 8 + 6]
              };
            });
            stackRestore(sp2);
            return result;
          },
          /**
           * Return unicodes the face supports
           */
          collectUnicodes: function() {
            var unicodeSetPtr = exports3.hb_set_create();
            exports3.hb_face_collect_unicodes(ptr, unicodeSetPtr);
            var result = _typed_array_from_set(unicodeSetPtr);
            exports3.hb_set_destroy(unicodeSetPtr);
            return result;
          },
          /**
           * Return all scripts enumerated in the specified face's
           * GSUB table or GPOS table.
           * @param {string} table: The table to query, either "GSUB" or "GPOS".
           **/
          getTableScriptTags: function(table) {
            var sp2 = stackSave();
            var tableTag = _hb_tag(table);
            var startOffset = 0;
            var scriptCount = STATIC_ARRAY_SIZE;
            var scriptCountPtr = stackAlloc(4);
            var scriptTagsPtr = stackAlloc(STATIC_ARRAY_SIZE * 4);
            var tags = [];
            while (scriptCount == STATIC_ARRAY_SIZE) {
              Module.HEAPU32[scriptCountPtr / 4] = scriptCount;
              exports3.hb_ot_layout_table_get_script_tags(
                ptr,
                tableTag,
                startOffset,
                scriptCountPtr,
                scriptTagsPtr
              );
              scriptCount = Module.HEAPU32[scriptCountPtr / 4];
              var scriptTags = Module.HEAPU32.subarray(
                scriptTagsPtr / 4,
                scriptTagsPtr / 4 + scriptCount
              );
              tags.push(...Array.from(scriptTags).map(_hb_untag));
              startOffset += scriptCount;
            }
            stackRestore(sp2);
            return tags;
          },
          /**
           * Return all features enumerated in the specified face's
           * GSUB table or GPOS table.
           * @param {string} table: The table to query, either "GSUB" or "GPOS".
           **/
          getTableFeatureTags: function(table) {
            var sp2 = stackSave();
            var tableTag = _hb_tag(table);
            var startOffset = 0;
            var featureCount = STATIC_ARRAY_SIZE;
            var featureCountPtr = stackAlloc(4);
            var featureTagsPtr = stackAlloc(STATIC_ARRAY_SIZE * 4);
            var tags = [];
            while (featureCount == STATIC_ARRAY_SIZE) {
              Module.HEAPU32[featureCountPtr / 4] = featureCount;
              exports3.hb_ot_layout_table_get_feature_tags(
                ptr,
                tableTag,
                startOffset,
                featureCountPtr,
                featureTagsPtr
              );
              featureCount = Module.HEAPU32[featureCountPtr / 4];
              var scriptTags = Module.HEAPU32.subarray(
                featureTagsPtr / 4,
                featureTagsPtr / 4 + featureCount
              );
              tags.push(...Array.from(scriptTags).map(_hb_untag));
              startOffset += featureCount;
            }
            stackRestore(sp2);
            return tags;
          },
          /**
           * Return language tags in the given face's GSUB or GPOS table, underneath
           * the specified script index.
           * @param {string} table: The table to query, either "GSUB" or "GPOS".
           * @param {number} scriptIndex: The index of the script to query.
           **/
          getScriptLanguageTags: function(table, scriptIndex) {
            var sp2 = stackSave();
            var tableTag = _hb_tag(table);
            var startOffset = 0;
            var languageCount = STATIC_ARRAY_SIZE;
            var languageCountPtr = stackAlloc(4);
            var languageTagsPtr = stackAlloc(STATIC_ARRAY_SIZE * 4);
            var tags = [];
            while (languageCount == STATIC_ARRAY_SIZE) {
              Module.HEAPU32[languageCountPtr / 4] = languageCount;
              exports3.hb_ot_layout_script_get_language_tags(
                ptr,
                tableTag,
                scriptIndex,
                startOffset,
                languageCountPtr,
                languageTagsPtr
              );
              languageCount = Module.HEAPU32[languageCountPtr / 4];
              var languageTags = Module.HEAPU32.subarray(
                languageTagsPtr / 4,
                languageTagsPtr / 4 + languageCount
              );
              tags.push(...Array.from(languageTags).map(_hb_untag));
              startOffset += languageCount;
            }
            stackRestore(sp2);
            return tags;
          },
          /**
           * Return all features in the specified face's GSUB table or GPOS table,
           * underneath the specified script and language.
           * @param {string} table: The table to query, either "GSUB" or "GPOS".
           * @param {number} scriptIndex: The index of the script to query.
           * @param {number} languageIndex: The index of the language to query.
           **/
          getLanguageFeatureTags: function(table, scriptIndex, languageIndex) {
            var sp2 = stackSave();
            var tableTag = _hb_tag(table);
            var startOffset = 0;
            var featureCount = STATIC_ARRAY_SIZE;
            var featureCountPtr = stackAlloc(4);
            var featureTagsPtr = stackAlloc(STATIC_ARRAY_SIZE * 4);
            var tags = [];
            while (featureCount == STATIC_ARRAY_SIZE) {
              Module.HEAPU32[featureCountPtr / 4] = featureCount;
              exports3.hb_ot_layout_language_get_feature_tags(
                ptr,
                tableTag,
                scriptIndex,
                languageIndex,
                startOffset,
                featureCountPtr,
                featureTagsPtr
              );
              featureCount = Module.HEAPU32[featureCountPtr / 4];
              var featureTags = Module.HEAPU32.subarray(
                featureTagsPtr / 4,
                featureTagsPtr / 4 + featureCount
              );
              tags.push(...Array.from(featureTags).map(_hb_untag));
              startOffset += featureCount;
            }
            stackRestore(sp2);
            return tags;
          },
          /**
           * Get the GDEF class of the requested glyph.
           * @param {number} glyph The glyph to get the class of.
           * @returns {string} The class of the glyph. Which can be either
           *   UNCLASSIFIED, BASE_GLYPH, LIGATURE, MARK, or COMPONENT.
           **/
          getGlyphClass: function(glyph) {
            const gclass = exports3.hb_ot_layout_get_glyph_class(ptr, glyph);
            switch (gclass) {
              case 0:
                return "UNCLASSIFIED";
              case 1:
                return "BASE_GLYPH";
              case 2:
                return "LIGATURE";
              case 3:
                return "MARK";
              case 4:
                return "COMPONENT";
            }
          },
          /**
           * Return all names in the specified face's name table.
           **/
          listNames: function() {
            var sp2 = stackSave();
            var numEntriesPtr = stackAlloc(4);
            var entriesPtr = exports3.hb_ot_name_list_names(ptr, numEntriesPtr);
            var numEntries = Module.HEAPU32[numEntriesPtr / 4];
            var entries = [];
            for (var i = 0; i < numEntries; i++) {
              entries.push({
                nameId: Module.HEAPU32[entriesPtr / 4 + i * 3],
                language: _language_to_string(Module.HEAPU32[entriesPtr / 4 + i * 3 + 2])
              });
            }
            stackRestore(sp2);
            return entries;
          },
          /**
           * Get the name of the specified face.
           * @param {number} nameId The ID of the name to get.
           * @param {string} language The language of the name to get.
           **/
          getName: function(nameId, language) {
            var sp2 = stackSave();
            var languagePtr = _language_from_string(language);
            var nameLen = exports3.hb_ot_name_get_utf16(ptr, nameId, languagePtr, 0, 0) + 1;
            var textSizePtr = stackAlloc(4);
            var textPtr = exports3.malloc(nameLen * 2);
            Module.HEAPU32[textSizePtr / 4] = nameLen;
            exports3.hb_ot_name_get_utf16(ptr, nameId, languagePtr, textSizePtr, textPtr);
            var name = _utf16_ptr_to_string(textPtr, nameLen - 1);
            exports3.free(textPtr);
            stackRestore(sp2);
            return name;
          },
          /**
           * Get the name IDs of the specified feature.
           * @param {string} table The table to query, either "GSUB" or "GPOS".
           * @param {number} featureIndex The index of the feature to query.
           **/
          getFeatureNameIds: function(table, featureIndex) {
            var sp2 = stackSave();
            var tableTag = _hb_tag(table);
            var labelIdPtr = stackAlloc(4);
            var tooltipIdPtr = stackAlloc(4);
            var sampleIdPtr = stackAlloc(4);
            var numNamedParametersPtr = stackAlloc(4);
            var firstParameterIdPtr = stackAlloc(4);
            var found = exports3.hb_ot_layout_feature_get_name_ids(
              ptr,
              tableTag,
              featureIndex,
              labelIdPtr,
              tooltipIdPtr,
              sampleIdPtr,
              numNamedParametersPtr,
              firstParameterIdPtr
            );
            var names = null;
            if (found) {
              let uiLabelNameId = Module.HEAPU32[labelIdPtr / 4];
              let uiTooltipTextNameId = Module.HEAPU32[tooltipIdPtr / 4];
              let sampleTextNameId = Module.HEAPU32[sampleIdPtr / 4];
              let numNamedParameters = Module.HEAPU32[numNamedParametersPtr / 4];
              let firstParameterId = Module.HEAPU32[firstParameterIdPtr / 4];
              let paramUiLabelNameIds = Array(numNamedParameters).fill().map((_, i) => firstParameterId + i);
              names = {
                uiLabelNameId: uiLabelNameId == HB_OT_NAME_ID_INVALID ? null : uiLabelNameId,
                uiTooltipTextNameId: uiTooltipTextNameId == HB_OT_NAME_ID_INVALID ? null : uiTooltipTextNameId,
                sampleTextNameId: sampleTextNameId == HB_OT_NAME_ID_INVALID ? null : sampleTextNameId,
                paramUiLabelNameIds
              };
            }
            stackRestore(sp2);
            return names;
          },
          /**
           * Free the object.
           */
          destroy: function() {
            exports3.hb_face_destroy(ptr);
          }
        };
      }
      var pathBuffer = "";
      function createFont(face, ptr) {
        var ptr = ptr ? exports3.hb_font_reference(ptr) : exports3.hb_font_create(face.ptr);
        var drawFuncsPtr = null;
        var moveToPtr = null;
        var lineToPtr = null;
        var cubicToPtr = null;
        var quadToPtr = null;
        var closePathPtr = null;
        function glyphToPath(glyphId) {
          if (!drawFuncsPtr) {
            var moveTo = function(dfuncs, draw_data, draw_state, to_x, to_y, user_data) {
              pathBuffer += `M${to_x},${to_y}`;
            };
            var lineTo = function(dfuncs, draw_data, draw_state, to_x, to_y, user_data) {
              pathBuffer += `L${to_x},${to_y}`;
            };
            var cubicTo = function(dfuncs, draw_data, draw_state, c1_x, c1_y, c2_x, c2_y, to_x, to_y, user_data) {
              pathBuffer += `C${c1_x},${c1_y} ${c2_x},${c2_y} ${to_x},${to_y}`;
            };
            var quadTo = function(dfuncs, draw_data, draw_state, c_x, c_y, to_x, to_y, user_data) {
              pathBuffer += `Q${c_x},${c_y} ${to_x},${to_y}`;
            };
            var closePath = function(dfuncs, draw_data, draw_state, user_data) {
              pathBuffer += "Z";
            };
            moveToPtr = addFunction(moveTo, "viiiffi");
            lineToPtr = addFunction(lineTo, "viiiffi");
            cubicToPtr = addFunction(cubicTo, "viiiffffffi");
            quadToPtr = addFunction(quadTo, "viiiffffi");
            closePathPtr = addFunction(closePath, "viiii");
            drawFuncsPtr = exports3.hb_draw_funcs_create();
            exports3.hb_draw_funcs_set_move_to_func(drawFuncsPtr, moveToPtr, 0, 0);
            exports3.hb_draw_funcs_set_line_to_func(drawFuncsPtr, lineToPtr, 0, 0);
            exports3.hb_draw_funcs_set_cubic_to_func(drawFuncsPtr, cubicToPtr, 0, 0);
            exports3.hb_draw_funcs_set_quadratic_to_func(drawFuncsPtr, quadToPtr, 0, 0);
            exports3.hb_draw_funcs_set_close_path_func(drawFuncsPtr, closePathPtr, 0, 0);
          }
          pathBuffer = "";
          exports3.hb_font_draw_glyph(ptr, glyphId, drawFuncsPtr, 0);
          return pathBuffer;
        }
        function glyphName(glyphId) {
          var sp2 = stackSave();
          var strSize = 256;
          var strPtr = stackAlloc(strSize);
          exports3.hb_font_glyph_to_string(ptr, glyphId, strPtr, strSize);
          var name = _utf8_ptr_to_string(strPtr);
          stackRestore(sp2);
          return name;
        }
        return {
          ptr,
          /**
           * Create a sub font.
           * @returns {object} Object representing the sub font.
           **/
          subFont: function() {
            return createFont(null, exports3.hb_font_create_sub_font(ptr));
          },
          /**
           * Return font horizontal extents.
           * @returns {object} Object with ascender, descender, and lineGap properties.
           **/
          hExtents: function() {
            var sp2 = stackSave();
            var extentsPtr = stackAlloc(12);
            exports3.hb_font_get_h_extents(ptr, extentsPtr);
            var extents = {
              ascender: Module.HEAP32[extentsPtr / 4],
              descender: Module.HEAP32[extentsPtr / 4 + 1],
              lineGap: Module.HEAP32[extentsPtr / 4 + 2]
            };
            stackRestore(sp2);
            return extents;
          },
          /**
           * Return font vertical extents.
           * @returns {object} Object with ascender, descender, and lineGap properties.
           **/
          vExtents: function() {
            var sp2 = stackSave();
            var extentsPtr = stackAlloc(12);
            exports3.hb_font_get_v_extents(ptr, extentsPtr);
            var extents = {
              ascender: Module.HEAP32[extentsPtr / 4],
              descender: Module.HEAP32[extentsPtr / 4 + 1],
              lineGap: Module.HEAP32[extentsPtr / 4 + 2]
            };
            stackRestore(sp2);
            return extents;
          },
          glyphName,
          glyphToPath,
          /**
           * Return glyph horizontal advance.
           * @param {number} glyphId ID of the requested glyph in the font.
           **/
          glyphHAdvance: function(glyphId) {
            return exports3.hb_font_get_glyph_h_advance(ptr, glyphId);
          },
          /**
           * Return glyph vertical advance.
           * @param {number} glyphId ID of the requested glyph in the font.
           **/
          glyphVAdvance: function(glyphId) {
            return exports3.hb_font_get_glyph_v_advance(ptr, glyphId);
          },
          /**
           * Return glyph horizontal origin.
           * @param {number} glyphId ID of the requested glyph in the font.
           **/
          glyphHOrigin: function(glyphId) {
            var sp2 = stackSave();
            let xPtr = stackAlloc(4);
            let yPtr = stackAlloc(4);
            let origin = null;
            if (exports3.hb_font_get_glyph_h_origin(ptr, glyphId, xPtr, yPtr)) {
              origin = [Module.HEAP32[xPtr / 4], Module.HEAP32[yPtr / 4]];
            }
            stackRestore(sp2);
            return origin;
          },
          /**
           * Return glyph vertical origin.
           * @param {number} glyphId ID of the requested glyph in the font.
           **/
          glyphVOrigin: function(glyphId) {
            var sp2 = stackSave();
            let xPtr = stackAlloc(4);
            let yPtr = stackAlloc(4);
            let origin = null;
            if (exports3.hb_font_get_glyph_v_origin(ptr, glyphId, xPtr, yPtr)) {
              origin = [Module.HEAP32[xPtr / 4], Module.HEAP32[yPtr / 4]];
            }
            stackRestore(sp2);
            return origin;
          },
          /**
           * Return glyph extents.
           * @param {number} glyphId ID of the requested glyph in the font.
           **/
          glyphExtents: function(glyphId) {
            var sp2 = stackSave();
            var extentsPtr = stackAlloc(16);
            var extents = null;
            if (exports3.hb_font_get_glyph_extents(ptr, glyphId, extentsPtr)) {
              extents = {
                xBearing: Module.HEAP32[extentsPtr / 4],
                yBearing: Module.HEAP32[extentsPtr / 4 + 1],
                width: Module.HEAP32[extentsPtr / 4 + 2],
                height: Module.HEAP32[extentsPtr / 4 + 3]
              };
            }
            stackRestore(sp2);
            return extents;
          },
          /**
           * Return glyph ID from name.
           * @param {string} name Name of the requested glyph in the font.
           **/
          glyphFromName: function(name) {
            var sp2 = stackSave();
            var glyphIdPtr = stackAlloc(4);
            var namePtr = _string_to_utf8_ptr(name);
            var glyphId = null;
            if (exports3.hb_font_get_glyph_from_name(ptr, namePtr.ptr, namePtr.length, glyphIdPtr)) {
              glyphId = Module.HEAPU32[glyphIdPtr / 4];
            }
            namePtr.free();
            stackRestore(sp2);
            return glyphId;
          },
          /**
          * Return a glyph as a JSON path string
          * based on format described on https://svgwg.org/specs/paths/#InterfaceSVGPathSegment
          * @param {number} glyphId ID of the requested glyph in the font.
          **/
          glyphToJson: function(glyphId) {
            var path = glyphToPath(glyphId);
            return path.replace(/([MLQCZ])/g, "|$1 ").split("|").filter(function(x2) {
              return x2.length;
            }).map(function(x2) {
              var row = x2.split(/[ ,]/g);
              return { type: row[0], values: row.slice(1).filter(function(x3) {
                return x3.length;
              }).map(function(x3) {
                return +x3;
              }) };
            });
          },
          /**
          * Set the font's scale factor, affecting the position values returned from
          * shaping.
          * @param {number} xScale Units to scale in the X dimension.
          * @param {number} yScale Units to scale in the Y dimension.
          **/
          setScale: function(xScale, yScale) {
            exports3.hb_font_set_scale(ptr, xScale, yScale);
          },
          /**
           * Set the font's variations.
           * @param {object} variations Dictionary of variations to set
           **/
          setVariations: function(variations) {
            var entries = Object.entries(variations);
            var vars = exports3.malloc(8 * entries.length);
            entries.forEach(function(entry, i) {
              Module.HEAPU32[vars / 4 + i * 2 + 0] = _hb_tag(entry[0]);
              Module.HEAPF32[vars / 4 + i * 2 + 1] = entry[1];
            });
            exports3.hb_font_set_variations(ptr, vars, entries.length);
            exports3.free(vars);
          },
          /**
          * Set the font's font functions.
          * @param {object} fontFuncs The font functions.
          **/
          setFuncs: function(fontFuncs) {
            exports3.hb_font_set_funcs(ptr, fontFuncs.ptr);
          },
          /**
          * Free the object.
          */
          destroy: function() {
            exports3.hb_font_destroy(ptr);
            if (drawFuncsPtr) {
              exports3.hb_draw_funcs_destroy(drawFuncsPtr);
              drawFuncsPtr = null;
              removeFunction(moveToPtr);
              removeFunction(lineToPtr);
              removeFunction(cubicToPtr);
              removeFunction(quadToPtr);
              removeFunction(closePathPtr);
            }
          }
        };
      }
      function createFontFuncs() {
        var ptr = exports3.hb_font_funcs_create();
        return {
          ptr,
          /**
          * Set the font's glyph extents function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return an object with the following properties, or null on failure:
          * @param {number} xBearing The x bearing of the glyph.
          * @param {number} yBearing The y bearing of the glyph.
          * @param {number} width The width of the glyph.
          * @param {number} height The height of the glyph.
          **/
          setGlyphExtentsFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, extentsPtr, user_data) {
              let font = createFont(null, fontPtr);
              let extents = func(font, glyph);
              font.destroy();
              if (extents) {
                Module.HEAP32[extentsPtr / 4] = extents.xBearing;
                Module.HEAP32[extentsPtr / 4 + 1] = extents.yBearing;
                Module.HEAP32[extentsPtr / 4 + 2] = extents.width;
                Module.HEAP32[extentsPtr / 4 + 3] = extents.height;
                return 1;
              }
              return 0;
            }, "ippipp");
            exports3.hb_font_funcs_set_glyph_extents_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph from name function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {string} name The glyph name.
          *
          * The function should return an object with the following properties, or null on failure:
          * @param {number} glyph The glyph ID.
          **/
          setGlyphFromNameFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, namePtr, len, glyphPtr, user_data) {
              let font = createFont(null, fontPtr);
              let name = _utf8_ptr_to_string(namePtr, len);
              let glyph = func(font, name);
              font.destroy();
              if (glyph) {
                Module.HEAPU32[glyphPtr / 4] = glyph;
                return 1;
              }
              return 0;
            }, "ipppipp");
            exports3.hb_font_funcs_set_glyph_from_name_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph horizontal advance function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return the horizontal advance of the glyph.
          **/
          setGlyphHAdvanceFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, user_data) {
              let font = createFont(null, fontPtr);
              let advance = func(font, glyph);
              font.destroy();
              return advance;
            }, "ippip");
            exports3.hb_font_funcs_set_glyph_h_advance_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph vertical advance function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return the vertical advance of the glyph.
          **/
          setGlyphVAdvanceFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, user_data) {
              let font = createFont(null, fontPtr);
              let advance = func(font, glyph);
              font.destroy();
              return advance;
            }, "ippip");
            exports3.hb_font_funcs_set_glyph_v_advance_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph horizontal origin function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return the x and y horizontal origin of the glyph, or null on failure.
          **/
          setGlyphHOriginFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, xPtr, yPtr, user_data) {
              let font = createFont(null, fontPtr);
              let origin = func(font, glyph);
              font.destroy();
              if (origin) {
                Module.HEAP32[xPtr / 4] = origin[0];
                Module.HEAP32[yPtr / 4] = origin[1];
                return 1;
              }
              return 0;
            }, "ippippp");
            exports3.hb_font_funcs_set_glyph_h_origin_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph vertical origin function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return the x and y vertical origin of the glyph, or null on failure.
          **/
          setGlyphVOriginFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, xPtr, yPtr, user_data) {
              let font = createFont(null, fontPtr);
              let origin = func(font, glyph);
              font.destroy();
              if (origin) {
                Module.HEAP32[xPtr / 4] = origin[0];
                Module.HEAP32[yPtr / 4] = origin[1];
                return 1;
              }
              return 0;
            }, "ippippp");
            exports3.hb_font_funcs_set_glyph_v_origin_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph horizontal kerning function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} firstGlyph The first glyph ID.
          * @param {number} secondGlyph The second glyph ID.
          *
          * The function should return the horizontal kerning of the glyphs.
          **/
          setGlyphHKerningFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, firstGlyph, secondGlyph, user_data) {
              let font = createFont(null, fontPtr);
              let kerning = func(font, firstGlyph, secondGlyph);
              font.destroy();
              return kerning;
            }, "ippiip");
            exports3.hb_font_funcs_set_glyph_h_kerning_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's glyph name function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} glyph The glyph ID.
          *
          * The function should return the name of the glyph, or null on failure.
          **/
          setGlyphNameFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, glyph, namePtr, size, user_data) {
              let font = createFont(null, fontPtr);
              let name = func(font, glyph);
              font.destroy();
              if (name) {
                utf8Encoder.encodeInto(name, Module.HEAPU8.subarray(namePtr, namePtr + size));
                return 1;
              }
              return 0;
            }, "ippipip");
            exports3.hb_font_funcs_set_glyph_name_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's nominal glyph function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} unicode The unicode.
          *
          * The function should return the nominal glyph of the unicode, or null on failure.
          **/
          setNominalGlyphFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, unicode, glyphPtr, user_data) {
              let font = createFont(null, fontPtr);
              let glyph = func(font, unicode);
              font.destroy();
              if (glyph) {
                Module.HEAPU32[glyphPtr / 4] = glyph;
                return 1;
              }
              return 0;
            }, "ippipp");
            exports3.hb_font_funcs_set_nominal_glyph_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's variation glyph function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          * @param {number} unicode The unicode.
          * @param {number} variationSelector The variation selector.
          *
          * The function should return the variation glyph of the unicode, or null on failure.
          **/
          setVariationGlyphFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, unicode, variationSelector, glyphPtr, user_data) {
              let font = createFont(null, fontPtr);
              let glyph = func(font, unicode, variationSelector);
              font.destroy();
              if (glyph) {
                Module.HEAPU32[glyphPtr / 4] = glyph;
                return 1;
              }
              return 0;
            }, "ippiipp");
            exports3.hb_font_funcs_set_variation_glyph_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's horizontal extents function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          *
          * The function should return an object with the following properties, or null on failure:
          * @param {number} ascender The ascender of the font.
          * @param {number} descender The descender of the font.
          * @param {number} lineGap The line gap of the font.
          **/
          setFontHExtentsFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, extentsPtr, user_data) {
              let font = createFont(null, fontPtr);
              let extents = func(font);
              font.destroy();
              if (extents) {
                Module.HEAP32[extentsPtr / 4] = extents.ascender;
                Module.HEAP32[extentsPtr / 4 + 1] = extents.descender;
                Module.HEAP32[extentsPtr / 4 + 2] = extents.lineGap;
                return 1;
              }
              return 0;
            }, "ipppp");
            exports3.hb_font_funcs_set_font_h_extents_func(ptr, funcPtr, 0, 0);
          },
          /**
          * Set the font's vertical extents function.
          * @param {function} func The function to set.
          *
          * The function takes the following arguments:
          * @param {object} font The font.
          *
          * The function should return an object with the following properties, or null on failure:
          * @param {number} ascender The ascender of the font.
          * @param {number} descender The descender of the font.
          * @param {number} lineGap The line gap of the font.
          **/
          setFontVExtentsFunc: function(func) {
            let funcPtr = addFunction(function(fontPtr, font_data, extentsPtr, user_data) {
              let font = createFont(null, fontPtr);
              let extents = func(font);
              font.destroy();
              if (extents) {
                Module.HEAP32[extentsPtr / 4] = extents.ascender;
                Module.HEAP32[extentsPtr / 4 + 1] = extents.descender;
                Module.HEAP32[extentsPtr / 4 + 2] = extents.lineGap;
                return 1;
              }
              return 0;
            }, "ipppp");
            exports3.hb_font_funcs_set_font_v_extents_func(ptr, funcPtr, 0, 0);
          },
          destroy: function() {
            exports3.hb_font_funcs_destroy(ptr);
          }
        };
      }
      function createBuffer(ptr) {
        var ptr = ptr ? exports3.hb_buffer_reference(ptr) : exports3.hb_buffer_create();
        return {
          ptr,
          /**
          * Add text to the buffer.
          * @param {string} text Text to be added to the buffer.
          * @param {number} itemOffset Optional. The offset of the first character to add to the buffer.
          * @param {number} itemLength Optional. The number of characters to add to the buffer, or null for the end of text.
          **/
          addText: function(text, itemOffset = 0, itemLength = null) {
            const str = _string_to_utf16_ptr(text);
            if (itemLength == null)
              itemLength = str.length;
            exports3.hb_buffer_add_utf16(ptr, str.ptr, str.length, itemOffset, itemLength);
            str.free();
          },
          /**
          * Add code points to the buffer.
          * @param {number[]} codePoints Array of code points to be added to the buffer.
          * @param {number} itemOffset Optional. The offset of the first code point to add to the buffer.
          * @param {number} itemLength Optional. The number of code points to add to the buffer, or null for the end of the array.
          */
          addCodePoints: function(codePoints, itemOffset = 0, itemLength = null) {
            let codePointsPtr = exports3.malloc(codePoints.length * 4);
            let codePointsArray = Module.HEAPU32.subarray(codePointsPtr / 4, codePointsPtr / 4 + codePoints.length);
            codePointsArray.set(codePoints);
            if (itemLength == null)
              itemLength = codePoints.length;
            exports3.hb_buffer_add_codepoints(ptr, codePointsPtr, codePoints.length, itemOffset, itemLength);
            exports3.free(codePointsPtr);
          },
          /**
          * Set buffer script, language and direction.
          *
          * This needs to be done before shaping.
          **/
          guessSegmentProperties: function() {
            return exports3.hb_buffer_guess_segment_properties(ptr);
          },
          /**
          * Set buffer direction explicitly.
          * @param {string} direction: One of "ltr", "rtl", "ttb" or "btt"
          */
          setDirection: function(dir) {
            exports3.hb_buffer_set_direction(ptr, {
              ltr: 4,
              rtl: 5,
              ttb: 6,
              btt: 7
            }[dir] || 0);
          },
          /**
          * Set buffer flags explicitly.
          * @param {string[]} flags: A list of strings which may be either:
          * "DEFAULT"
          * "BOT"
          * "EOT"
          * "PRESERVE_DEFAULT_IGNORABLES"
          * "REMOVE_DEFAULT_IGNORABLES"
          * "DO_NOT_INSERT_DOTTED_CIRCLE"
          * "VERIFY"
          * "PRODUCE_UNSAFE_TO_CONCAT"
          * "PRODUCE_SAFE_TO_INSERT_TATWEEL"
          */
          setFlags: function(flags) {
            var flagsValue = 0;
            flags.forEach((s) => flagsValue |= bufferFlags[s] || 0);
            exports3.hb_buffer_set_flags(ptr, flagsValue);
          },
          /**
          * Set buffer language explicitly.
          * @param {string} language: The buffer language
          */
          setLanguage: function(language) {
            var str = _string_to_ascii_ptr(language);
            exports3.hb_buffer_set_language(ptr, exports3.hb_language_from_string(str.ptr, -1));
            str.free();
          },
          /**
          * Set buffer script explicitly.
          * @param {string} script: The buffer script
          */
          setScript: function(script) {
            var str = _string_to_ascii_ptr(script);
            exports3.hb_buffer_set_script(ptr, exports3.hb_script_from_string(str.ptr, -1));
            str.free();
          },
          /**
          * Set the Harfbuzz clustering level.
          *
          * Affects the cluster values returned from shaping.
          * @param {number} level: Clustering level. See the Harfbuzz manual chapter
          * on Clusters.
          **/
          setClusterLevel: function(level) {
            exports3.hb_buffer_set_cluster_level(ptr, level);
          },
          /**
          * Reset the buffer to its initial status.
          **/
          reset: function() {
            exports3.hb_buffer_reset(ptr);
          },
          /**
          * Similar to reset(), but does not clear the Unicode functions and the
          * replacement code point.
          **/
          clearContents: function() {
            exports3.hb_buffer_clear_contents(ptr);
          },
          /**
          * Set message func.
          * @param {function} func The function to set.
          *
          * The function should accept three arguments:
          * @param {object} buffer The buffer
          * @param {object} font The font
          * @param {string} message The message
          *
          * Returning false from this function will skip this shaping step and move to the next one.
          */
          setMessageFunc: function(func) {
            var traceFunc = function(bufferPtr, fontPtr, messagePtr, user_data) {
              var message = _utf8_ptr_to_string(messagePtr);
              var buffer = createBuffer(bufferPtr);
              var font = createFont(null, fontPtr);
              var result = func(buffer, font, message);
              buffer.destroy();
              font.destroy();
              return result ? 1 : 0;
            };
            var traceFuncPtr = addFunction(traceFunc, "iiiii");
            exports3.hb_buffer_set_message_func(ptr, traceFuncPtr, 0, 0);
          },
          /**
          * Get the the number of items in the buffer.
          * @returns {number} The buffer length.
          */
          getLength: function() {
            return exports3.hb_buffer_get_length(ptr);
          },
          /**
          * Get the glyph information from the buffer.
          * @returns {object[]} The glyph information.
          *
          * The glyph information is returned as an array of objects with the
          * following properties:
          * @param {number} codepoint either a Unicode code point (before shaping) or a glyph index (after shaping).
          * @param {number} cluster The cluster index of the glyph.
          */
          getGlyphInfos: function() {
            var infosPtr32 = exports3.hb_buffer_get_glyph_infos(ptr, 0) / 4;
            var infosArray = Module.HEAPU32.subarray(infosPtr32, infosPtr32 + this.getLength() * 5);
            var infos = [];
            for (var i = 0; i < infosArray.length; i += 5) {
              infos.push({
                codepoint: infosArray[i],
                cluster: infosArray[i + 2]
              });
            }
            return infos;
          },
          /**
          * Get the glyph positions from the buffer.
          * @returns {object[]} The glyph positions.
          *
          * The glyph positions are returned as an array of objects with the
          * following properties:
          * @param {number} x_advance The x advance of the glyph.
          * @param {number} y_advance The y advance of the glyph.
          * @param {number} x_offset The x offset of the glyph.
          * @param {number} y_offset The y offset of the glyph.
          *
          */
          getGlyphPositions: function() {
            var positionsPtr32 = exports3.hb_buffer_get_glyph_positions(ptr, 0) / 4;
            if (positionsPtr32 == 0) {
              return [];
            }
            var positionsArray = Module.HEAP32.subarray(positionsPtr32, positionsPtr32 + this.getLength() * 5);
            var positions = [];
            for (var i = 0; i < positionsArray.length; i += 5) {
              positions.push({
                x_advance: positionsArray[i],
                y_advance: positionsArray[i + 1],
                x_offset: positionsArray[i + 2],
                y_offset: positionsArray[i + 3]
              });
            }
            return positions;
          },
          /**
          * Get the glyph information and positions from the buffer.
          * @returns {object[]} The glyph information and positions.
          *
          * The glyph information is returned as an array of objects with the
          * properties from getGlyphInfos and getGlyphPositions combined.
          */
          getGlyphInfosAndPositions: function() {
            var infosPtr32 = exports3.hb_buffer_get_glyph_infos(ptr, 0) / 4;
            var infosArray = Module.HEAPU32.subarray(infosPtr32, infosPtr32 + this.getLength() * 5);
            var positionsPtr32 = exports3.hb_buffer_get_glyph_positions(ptr, 0) / 4;
            var positionsArray = positionsPtr32 ? Module.HEAP32.subarray(positionsPtr32, positionsPtr32 + this.getLength() * 5) : null;
            var out = [];
            for (var i = 0; i < infosArray.length; i += 5) {
              var info = {
                codepoint: infosArray[i],
                cluster: infosArray[i + 2]
              };
              for (var [name, idx] of [["mask", 1], ["var1", 3], ["var2", 4]]) {
                Object.defineProperty(info, name, {
                  value: infosArray[i + idx],
                  enumerable: false
                });
              }
              if (positionsArray) {
                info.x_advance = positionsArray[i];
                info.y_advance = positionsArray[i + 1];
                info.x_offset = positionsArray[i + 2];
                info.y_offset = positionsArray[i + 3];
                Object.defineProperty(info, "var", {
                  value: positionsArray[i + 4],
                  enumerable: false
                });
              }
              out.push(info);
            }
            return out;
          },
          /**
          * Update the glyph positions in the buffer.
          * @param {object[]} positions The new glyph positions.
          *
          * WARNING: Do not use unless you know what you are doing.
          */
          updateGlyphPositions: function(positions) {
            var positionsPtr32 = exports3.hb_buffer_get_glyph_positions(ptr, 0) / 4;
            if (positionsPtr32 == 0) {
              return;
            }
            var len = Math.min(positions.length, this.getLength());
            var positionsArray = Module.HEAP32.subarray(positionsPtr32, positionsPtr32 + len * 5);
            for (var i = 0; i < len; i++) {
              positionsArray[i * 5] = positions[i].x_advance;
              positionsArray[i * 5 + 1] = positions[i].y_advance;
              positionsArray[i * 5 + 2] = positions[i].x_offset;
              positionsArray[i * 5 + 3] = positions[i].y_offset;
            }
          },
          /**
          * Serialize the buffer contents to a string.
          * @param {object} font Optional. The font to use for serialization.
          * @param {number} start Optional. The starting index of the glyphs to serialize.
          * @param {number} end Optional. The ending index of the glyphs to serialize.
          * @param {string} format Optional. The format to serialize the buffer contents to.
          * @param {string[]} flags Optional. The flags to use for serialization. A list of strings which may be either:
          * "DEFAULT"
          * "NO_CLUSTERS"
          * "NO_POSITIONS"
          * "NO_GLYPH_NAMES"
          * "GLYPH_EXTENTS"
          * "GLYPH_FLAGS"
          * "NO_ADVANCES"
          *
          * @returns {string} The serialized buffer contents.
          */
          serialize: function(font, start = 0, end = null, format = "TEXT", flags = []) {
            var sp2 = stackSave();
            if (end == null)
              end = this.getLength();
            var bufLen = 32 * 1024;
            var bufPtr = exports3.malloc(bufLen);
            var bufConsumedPtr = stackAlloc(4);
            var flagsValue = 0;
            flags.forEach((flag) => flagsValue |= bufferSerializeFlags[flag] || 0);
            var result = "";
            while (start < end) {
              start += exports3.hb_buffer_serialize(
                ptr,
                start,
                end,
                bufPtr,
                bufLen,
                bufConsumedPtr,
                font ? font.ptr : 0,
                _hb_tag(format),
                flagsValue
              );
              var bufConsumed = Module.HEAPU32[bufConsumedPtr / 4];
              if (bufConsumed == 0)
                break;
              result += _utf8_ptr_to_string(bufPtr, bufConsumed);
            }
            exports3.free(bufPtr);
            stackRestore(sp2);
            return result;
          },
          /**
          * Return the buffer content type.
          *
          * @returns {string} The buffer content type. One of:
          * "INVALID"
          * "UNICODE"
          * "GLYPHS"
          */
          getContentType: function() {
            return bufferContentType[exports3.hb_buffer_get_content_type(ptr)];
          },
          /**
          * Return the buffer contents as a JSON object.
          *
          * After shaping, this function will return an array of glyph information
          * objects. Each object will have the following attributes:
          *
          *   - g: The glyph ID
          *   - cl: The cluster ID
          *   - ax: Advance width (width to advance after this glyph is painted)
          *   - ay: Advance height (height to advance after this glyph is painted)
          *   - dx: X displacement (adjustment in X dimension when painting this glyph)
          *   - dy: Y displacement (adjustment in Y dimension when painting this glyph)
          *   - flags: Glyph flags like `HB_GLYPH_FLAG_UNSAFE_TO_BREAK` (0x1)
          **/
          json: function() {
            var buf = this.serialize(null, 0, null, "JSON", ["NO_GLYPH_NAMES", "GLYPH_FLAGS"]);
            var json = JSON.parse(buf);
            json.forEach(function(glyph) {
              glyph.flags = glyph.fl || 0;
              delete glyph.fl;
            });
            return json;
          },
          /**
          * Free the object.
          */
          destroy: function() {
            exports3.hb_buffer_destroy(ptr);
          }
        };
      }
      function shape(font, buffer, features) {
        var featuresPtr = 0;
        var featuresLen = 0;
        if (features) {
          features = features.split(",");
          featuresPtr = exports3.malloc(16 * features.length);
          features.forEach(function(feature, i) {
            var str = _string_to_ascii_ptr(feature);
            if (exports3.hb_feature_from_string(str.ptr, -1, featuresPtr + featuresLen * 16))
              featuresLen++;
            str.free();
          });
        }
        exports3.hb_shape(font.ptr, buffer.ptr, featuresPtr, featuresLen);
        if (featuresPtr)
          exports3.free(featuresPtr);
      }
      function shapeWithTrace(font, buffer, features, stop_at, stop_phase) {
        var trace = [];
        var currentPhase = TRACE_PHASE_DONT_STOP;
        var stopping = false;
        var failure = false;
        buffer.setMessageFunc((buffer2, font2, message) => {
          if (message.startsWith("start table GSUB"))
            currentPhase = TRACE_PHASE_GSUB;
          else if (message.startsWith("start table GPOS"))
            currentPhase = TRACE_PHASE_GPOS;
          if (currentPhase != stop_phase)
            stopping = false;
          if (failure)
            return true;
          if (stop_phase != TRACE_PHASE_DONT_STOP && currentPhase == stop_phase && message.startsWith("end lookup " + stop_at))
            stopping = true;
          if (stopping)
            return false;
          var traceBuf = buffer2.serialize(font2, 0, null, "JSON", ["NO_GLYPH_NAMES"]);
          trace.push({
            m: message,
            t: JSON.parse(traceBuf),
            glyphs: buffer2.getContentType() == "GLYPHS"
          });
          return true;
        });
        shape(font, buffer, features, 0);
        return trace;
      }
      function version() {
        var sp2 = stackSave();
        var versionPtr = stackAlloc(12);
        exports3.hb_version(versionPtr, versionPtr + 4, versionPtr + 8);
        var version2 = {
          major: Module.HEAPU32[versionPtr / 4],
          minor: Module.HEAPU32[(versionPtr + 4) / 4],
          micro: Module.HEAPU32[(versionPtr + 8) / 4]
        };
        stackRestore(sp2);
        return version2;
      }
      function version_string() {
        var versionPtr = exports3.hb_version_string();
        return _utf8_ptr_to_string(versionPtr);
      }
      function otTagToScript(tag) {
        var hbTag = _hb_tag(tag);
        var script = exports3.hb_ot_tag_to_script(hbTag);
        return _hb_untag(script);
      }
      function otTagToLanguage(tag) {
        var hbTag = _hb_tag(tag);
        var language = exports3.hb_ot_tag_to_language(hbTag);
        return _language_to_string(language);
      }
      return {
        createBlob,
        createFace,
        createFont,
        createFontFuncs,
        createBuffer,
        shape,
        shapeWithTrace,
        version,
        version_string,
        otTagToScript,
        otTagToLanguage
      };
    }
    try {
      module.exports = hbjs;
    } catch (e) {
    }
  }
});

// node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/hb.js
var require_hb = __commonJS({
  "node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/hb.js"(exports2, module) {
    var createHarfBuzz = (() => {
      var _scriptName = typeof document != "undefined" ? document.currentScript?.src : void 0;
      return async function(moduleArg = {}) {
        var moduleRtn;
        var Module = moduleArg;
        var ENVIRONMENT_IS_WEB = typeof window == "object";
        var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
        var ENVIRONMENT_IS_NODE = false;
        var arguments_ = [];
        var thisProgram = "./this.program";
        var quit_ = (status, toThrow) => {
          throw toThrow;
        };
        if (typeof __filename != "undefined") {
          _scriptName = __filename;
        } else if (ENVIRONMENT_IS_WORKER) {
          _scriptName = self.location.href;
        }
        var scriptDirectory = "";
        function locateFile(path) {
          if (Module["locateFile"]) {
            return Module["locateFile"](path, scriptDirectory);
          }
          return scriptDirectory + path;
        }
        var readAsync, readBinary;
        if (ENVIRONMENT_IS_NODE) {
          var fs = __require("fs");
          scriptDirectory = __dirname + "/";
          readBinary = (filename) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename);
            return ret;
          };
          readAsync = async (filename, binary = true) => {
            filename = isFileURI(filename) ? new URL(filename) : filename;
            var ret = fs.readFileSync(filename, binary ? void 0 : "utf8");
            return ret;
          };
          if (process.argv.length > 1) {
            thisProgram = process.argv[1].replace(/\\/g, "/");
          }
          arguments_ = process.argv.slice(2);
          quit_ = (status, toThrow) => {
            process.exitCode = status;
            throw toThrow;
          };
        } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
          try {
            scriptDirectory = new URL(".", _scriptName).href;
          } catch {
          }
          {
            if (ENVIRONMENT_IS_WORKER) {
              readBinary = (url) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.responseType = "arraybuffer";
                xhr.send(null);
                return new Uint8Array(xhr.response);
              };
            }
            readAsync = async (url) => {
              if (isFileURI(url)) {
                return new Promise((resolve, reject) => {
                  var xhr = new XMLHttpRequest();
                  xhr.open("GET", url, true);
                  xhr.responseType = "arraybuffer";
                  xhr.onload = () => {
                    if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                      resolve(xhr.response);
                      return;
                    }
                    reject(xhr.status);
                  };
                  xhr.onerror = reject;
                  xhr.send(null);
                });
              }
              var response = await fetch(url, { credentials: "same-origin" });
              if (response.ok) {
                return response.arrayBuffer();
              }
              throw new Error(response.status + " : " + response.url);
            };
          }
        } else {
        }
        var out = console.log.bind(console);
        var err3 = console.error.bind(console);
        var wasmBinary;
        var ABORT = false;
        var EXITSTATUS;
        var isFileURI = (filename) => filename.startsWith("file://");
        var readyPromiseResolve, readyPromiseReject;
        var wasmMemory;
        var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
        var HEAP64, HEAPU64;
        var runtimeInitialized = false;
        function updateMemoryViews() {
          var b = wasmMemory.buffer;
          Module["HEAP8"] = HEAP8 = new Int8Array(b);
          HEAP16 = new Int16Array(b);
          Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
          Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
          Module["HEAP32"] = HEAP32 = new Int32Array(b);
          Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
          Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
          HEAPF64 = new Float64Array(b);
          HEAP64 = new BigInt64Array(b);
          HEAPU64 = new BigUint64Array(b);
        }
        function preRun() {
          if (Module["preRun"]) {
            if (typeof Module["preRun"] == "function")
              Module["preRun"] = [Module["preRun"]];
            while (Module["preRun"].length) {
              addOnPreRun(Module["preRun"].shift());
            }
          }
          callRuntimeCallbacks(onPreRuns);
        }
        function initRuntime() {
          runtimeInitialized = true;
          wasmExports["__wasm_call_ctors"]();
        }
        function postRun() {
          if (Module["postRun"]) {
            if (typeof Module["postRun"] == "function")
              Module["postRun"] = [Module["postRun"]];
            while (Module["postRun"].length) {
              addOnPostRun(Module["postRun"].shift());
            }
          }
          callRuntimeCallbacks(onPostRuns);
        }
        var runDependencies = 0;
        var dependenciesFulfilled = null;
        function addRunDependency(id2) {
          runDependencies++;
          Module["monitorRunDependencies"]?.(runDependencies);
        }
        function removeRunDependency(id2) {
          runDependencies--;
          Module["monitorRunDependencies"]?.(runDependencies);
          if (runDependencies == 0) {
            if (dependenciesFulfilled) {
              var callback = dependenciesFulfilled;
              dependenciesFulfilled = null;
              callback();
            }
          }
        }
        function abort(what) {
          Module["onAbort"]?.(what);
          what = "Aborted(" + what + ")";
          err3(what);
          ABORT = true;
          what += ". Build with -sASSERTIONS for more info.";
          var e = new WebAssembly.RuntimeError(what);
          readyPromiseReject?.(e);
          throw e;
        }
        var wasmBinaryFile;
        function findWasmBinary() {
          return locateFile("hb.wasm");
        }
        function getBinarySync(file) {
          if (file == wasmBinaryFile && wasmBinary) {
            return new Uint8Array(wasmBinary);
          }
          if (readBinary) {
            return readBinary(file);
          }
          throw "both async and sync fetching of the wasm failed";
        }
        async function getWasmBinary(binaryFile) {
          if (!wasmBinary) {
            try {
              var response = await readAsync(binaryFile);
              return new Uint8Array(response);
            } catch {
            }
          }
          return getBinarySync(binaryFile);
        }
        async function instantiateArrayBuffer(binaryFile, imports) {
          try {
            var binary = await getWasmBinary(binaryFile);
            var instance = await WebAssembly.instantiate(binary, imports);
            return instance;
          } catch (reason) {
            err3(`failed to asynchronously prepare wasm: ${reason}`);
            abort(reason);
          }
        }
        async function instantiateAsync(binary, binaryFile, imports) {
          if (!binary && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
            try {
              var response = fetch(binaryFile, { credentials: "same-origin" });
              var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
              return instantiationResult;
            } catch (reason) {
              err3(`wasm streaming compile failed: ${reason}`);
              err3("falling back to ArrayBuffer instantiation");
            }
          }
          return instantiateArrayBuffer(binaryFile, imports);
        }
        function getWasmImports() {
          return { env: wasmImports, wasi_snapshot_preview1: wasmImports };
        }
        async function createWasm() {
          function receiveInstance(instance, module2) {
            wasmExports = instance.exports;
            Module["wasmExports"] = wasmExports;
            wasmMemory = wasmExports["memory"];
            updateMemoryViews();
            wasmTable = wasmExports["__indirect_function_table"];
            assignWasmExports(wasmExports);
            removeRunDependency("wasm-instantiate");
            return wasmExports;
          }
          addRunDependency("wasm-instantiate");
          function receiveInstantiationResult(result2) {
            return receiveInstance(result2["instance"]);
          }
          var info = getWasmImports();
          if (Module["instantiateWasm"]) {
            return new Promise((resolve, reject) => {
              Module["instantiateWasm"](info, (mod, inst) => {
                resolve(receiveInstance(mod, inst));
              });
            });
          }
          wasmBinaryFile ??= findWasmBinary();
          var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
          var exports3 = receiveInstantiationResult(result);
          return exports3;
        }
        class ExitStatus {
          constructor(status) {
            __publicField(this, "name", "ExitStatus");
            this.message = `Program terminated with exit(${status})`;
            this.status = status;
          }
        }
        var callRuntimeCallbacks = (callbacks) => {
          while (callbacks.length > 0) {
            callbacks.shift()(Module);
          }
        };
        var onPostRuns = [];
        var addOnPostRun = (cb) => onPostRuns.push(cb);
        var onPreRuns = [];
        var addOnPreRun = (cb) => onPreRuns.push(cb);
        var noExitRuntime = true;
        var stackRestore = (val) => __emscripten_stack_restore(val);
        var stackSave = () => _emscripten_stack_get_current();
        var __abort_js = () => abort("");
        var runtimeKeepaliveCounter = 0;
        var __emscripten_runtime_keepalive_clear = () => {
          noExitRuntime = false;
          runtimeKeepaliveCounter = 0;
        };
        var timers = {};
        var handleException = (e) => {
          if (e instanceof ExitStatus || e == "unwind") {
            return EXITSTATUS;
          }
          quit_(1, e);
        };
        var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
        var _proc_exit = (code) => {
          EXITSTATUS = code;
          if (!keepRuntimeAlive()) {
            Module["onExit"]?.(code);
            ABORT = true;
          }
          quit_(code, new ExitStatus(code));
        };
        var exitJS = (status, implicit) => {
          EXITSTATUS = status;
          _proc_exit(status);
        };
        var _exit = exitJS;
        var maybeExit = () => {
          if (!keepRuntimeAlive()) {
            try {
              _exit(EXITSTATUS);
            } catch (e) {
              handleException(e);
            }
          }
        };
        var callUserCallback = (func) => {
          if (ABORT) {
            return;
          }
          try {
            func();
            maybeExit();
          } catch (e) {
            handleException(e);
          }
        };
        var _emscripten_get_now = () => performance.now();
        var __setitimer_js = (which, timeout_ms) => {
          if (timers[which]) {
            clearTimeout(timers[which].id);
            delete timers[which];
          }
          if (!timeout_ms)
            return 0;
          var id2 = setTimeout(() => {
            delete timers[which];
            callUserCallback(() => __emscripten_timeout(which, _emscripten_get_now()));
          }, timeout_ms);
          timers[which] = { id: id2, timeout_ms };
          return 0;
        };
        var getHeapMax = () => 2147483648;
        var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
        var growMemory = (size) => {
          var oldHeapSize = wasmMemory.buffer.byteLength;
          var pages = (size - oldHeapSize + 65535) / 65536 | 0;
          try {
            wasmMemory.grow(pages);
            updateMemoryViews();
            return 1;
          } catch (e) {
          }
        };
        var _emscripten_resize_heap = (requestedSize) => {
          var oldSize = HEAPU8.length;
          requestedSize >>>= 0;
          var maxHeapSize = getHeapMax();
          if (requestedSize > maxHeapSize) {
            return false;
          }
          for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
            var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
            overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
            var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
            var replacement = growMemory(newSize);
            if (replacement) {
              return true;
            }
          }
          return false;
        };
        var uleb128EncodeWithLen = (arr) => {
          const n = arr.length;
          return [n % 128 | 128, n >> 7, ...arr];
        };
        var wasmTypeCodes = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 };
        var generateTypePack = (types) => uleb128EncodeWithLen(Array.from(types, (type) => {
          var code = wasmTypeCodes[type];
          return code;
        }));
        var convertJsFunctionToWasm = (func, sig) => {
          var bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...uleb128EncodeWithLen([1, 96, ...generateTypePack(sig.slice(1)), ...generateTypePack(sig[0] === "v" ? "" : sig[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
          var module2 = new WebAssembly.Module(bytes);
          var instance = new WebAssembly.Instance(module2, { e: { f: func } });
          var wrappedFunc = instance.exports["f"];
          return wrappedFunc;
        };
        var wasmTable;
        var getWasmTableEntry = (funcPtr) => wasmTable.get(funcPtr);
        var updateTableMap = (offset, count) => {
          if (functionsInTableMap) {
            for (var i = offset; i < offset + count; i++) {
              var item = getWasmTableEntry(i);
              if (item) {
                functionsInTableMap.set(item, i);
              }
            }
          }
        };
        var functionsInTableMap;
        var getFunctionAddress = (func) => {
          if (!functionsInTableMap) {
            functionsInTableMap = /* @__PURE__ */ new WeakMap();
            updateTableMap(0, wasmTable.length);
          }
          return functionsInTableMap.get(func) || 0;
        };
        var freeTableIndexes = [];
        var getEmptyTableSlot = () => {
          if (freeTableIndexes.length) {
            return freeTableIndexes.pop();
          }
          return wasmTable["grow"](1);
        };
        var setWasmTableEntry = (idx, func) => wasmTable.set(idx, func);
        var addFunction = (func, sig) => {
          var rtn = getFunctionAddress(func);
          if (rtn) {
            return rtn;
          }
          var ret = getEmptyTableSlot();
          try {
            setWasmTableEntry(ret, func);
          } catch (err4) {
            if (!(err4 instanceof TypeError)) {
              throw err4;
            }
            var wrapped = convertJsFunctionToWasm(func, sig);
            setWasmTableEntry(ret, wrapped);
          }
          functionsInTableMap.set(func, ret);
          return ret;
        };
        var removeFunction = (index) => {
          functionsInTableMap.delete(getWasmTableEntry(index));
          setWasmTableEntry(index, null);
          freeTableIndexes.push(index);
        };
        var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
        {
          if (Module["noExitRuntime"])
            noExitRuntime = Module["noExitRuntime"];
          if (Module["print"])
            out = Module["print"];
          if (Module["printErr"])
            err3 = Module["printErr"];
          if (Module["wasmBinary"])
            wasmBinary = Module["wasmBinary"];
          if (Module["arguments"])
            arguments_ = Module["arguments"];
          if (Module["thisProgram"])
            thisProgram = Module["thisProgram"];
        }
        Module["wasmExports"] = wasmExports;
        Module["stackSave"] = stackSave;
        Module["stackRestore"] = stackRestore;
        Module["stackAlloc"] = stackAlloc;
        Module["addFunction"] = addFunction;
        Module["removeFunction"] = removeFunction;
        var _hb_blob_create, _hb_blob_destroy, _hb_blob_get_length, _hb_blob_get_data, _hb_buffer_serialize, _hb_buffer_create, _hb_buffer_reset, _hb_buffer_reference, _hb_buffer_destroy, _hb_buffer_get_content_type, _hb_buffer_set_direction, _hb_buffer_set_script, _hb_buffer_set_language, _hb_buffer_set_flags, _hb_buffer_set_cluster_level, _hb_buffer_clear_contents, _hb_buffer_get_length, _hb_buffer_get_glyph_infos, _hb_buffer_get_glyph_positions, _hb_glyph_info_get_glyph_flags, _hb_buffer_guess_segment_properties, _hb_buffer_add_utf8, _hb_buffer_add_utf16, _hb_buffer_add_codepoints, _hb_buffer_set_message_func, _hb_language_from_string, _hb_language_to_string, _hb_script_from_string, _hb_version, _hb_version_string, _hb_feature_from_string, _malloc, _free, _hb_draw_funcs_set_move_to_func, _hb_draw_funcs_set_line_to_func, _hb_draw_funcs_set_quadratic_to_func, _hb_draw_funcs_set_cubic_to_func, _hb_draw_funcs_set_close_path_func, _hb_draw_funcs_create, _hb_draw_funcs_destroy, _hb_face_create, _hb_face_destroy, _hb_face_reference_table, _hb_face_get_upem, _hb_face_collect_unicodes, _hb_font_funcs_create, _hb_font_funcs_destroy, _hb_font_funcs_set_font_h_extents_func, _hb_font_funcs_set_font_v_extents_func, _hb_font_funcs_set_nominal_glyph_func, _hb_font_funcs_set_nominal_glyphs_func, _hb_font_funcs_set_variation_glyph_func, _hb_font_funcs_set_glyph_h_advance_func, _hb_font_funcs_set_glyph_v_advance_func, _hb_font_funcs_set_glyph_h_advances_func, _hb_font_funcs_set_glyph_v_advances_func, _hb_font_funcs_set_glyph_h_origin_func, _hb_font_funcs_set_glyph_v_origin_func, _hb_font_funcs_set_glyph_h_kerning_func, _hb_font_funcs_set_glyph_extents_func, _hb_font_funcs_set_glyph_name_func, _hb_font_funcs_set_glyph_from_name_func, _hb_font_get_h_extents, _hb_font_get_v_extents, _hb_font_get_glyph_h_advance, _hb_font_get_glyph_v_advance, _hb_font_get_glyph_h_origin, _hb_font_get_glyph_v_origin, _hb_font_get_glyph_extents, _hb_font_get_glyph_from_name, _hb_font_draw_glyph, _hb_font_glyph_to_string, _hb_font_create, _hb_font_set_variations, _hb_font_create_sub_font, _hb_font_reference, _hb_font_destroy, _hb_font_set_funcs, _hb_font_set_scale, _hb_ot_layout_get_glyph_class, _hb_ot_layout_table_get_script_tags, _hb_ot_layout_table_get_feature_tags, _hb_ot_layout_script_get_language_tags, _hb_ot_layout_language_get_feature_tags, _hb_ot_layout_feature_get_name_ids, _hb_ot_name_list_names, _hb_ot_name_get_utf16, _hb_set_create, _hb_set_destroy, _hb_ot_tag_to_script, _hb_ot_tag_to_language, _hb_ot_var_get_axis_infos, _hb_set_get_population, _hb_set_next_many, _hb_shape, __emscripten_timeout, __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current;
        function assignWasmExports(wasmExports2) {
          Module["_hb_blob_create"] = _hb_blob_create = wasmExports2["hb_blob_create"];
          Module["_hb_blob_destroy"] = _hb_blob_destroy = wasmExports2["hb_blob_destroy"];
          Module["_hb_blob_get_length"] = _hb_blob_get_length = wasmExports2["hb_blob_get_length"];
          Module["_hb_blob_get_data"] = _hb_blob_get_data = wasmExports2["hb_blob_get_data"];
          Module["_hb_buffer_serialize"] = _hb_buffer_serialize = wasmExports2["hb_buffer_serialize"];
          Module["_hb_buffer_create"] = _hb_buffer_create = wasmExports2["hb_buffer_create"];
          Module["_hb_buffer_reset"] = _hb_buffer_reset = wasmExports2["hb_buffer_reset"];
          Module["_hb_buffer_reference"] = _hb_buffer_reference = wasmExports2["hb_buffer_reference"];
          Module["_hb_buffer_destroy"] = _hb_buffer_destroy = wasmExports2["hb_buffer_destroy"];
          Module["_hb_buffer_get_content_type"] = _hb_buffer_get_content_type = wasmExports2["hb_buffer_get_content_type"];
          Module["_hb_buffer_set_direction"] = _hb_buffer_set_direction = wasmExports2["hb_buffer_set_direction"];
          Module["_hb_buffer_set_script"] = _hb_buffer_set_script = wasmExports2["hb_buffer_set_script"];
          Module["_hb_buffer_set_language"] = _hb_buffer_set_language = wasmExports2["hb_buffer_set_language"];
          Module["_hb_buffer_set_flags"] = _hb_buffer_set_flags = wasmExports2["hb_buffer_set_flags"];
          Module["_hb_buffer_set_cluster_level"] = _hb_buffer_set_cluster_level = wasmExports2["hb_buffer_set_cluster_level"];
          Module["_hb_buffer_clear_contents"] = _hb_buffer_clear_contents = wasmExports2["hb_buffer_clear_contents"];
          Module["_hb_buffer_get_length"] = _hb_buffer_get_length = wasmExports2["hb_buffer_get_length"];
          Module["_hb_buffer_get_glyph_infos"] = _hb_buffer_get_glyph_infos = wasmExports2["hb_buffer_get_glyph_infos"];
          Module["_hb_buffer_get_glyph_positions"] = _hb_buffer_get_glyph_positions = wasmExports2["hb_buffer_get_glyph_positions"];
          Module["_hb_glyph_info_get_glyph_flags"] = _hb_glyph_info_get_glyph_flags = wasmExports2["hb_glyph_info_get_glyph_flags"];
          Module["_hb_buffer_guess_segment_properties"] = _hb_buffer_guess_segment_properties = wasmExports2["hb_buffer_guess_segment_properties"];
          Module["_hb_buffer_add_utf8"] = _hb_buffer_add_utf8 = wasmExports2["hb_buffer_add_utf8"];
          Module["_hb_buffer_add_utf16"] = _hb_buffer_add_utf16 = wasmExports2["hb_buffer_add_utf16"];
          Module["_hb_buffer_add_codepoints"] = _hb_buffer_add_codepoints = wasmExports2["hb_buffer_add_codepoints"];
          Module["_hb_buffer_set_message_func"] = _hb_buffer_set_message_func = wasmExports2["hb_buffer_set_message_func"];
          Module["_hb_language_from_string"] = _hb_language_from_string = wasmExports2["hb_language_from_string"];
          Module["_hb_language_to_string"] = _hb_language_to_string = wasmExports2["hb_language_to_string"];
          Module["_hb_script_from_string"] = _hb_script_from_string = wasmExports2["hb_script_from_string"];
          Module["_hb_version"] = _hb_version = wasmExports2["hb_version"];
          Module["_hb_version_string"] = _hb_version_string = wasmExports2["hb_version_string"];
          Module["_hb_feature_from_string"] = _hb_feature_from_string = wasmExports2["hb_feature_from_string"];
          Module["_malloc"] = _malloc = wasmExports2["malloc"];
          Module["_free"] = _free = wasmExports2["free"];
          Module["_hb_draw_funcs_set_move_to_func"] = _hb_draw_funcs_set_move_to_func = wasmExports2["hb_draw_funcs_set_move_to_func"];
          Module["_hb_draw_funcs_set_line_to_func"] = _hb_draw_funcs_set_line_to_func = wasmExports2["hb_draw_funcs_set_line_to_func"];
          Module["_hb_draw_funcs_set_quadratic_to_func"] = _hb_draw_funcs_set_quadratic_to_func = wasmExports2["hb_draw_funcs_set_quadratic_to_func"];
          Module["_hb_draw_funcs_set_cubic_to_func"] = _hb_draw_funcs_set_cubic_to_func = wasmExports2["hb_draw_funcs_set_cubic_to_func"];
          Module["_hb_draw_funcs_set_close_path_func"] = _hb_draw_funcs_set_close_path_func = wasmExports2["hb_draw_funcs_set_close_path_func"];
          Module["_hb_draw_funcs_create"] = _hb_draw_funcs_create = wasmExports2["hb_draw_funcs_create"];
          Module["_hb_draw_funcs_destroy"] = _hb_draw_funcs_destroy = wasmExports2["hb_draw_funcs_destroy"];
          Module["_hb_face_create"] = _hb_face_create = wasmExports2["hb_face_create"];
          Module["_hb_face_destroy"] = _hb_face_destroy = wasmExports2["hb_face_destroy"];
          Module["_hb_face_reference_table"] = _hb_face_reference_table = wasmExports2["hb_face_reference_table"];
          Module["_hb_face_get_upem"] = _hb_face_get_upem = wasmExports2["hb_face_get_upem"];
          Module["_hb_face_collect_unicodes"] = _hb_face_collect_unicodes = wasmExports2["hb_face_collect_unicodes"];
          Module["_hb_font_funcs_create"] = _hb_font_funcs_create = wasmExports2["hb_font_funcs_create"];
          Module["_hb_font_funcs_destroy"] = _hb_font_funcs_destroy = wasmExports2["hb_font_funcs_destroy"];
          Module["_hb_font_funcs_set_font_h_extents_func"] = _hb_font_funcs_set_font_h_extents_func = wasmExports2["hb_font_funcs_set_font_h_extents_func"];
          Module["_hb_font_funcs_set_font_v_extents_func"] = _hb_font_funcs_set_font_v_extents_func = wasmExports2["hb_font_funcs_set_font_v_extents_func"];
          Module["_hb_font_funcs_set_nominal_glyph_func"] = _hb_font_funcs_set_nominal_glyph_func = wasmExports2["hb_font_funcs_set_nominal_glyph_func"];
          Module["_hb_font_funcs_set_nominal_glyphs_func"] = _hb_font_funcs_set_nominal_glyphs_func = wasmExports2["hb_font_funcs_set_nominal_glyphs_func"];
          Module["_hb_font_funcs_set_variation_glyph_func"] = _hb_font_funcs_set_variation_glyph_func = wasmExports2["hb_font_funcs_set_variation_glyph_func"];
          Module["_hb_font_funcs_set_glyph_h_advance_func"] = _hb_font_funcs_set_glyph_h_advance_func = wasmExports2["hb_font_funcs_set_glyph_h_advance_func"];
          Module["_hb_font_funcs_set_glyph_v_advance_func"] = _hb_font_funcs_set_glyph_v_advance_func = wasmExports2["hb_font_funcs_set_glyph_v_advance_func"];
          Module["_hb_font_funcs_set_glyph_h_advances_func"] = _hb_font_funcs_set_glyph_h_advances_func = wasmExports2["hb_font_funcs_set_glyph_h_advances_func"];
          Module["_hb_font_funcs_set_glyph_v_advances_func"] = _hb_font_funcs_set_glyph_v_advances_func = wasmExports2["hb_font_funcs_set_glyph_v_advances_func"];
          Module["_hb_font_funcs_set_glyph_h_origin_func"] = _hb_font_funcs_set_glyph_h_origin_func = wasmExports2["hb_font_funcs_set_glyph_h_origin_func"];
          Module["_hb_font_funcs_set_glyph_v_origin_func"] = _hb_font_funcs_set_glyph_v_origin_func = wasmExports2["hb_font_funcs_set_glyph_v_origin_func"];
          Module["_hb_font_funcs_set_glyph_h_kerning_func"] = _hb_font_funcs_set_glyph_h_kerning_func = wasmExports2["hb_font_funcs_set_glyph_h_kerning_func"];
          Module["_hb_font_funcs_set_glyph_extents_func"] = _hb_font_funcs_set_glyph_extents_func = wasmExports2["hb_font_funcs_set_glyph_extents_func"];
          Module["_hb_font_funcs_set_glyph_name_func"] = _hb_font_funcs_set_glyph_name_func = wasmExports2["hb_font_funcs_set_glyph_name_func"];
          Module["_hb_font_funcs_set_glyph_from_name_func"] = _hb_font_funcs_set_glyph_from_name_func = wasmExports2["hb_font_funcs_set_glyph_from_name_func"];
          Module["_hb_font_get_h_extents"] = _hb_font_get_h_extents = wasmExports2["hb_font_get_h_extents"];
          Module["_hb_font_get_v_extents"] = _hb_font_get_v_extents = wasmExports2["hb_font_get_v_extents"];
          Module["_hb_font_get_glyph_h_advance"] = _hb_font_get_glyph_h_advance = wasmExports2["hb_font_get_glyph_h_advance"];
          Module["_hb_font_get_glyph_v_advance"] = _hb_font_get_glyph_v_advance = wasmExports2["hb_font_get_glyph_v_advance"];
          Module["_hb_font_get_glyph_h_origin"] = _hb_font_get_glyph_h_origin = wasmExports2["hb_font_get_glyph_h_origin"];
          Module["_hb_font_get_glyph_v_origin"] = _hb_font_get_glyph_v_origin = wasmExports2["hb_font_get_glyph_v_origin"];
          Module["_hb_font_get_glyph_extents"] = _hb_font_get_glyph_extents = wasmExports2["hb_font_get_glyph_extents"];
          Module["_hb_font_get_glyph_from_name"] = _hb_font_get_glyph_from_name = wasmExports2["hb_font_get_glyph_from_name"];
          Module["_hb_font_draw_glyph"] = _hb_font_draw_glyph = wasmExports2["hb_font_draw_glyph"];
          Module["_hb_font_glyph_to_string"] = _hb_font_glyph_to_string = wasmExports2["hb_font_glyph_to_string"];
          Module["_hb_font_create"] = _hb_font_create = wasmExports2["hb_font_create"];
          Module["_hb_font_set_variations"] = _hb_font_set_variations = wasmExports2["hb_font_set_variations"];
          Module["_hb_font_create_sub_font"] = _hb_font_create_sub_font = wasmExports2["hb_font_create_sub_font"];
          Module["_hb_font_reference"] = _hb_font_reference = wasmExports2["hb_font_reference"];
          Module["_hb_font_destroy"] = _hb_font_destroy = wasmExports2["hb_font_destroy"];
          Module["_hb_font_set_funcs"] = _hb_font_set_funcs = wasmExports2["hb_font_set_funcs"];
          Module["_hb_font_set_scale"] = _hb_font_set_scale = wasmExports2["hb_font_set_scale"];
          Module["_hb_ot_layout_get_glyph_class"] = _hb_ot_layout_get_glyph_class = wasmExports2["hb_ot_layout_get_glyph_class"];
          Module["_hb_ot_layout_table_get_script_tags"] = _hb_ot_layout_table_get_script_tags = wasmExports2["hb_ot_layout_table_get_script_tags"];
          Module["_hb_ot_layout_table_get_feature_tags"] = _hb_ot_layout_table_get_feature_tags = wasmExports2["hb_ot_layout_table_get_feature_tags"];
          Module["_hb_ot_layout_script_get_language_tags"] = _hb_ot_layout_script_get_language_tags = wasmExports2["hb_ot_layout_script_get_language_tags"];
          Module["_hb_ot_layout_language_get_feature_tags"] = _hb_ot_layout_language_get_feature_tags = wasmExports2["hb_ot_layout_language_get_feature_tags"];
          Module["_hb_ot_layout_feature_get_name_ids"] = _hb_ot_layout_feature_get_name_ids = wasmExports2["hb_ot_layout_feature_get_name_ids"];
          Module["_hb_ot_name_list_names"] = _hb_ot_name_list_names = wasmExports2["hb_ot_name_list_names"];
          Module["_hb_ot_name_get_utf16"] = _hb_ot_name_get_utf16 = wasmExports2["hb_ot_name_get_utf16"];
          Module["_hb_set_create"] = _hb_set_create = wasmExports2["hb_set_create"];
          Module["_hb_set_destroy"] = _hb_set_destroy = wasmExports2["hb_set_destroy"];
          Module["_hb_ot_tag_to_script"] = _hb_ot_tag_to_script = wasmExports2["hb_ot_tag_to_script"];
          Module["_hb_ot_tag_to_language"] = _hb_ot_tag_to_language = wasmExports2["hb_ot_tag_to_language"];
          Module["_hb_ot_var_get_axis_infos"] = _hb_ot_var_get_axis_infos = wasmExports2["hb_ot_var_get_axis_infos"];
          Module["_hb_set_get_population"] = _hb_set_get_population = wasmExports2["hb_set_get_population"];
          Module["_hb_set_next_many"] = _hb_set_next_many = wasmExports2["hb_set_next_many"];
          Module["_hb_shape"] = _hb_shape = wasmExports2["hb_shape"];
          __emscripten_timeout = wasmExports2["_emscripten_timeout"];
          __emscripten_stack_restore = wasmExports2["_emscripten_stack_restore"];
          __emscripten_stack_alloc = wasmExports2["_emscripten_stack_alloc"];
          _emscripten_stack_get_current = wasmExports2["emscripten_stack_get_current"];
        }
        var wasmImports = { _abort_js: __abort_js, _emscripten_runtime_keepalive_clear: __emscripten_runtime_keepalive_clear, _setitimer_js: __setitimer_js, emscripten_resize_heap: _emscripten_resize_heap, proc_exit: _proc_exit };
        var wasmExports = await createWasm();
        function run() {
          if (runDependencies > 0) {
            dependenciesFulfilled = run;
            return;
          }
          preRun();
          if (runDependencies > 0) {
            dependenciesFulfilled = run;
            return;
          }
          function doRun() {
            Module["calledRun"] = true;
            if (ABORT)
              return;
            initRuntime();
            readyPromiseResolve?.(Module);
            Module["onRuntimeInitialized"]?.();
            postRun();
          }
          if (Module["setStatus"]) {
            Module["setStatus"]("Running...");
            setTimeout(() => {
              setTimeout(() => Module["setStatus"](""), 1);
              doRun();
            }, 1);
          } else {
            doRun();
          }
        }
        function preInit() {
          if (Module["preInit"]) {
            if (typeof Module["preInit"] == "function")
              Module["preInit"] = [Module["preInit"]];
            while (Module["preInit"].length > 0) {
              Module["preInit"].shift()();
            }
          }
        }
        preInit();
        run();
        if (runtimeInitialized) {
          moduleRtn = Module;
        } else {
          moduleRtn = new Promise((resolve, reject) => {
            readyPromiseResolve = resolve;
            readyPromiseReject = reject;
          });
        }
        ;
        return moduleRtn;
      };
    })();
    if (typeof exports2 === "object" && typeof module === "object") {
      module.exports = createHarfBuzz;
      module.exports.default = createHarfBuzz;
    } else if (typeof define === "function" && define["amd"])
      define([], () => createHarfBuzz);
  }
});

// node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/index.js
var require_harfbuzzjs = __commonJS({
  "node_modules/.pnpm/harfbuzzjs@0.10.0/node_modules/harfbuzzjs/index.js"(exports2, module) {
    var hbjs = require_hbjs();
    var hb = require_hb();
    module.exports = new Promise(function(resolve, reject) {
      hb({ wasmBinary: harfbuzzWasm }).then((instance) => {
        resolve(hbjs(instance));
      }, reject);
    });
  }
});

// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/standalone.js
var import_escape_html = __toESM(require_escape_html(), 1);

// node_modules/.pnpm/linebreak@1.1.0/node_modules/linebreak/dist/module.mjs
var import_unicode_trie = __toESM(require_unicode_trie(), 1);
var import_base64_js = __toESM(require_b64(), 1);
var $557adaaeb0c7885f$exports = {};
var $1627905f8be2ef3f$export$fb4028874a74450 = 5;
var $1627905f8be2ef3f$export$1bb1140fe1358b00 = 12;
var $1627905f8be2ef3f$export$f3e416a182673355 = 13;
var $1627905f8be2ef3f$export$24aa617c849a894a = 16;
var $1627905f8be2ef3f$export$a73c4d14459b698d = 17;
var $1627905f8be2ef3f$export$9e5d732f3676a9ba = 22;
var $1627905f8be2ef3f$export$1dff41d5c0caca01 = 28;
var $1627905f8be2ef3f$export$30a74a373318dec6 = 31;
var $1627905f8be2ef3f$export$d710c5f50fc7496a = 33;
var $1627905f8be2ef3f$export$66498d28055820a9 = 34;
var $1627905f8be2ef3f$export$eb6c6d0b7c8826f2 = 35;
var $1627905f8be2ef3f$export$de92be486109a1df = 36;
var $1627905f8be2ef3f$export$606cfc2a8896c91f = 37;
var $1627905f8be2ef3f$export$e51d3c675bb0140d = 38;
var $1627905f8be2ef3f$export$da51c6332ad11d7b = 39;
var $1627905f8be2ef3f$export$bea437c40441867d = 40;
var $1627905f8be2ef3f$export$c4c7eecbfed13dc9 = 41;
var $1627905f8be2ef3f$export$98e1f8a379849661 = 42;
var $32627af916ac1b00$export$98f50d781a474745 = 0;
var $32627af916ac1b00$export$12ee1f8f5315ca7e = 1;
var $32627af916ac1b00$export$e4965ce242860454 = 2;
var $32627af916ac1b00$export$8f14048969dcd45e = 3;
var $32627af916ac1b00$export$133eb141bf58aff4 = 4;
var $32627af916ac1b00$export$5bdb8ccbf5c57afc = [
  //OP   , CL    , CP    , QU    , GL    , NS    , EX    , SY    , IS    , PR    , PO    , NU    , AL    , HL    , ID    , IN    , HY    , BA    , BB    , B2    , ZW    , CM    , WJ    , H2    , H3    , JL    , JV    , JT    , RI    , EB    , EM    , ZWJ   , CB
  [
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$8f14048969dcd45e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ],
  [
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$e4965ce242860454,
    $32627af916ac1b00$export$133eb141bf58aff4,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$98f50d781a474745,
    $32627af916ac1b00$export$12ee1f8f5315ca7e,
    $32627af916ac1b00$export$98f50d781a474745
  ]
  // CB
];
var $557adaaeb0c7885f$var$data = import_base64_js.default.toByteArray("AAgOAAAAAAAQ4QAAAQ0P8vDtnQuMXUUZx+eyu7d7797d9m5bHoWltKVUlsjLWE0VJNigQoMVqkStEoNQQUl5GIo1KKmogEgqkKbBRki72lYabZMGKoGAjQRtJJDaCCIRiiigREBQS3z+xzOTnZ3O+3HOhd5NfpkzZx7fN9988zivu2M9hGwB28F94DnwEngd/Asc1EtIs9c/bIPDwCxwLDgezHcodyo4w5C+CCwBS8FnwSXgCnA1uFbI93XwbXAbWAfWgx+CzWAb+An4KfgFeAzsYWWfYuFz4CXwGvgb+Dfo6yNkEEwGh4CZYB44FpwI3g1OY+kfBItZOo2fB84Hy8DF4HJwNbiWpV8PVoO1LH4n2NRXyN+KcAd4kNVP9XsY4aPgcfAbsBfs6SniL4K/sPjfEf6HlanXCRkCw2BGvUh/keWfXS/CY+pFXs7x9XHmM94LTmWIeU2cgbxnS/k/B3kf86jDhU8L9V2E40vAFWAlWFUfb++NOL4F3C7JX4/4GiE+hvgWsF0oS7mXldspnN+F493gyXrh9xTav0cg3EvzgVfBG6wsmVSEkxBOBgdPGpd7JI6PnqRvJ68/xlbHof53gPeA94OzwLngk+ACsAwsByvASrAK3MB0Ws3CtQjvBJvAVrADPMDSHkb4CNijaccTwvnf4fiPEs8Lxy+D18A/QU8/xjgYBjPAbDAKTgYLwOngTHAO+EQ/8wuEF4EvsPiVCFf2+9tsFStzA8LVHuXXBsi6QyqzUYiPMR/7Mc7dAx7oL8bzw/3u/Bw8Bp4Az4AXwCtgHzsmDXP5fiF9iiVvly5d0sHngar16NKlS5cuXbp06fLmYlqHXrcd3ph4P0THUY3iXh49novju4S0tzfs5d+JPKewfAsRntZb3K9ZhOMlrO6lCC8An28U9+OuovcPcPxlVu5rCL/VmHh/iHIrzn3fIPu7SN8Axmg+8AOwEWwCm7tp3bRuWjetm5Y8bSu4B9zbKO6ZVsnORrVU3f4uXTqZ2H3sLoyx3eDXjfDndE9qyj6L838CfwVvgFpzYnof4oNgOhgBc8Fos9DrZIQLmtXPP1MmF6wGj4H+KXoWguvADkXaPil+YpuQy8Am8Ey7ODdtmJDF4HowBp4De6HDTNjhfHAHeBr0DBBy0kDxfPbcgSIusgrcWhtnJ8vL+TPix7UIOQtcBq4C28Cr4KRBnANbwSuDE+s50JgyNNFuXbp06XIgsXjIvPafjvXozKY+fVFz/z0LT1uCtKVSWbrOLWPnztG8e0Xfy7ol8XtZJi7WtG+5od2UFXQ/A12vUeS7jp27yVKHjdsU9lXB869TyNvAzt0lpP2oWbwLdjiO78bx/Sz+EMJHwK9Y/LcIfw+eZ3F67/Hl5vh9xX80J+rwX8SvRDhpgL17iPAQMHNArfPrqHPewLheI+AERV6efwV418B4nOZ/H+IfYHV8GOF5LJ3eAz0fx8sM9S0fUNud39O9CulfGZhY5huI3wzWgNvBelbHZoTbNPVpfYjKQpkHwUNgl0LWblbnk0LbbDxr0OMFpL3iqWdu9nWYPlVAWkXY39LnGdCkDbeqv1YNbfcMQ3t9oe8lzm6NH9N1ZB6Ln4BwfkJZJk7RyFnYKt6b/JDQXx9p5X+eFdqOjzM9P9MB/lUlFzr20aXIdzlY4dmn9F3YqtvoO76/2hp/D/xA5Zue88nNyL8GbFbs075X0tyUig3Qd2MCnf//HjnzpbsR3g9+1kHzzVjdnE71/qVBX9rGPUh/ysNWe1neFzvIDi5zAufV1sT0N0poR22wkFUfTOPfA4N2mbZ5fSrqOHSw+IbkSBbOGSzSRgf91/GTUWYBOB2cIZQ/G8cfBZ8CFwrnL8XxF8FKcA24jqXdiPA7Qr61OF7H4mMItwzuv2/YLth1ISt3Hzu3k4W7EH5JqPdRHD/O4k+z8A8IX5Lq3y7Z4nXE9xn6kX6vQ4bKfy+ok+hH+xf3hq9dnTTHhjKd2GmDuWA242iHMq4cC7A8kJ7i8o1+skSa7Jieo38HCWnoNjKFhdSFBxzpZ7QE6lI8N4S14aASZcryaV/WWHw66f6NHuCoxuQxmvM56GX9QMd8Q4D65ywGP+ZzRJuM+zQvx/MOS2VFeqQ4IXnH26zM9Xe6/E6D+4foAzzuajPZp8Qyw5ayZVDWuH0z0BtYRkeIDqH9KO9VbH1btd/lhNqCzvl8zeLnG0S/hnU6baHfpiuO6yy0rd+DHURo/zYF5H26j03rQsip2ndzz82u1z9N4VjWKWeb68Tedpt95HRVXp7H1R6p+/Wt4FPy/PpWwscOLRJ+PVWF/+W0iVyGzs18TIvXkOJ1Wxm66vSXz+vylenrZcj1ub439W+K8RNCGTJi2p/TJ1K23VaXr35tRpnzmjxequgfcfyk6B/TGBVlyedsNgpdd/h+W1U3P99QyFPNo1X3TwpM/WLTIWYfoBqXrv6iskHZ/RFr79R6hIyHBrH3f1nrUVnjP8SnZZ+rYtzr9Exld5MNbPNErusAPg+77u/eDOPftU9yj39TH7rezxd1LvsZQJlzkWlOirG/79zjMj/mtHUKu7vKy+3/LnXr9okyKedjX5/0He9iP/j63LwOQdarEVlfy8OO/Lqw023j6xcqmwxLiOd6heM2i9cV9LJy8jMJ23yQ+rpbfu7EQ/pXE8KYvUSqvVnb4XzZa6LrHMXHR+zcLvqWbm/Bn0/HzIs6fWPHoat8XfnDKmZGxRxeMbn2UqZ5Q94nmcZRbqqUXbZ8+lcjE+cPX11t814orvvAXNcG8vqj2vvk1MGn3anlj0bIT72v47bvE+Lc98T9b6r7AKn6j+8Duf7D0nnZx/j7Zjn0j9nbpSTndaLr9WNLivP+iN23xF7L+fqv6ZouFyb78jxVXvv5jJ9YUs9/sddO8h7KNg5jrhfaJGztT6G7KF+1d6yCmD5Kdb2fan60rSc552fZr3zeQ9DpnPp+Si5cx5Ktv2QfSzF/mMbWdOm46rFI4XstnU9xeqX4NKb7TKEdcr6pZOK3ID1k/LvFHkVczEuZLEDr499YqvqBym1aEHWgcvoYOtv0M91qQl5TfpO/in6rWx8OVpT1Wedkv3f5xom3T/xeR/6Gx6V86PWAOB4bBpqWdN+yTcVxjIyGRz/FrDGu6w/3d7kPm8StX8RyPu+uuvpNju/vTLJV37GpvoM0oZPnW87VLnL/5pDno1NoW1R6yedU6TyUv3u19a3KFnIbTLYz+ZCLP4T0tU1uivFgso0pnsJ/UtXvarNY28Xq5cvkBDrQP/E5ZaiuQwwfmTlsOiQRU1fMuqrDd/3ISSuwjOwXOfTyGUMpZIXq4GpLn3pUcdfzch2x7XO1u2uZHOPb1G6b3Xg9PH1IIWeEpJlPQtqos2EKW8b0u8rnuP1UeVLoXJb9be0uG9nnbchjU+XTszT5VeNBThPHnc5OKj1U9aj0GTHIVaGy1YhEWT4ixns00DT+XEzWn/7VAsIc63Cov3OdyhwjrnaqQqZvWKXdypRdlq+k8msZ031U+Rm4fA+3TtyeR9hwfW9G9yxDN0fZMN33F+9TE6md4hwoxumfaUzI9fN3PFT3xVV2msrQ3UsnChm6Nulk8TndpS28D3zX9tTIPsF/z7Am5OkTjm1tI1JZW74+4VgsZ0N3L1yXV3WeP5uR7TGHHdvC3JQlxybfpd22tDlk/2eofRK8TzrN/qnar/K/OUTth6I/+jAnEptNbPvFHP2gs40N3+dfMWtwqvVct7/wfd8gtQ7imifial9ZJ9/3IHLYU6eDj3+4PhsNhX+vwvcWLnu6kGfEMe8DuciPfUfGZB8X/7HJy/Gefe5n+VRGFd/wyP2ta7/LO4yh/sbLV/k9lev6kfO9Dt/5U67b1/6u/epqB1U9Me23jfHY9sscAg4tkbLl+e4/U36rJ9ddxfd6sg5vq5ice42Wpk/pb9FOJ36/W9tpv4kbC79nUbZceX8Zu6/qJ+P3WvhvA8v3reh7Jbn2d6rrNC7XNZTLma4Ba0JI9efX2uLzF5scG/w9UNU1ZxW+ymUfzELeTllXlQ1rUuhzjS5fp9c964iFBOqeSz63bU065nZKdU+mDEz3qHIjjifquw0pnb/raRtvrnsYcb46ihT3taoYz6brdNW9l6rWRnE/navdPn1XlR1km7hcz1WlH/elKuSOSvLLuE8U6m8uzwRdfcGl73VyTHuyMvzJ1Sa2cWDTP/Z63Kc94n2B1PYr24dz1JlyHLlcP+S4B6vD1c9EW4q2LWstCvUjeVy63k/LMYdUNd5D1xQfvVTzX1VjkMsUv88N8VH5fReVn/Fjn++/h6X6Q8a6b1/q3g/i/ewi0/Scs8zxXeV6mWIOUPlPzBgdFerW+bZrm2P18dnjuK6HunEp+rHvPMXbr+sHVb/lnL+pTP57jPw9Cvk3PW178JD9qChfzuvTf7Htl38L1QUf/VKu9SFjwWbTWPvFEvu7Uq76y7+31g6QlYPc669pbsm9Xur2LWI9Pu8ypfDXqm3A2z8s1FWGn4ntL9NfQu2oSlftX9uetvTtv7J8Ql4zxfXGZ3zk8PeQ9w59x2uMfqI8/q5eKh/l9cb2rwsu9rSNl06ZP2Pmxtz+rNMx93yno0n2/82rVH7rQ+y9P15H6FyRun9ViH81ATmffI7nJ5r8uXXW6enbP6b/B8/l5OifVHYLnb9S39s2zcc+Ph+rh8+eQgVPS72elzGWY/tUtbbabBpDiI7yN1q6/4th2y+ErAc5+9BVvu/7KamJbWNZeuqI/R4tRf+YyD1HmOZM1bMV3/14Sn10c0Xu+Sj1nOXb5jL73ncdy02uvlXZNde65dOHYl7Vs4KYuS6FzWLn2zJlpZqPXPVPOa5yzKOyn1VhT9lmMfdbfH7D11Wf2PXN5h9y+dD287+qxgSnaYmnIrRtIb8pJe6/Uv9OVer6Whn0zfGO/BEloZI9ojmfAlUflClDd178bTmVHVTpZXOkAlk/lb42UujmI89HH5V+cl7XtowY6vTxLVWok6UrGzoGTHN+bB+6ri05687VNpvfuvRfaP2uMlNQth1D5JjGelm/8yn+9p3p/7qk9gnfeddXZmq/Sm333PJT659Kv1zjNbZ9uv2Oi//67CV8/N1nj1DmviyXDNVeJkaeaX8UsyesYg8cu2+NvdaPfb+lLDu5tvt/");
var $557adaaeb0c7885f$var$classTrie = new import_unicode_trie.default($557adaaeb0c7885f$var$data);
var $557adaaeb0c7885f$var$mapClass = function(c2) {
  switch (c2) {
    case $1627905f8be2ef3f$export$d710c5f50fc7496a:
      return $1627905f8be2ef3f$export$1bb1140fe1358b00;
    case $1627905f8be2ef3f$export$da51c6332ad11d7b:
    case $1627905f8be2ef3f$export$bea437c40441867d:
    case $1627905f8be2ef3f$export$98e1f8a379849661:
      return $1627905f8be2ef3f$export$1bb1140fe1358b00;
    case $1627905f8be2ef3f$export$eb6c6d0b7c8826f2:
      return $1627905f8be2ef3f$export$fb4028874a74450;
    default:
      return c2;
  }
};
var $557adaaeb0c7885f$var$mapFirst = function(c2) {
  switch (c2) {
    case $1627905f8be2ef3f$export$606cfc2a8896c91f:
    case $1627905f8be2ef3f$export$e51d3c675bb0140d:
      return $1627905f8be2ef3f$export$66498d28055820a9;
    case $1627905f8be2ef3f$export$c4c7eecbfed13dc9:
      return $1627905f8be2ef3f$export$9e5d732f3676a9ba;
    default:
      return c2;
  }
};
var $557adaaeb0c7885f$var$Break = class {
  constructor(position, required = false) {
    this.position = position;
    this.required = required;
  }
};
var $557adaaeb0c7885f$var$LineBreaker = class {
  nextCodePoint() {
    const code = this.string.charCodeAt(this.pos++);
    const next = this.string.charCodeAt(this.pos);
    if (55296 <= code && code <= 56319 && 56320 <= next && next <= 57343) {
      this.pos++;
      return (code - 55296) * 1024 + (next - 56320) + 65536;
    }
    return code;
  }
  nextCharClass() {
    return $557adaaeb0c7885f$var$mapClass($557adaaeb0c7885f$var$classTrie.get(this.nextCodePoint()));
  }
  getSimpleBreak() {
    switch (this.nextClass) {
      case $1627905f8be2ef3f$export$c4c7eecbfed13dc9:
        return false;
      case $1627905f8be2ef3f$export$66498d28055820a9:
      case $1627905f8be2ef3f$export$606cfc2a8896c91f:
      case $1627905f8be2ef3f$export$e51d3c675bb0140d:
        this.curClass = $1627905f8be2ef3f$export$66498d28055820a9;
        return false;
      case $1627905f8be2ef3f$export$de92be486109a1df:
        this.curClass = $1627905f8be2ef3f$export$de92be486109a1df;
        return false;
    }
    return null;
  }
  getPairTableBreak(lastClass) {
    let shouldBreak = false;
    switch ($32627af916ac1b00$export$5bdb8ccbf5c57afc[this.curClass][this.nextClass]) {
      case $32627af916ac1b00$export$98f50d781a474745:
        shouldBreak = true;
        break;
      case $32627af916ac1b00$export$12ee1f8f5315ca7e:
        shouldBreak = lastClass === $1627905f8be2ef3f$export$c4c7eecbfed13dc9;
        break;
      case $32627af916ac1b00$export$e4965ce242860454:
        shouldBreak = lastClass === $1627905f8be2ef3f$export$c4c7eecbfed13dc9;
        if (!shouldBreak) {
          shouldBreak = false;
          return shouldBreak;
        }
        break;
      case $32627af916ac1b00$export$8f14048969dcd45e:
        if (lastClass !== $1627905f8be2ef3f$export$c4c7eecbfed13dc9)
          return shouldBreak;
        break;
      case $32627af916ac1b00$export$133eb141bf58aff4:
        break;
    }
    if (this.LB8a)
      shouldBreak = false;
    if (this.LB21a && (this.curClass === $1627905f8be2ef3f$export$24aa617c849a894a || this.curClass === $1627905f8be2ef3f$export$a73c4d14459b698d)) {
      shouldBreak = false;
      this.LB21a = false;
    } else
      this.LB21a = this.curClass === $1627905f8be2ef3f$export$f3e416a182673355;
    if (this.curClass === $1627905f8be2ef3f$export$1dff41d5c0caca01) {
      this.LB30a++;
      if (this.LB30a == 2 && this.nextClass === $1627905f8be2ef3f$export$1dff41d5c0caca01) {
        shouldBreak = true;
        this.LB30a = 0;
      }
    } else
      this.LB30a = 0;
    this.curClass = this.nextClass;
    return shouldBreak;
  }
  nextBreak() {
    if (this.curClass == null) {
      let firstClass = this.nextCharClass();
      this.curClass = $557adaaeb0c7885f$var$mapFirst(firstClass);
      this.nextClass = firstClass;
      this.LB8a = firstClass === $1627905f8be2ef3f$export$30a74a373318dec6;
      this.LB30a = 0;
    }
    while (this.pos < this.string.length) {
      this.lastPos = this.pos;
      const lastClass = this.nextClass;
      this.nextClass = this.nextCharClass();
      if (this.curClass === $1627905f8be2ef3f$export$66498d28055820a9 || this.curClass === $1627905f8be2ef3f$export$de92be486109a1df && this.nextClass !== $1627905f8be2ef3f$export$606cfc2a8896c91f) {
        this.curClass = $557adaaeb0c7885f$var$mapFirst($557adaaeb0c7885f$var$mapClass(this.nextClass));
        return new $557adaaeb0c7885f$var$Break(this.lastPos, true);
      }
      let shouldBreak = this.getSimpleBreak();
      if (shouldBreak === null)
        shouldBreak = this.getPairTableBreak(lastClass);
      this.LB8a = this.nextClass === $1627905f8be2ef3f$export$30a74a373318dec6;
      if (shouldBreak)
        return new $557adaaeb0c7885f$var$Break(this.lastPos);
    }
    if (this.lastPos < this.string.length) {
      this.lastPos = this.string.length;
      return new $557adaaeb0c7885f$var$Break(this.string.length);
    }
    return null;
  }
  constructor(string) {
    this.string = string;
    this.pos = 0;
    this.lastPos = 0;
    this.curClass = null;
    this.nextClass = null;
    this.LB8a = false;
    this.LB21a = false;
    this.LB30a = 0;
  }
};
$557adaaeb0c7885f$exports = $557adaaeb0c7885f$var$LineBreaker;

// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/standalone.js
var import_css_to_react_native = __toESM(require_css_to_react_native(), 1);
var import_css_background_parser = __toESM(require_css_background_parser(), 1);
var import_css_box_shadow = __toESM(require_css_box_shadow(), 1);

// node_modules/.pnpm/parse-css-color@0.2.1/node_modules/parse-css-color/dist/index.esm.js
var import_color_name = __toESM(require_color_name());
var import_hex_rgb = __toESM(require_hex_rgb());
var pattern = /^#([a-f0-9]{3,4}|[a-f0-9]{4}(?:[a-f0-9]{2}){1,2})\b$/;
var hexRe = new RegExp(pattern, "i");
var float = "-?\\d*(?:\\.\\d+)";
var number = `(${float}?)`;
var percentage = `(${float}?%)`;
var numberOrPercentage = `(${float}?%?)`;
var pattern$1 = `^
  hsla?\\(
    \\s*(-?\\d*(?:\\.\\d+)?(?:deg|rad|turn)?)\\s*,
    \\s*${percentage}\\s*,
    \\s*${percentage}\\s*
    (?:,\\s*${numberOrPercentage}\\s*)?
  \\)
  $
`.replace(/\n|\s/g, "");
var hsl3Re = new RegExp(pattern$1);
var pattern$2 = `^
  hsla?\\(
    \\s*(-?\\d*(?:\\.\\d+)?(?:deg|rad|turn)?)\\s*
    \\s+${percentage}
    \\s+${percentage}
    \\s*(?:\\s*\\/\\s*${numberOrPercentage}\\s*)?
  \\)
  $
`.replace(/\n|\s/g, "");
var hsl4Re = new RegExp(pattern$2);
var pattern$3 = `^
  rgba?\\(
    \\s*${number}\\s*,
    \\s*${number}\\s*,
    \\s*${number}\\s*
    (?:,\\s*${numberOrPercentage}\\s*)?
  \\)
  $
`.replace(/\n|\s/g, "");
var rgb3NumberRe = new RegExp(pattern$3);
var pattern$4 = `^
  rgba?\\(
    \\s*${percentage}\\s*,
    \\s*${percentage}\\s*,
    \\s*${percentage}\\s*
    (?:,\\s*${numberOrPercentage}\\s*)?
  \\)
  $
`.replace(/\n|\s/g, "");
var rgb3PercentageRe = new RegExp(pattern$4);
var pattern$5 = `^
  rgba?\\(
    \\s*${number}
    \\s+${number}
    \\s+${number}
    \\s*(?:\\s*\\/\\s*${numberOrPercentage}\\s*)?
  \\)
$
`.replace(/\n|\s/g, "");
var rgb4NumberRe = new RegExp(pattern$5);
var pattern$6 = `^
  rgba?\\(
    \\s*${percentage}
    \\s+${percentage}
    \\s+${percentage}
    \\s*(?:\\s*\\/\\s*${numberOrPercentage}\\s*)?
  \\)
$
`.replace(/\n|\s/g, "");
var rgb4PercentageRe = new RegExp(pattern$6);
var pattern$7 = /^transparent$/;
var transparentRe = new RegExp(pattern$7, "i");
var clamp = (num, min, max3) => Math.min(Math.max(min, num), max3);
var parseRGB = (num) => {
  let n = num;
  if (typeof n !== "number")
    n = n.endsWith("%") ? parseFloat(n) * 255 / 100 : parseFloat(n);
  return clamp(Math.round(n), 0, 255);
};
var parsePercentage = (percentage2) => clamp(parseFloat(percentage2), 0, 100);
function parseAlpha(alpha) {
  let a = alpha;
  if (typeof a !== "number")
    a = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  return clamp(a, 0, 1);
}
function getHEX(hex) {
  const [r, g2, b, a] = (0, import_hex_rgb.default)(hex, { format: "array" });
  return getRGB([null, ...[r, g2, b, a]]);
}
function getHSL([, h2, s, l2, a = 1]) {
  let hh = h2;
  if (hh.endsWith("turn")) {
    hh = parseFloat(hh) * 360 / 1;
  } else if (hh.endsWith("rad")) {
    hh = Math.round(parseFloat(hh) * 180 / Math.PI);
  } else {
    hh = parseFloat(hh);
  }
  return {
    type: "hsl",
    values: [hh, parsePercentage(s), parsePercentage(l2)],
    alpha: parseAlpha(a === null ? 1 : a)
  };
}
function getRGB([, r, g2, b, a = 1]) {
  return {
    type: "rgb",
    values: [r, g2, b].map(parseRGB),
    alpha: parseAlpha(a === null ? 1 : a)
  };
}
var parseCSSColor = (str) => {
  if (typeof str !== "string")
    return null;
  const hex = hexRe.exec(str);
  if (hex)
    return getHEX(hex[0]);
  const hsl = hsl4Re.exec(str) || hsl3Re.exec(str);
  if (hsl)
    return getHSL(hsl);
  const rgb = rgb4NumberRe.exec(str) || rgb4PercentageRe.exec(str) || rgb3NumberRe.exec(str) || rgb3PercentageRe.exec(str);
  if (rgb)
    return getRGB(rgb);
  if (transparentRe.exec(str))
    return getRGB([null, 0, 0, 0, 0]);
  const cn = import_color_name.default[str.toLowerCase()];
  if (cn)
    return getRGB([null, cn[0], cn[1], cn[2], 1]);
  return null;
};
var index_esm_default = parseCSSColor;

// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/standalone.js
var import_postcss_value_parser = __toESM(require_lib(), 1);
var import_css_to_react_native2 = __toESM(require_css_to_react_native(), 1);
var import_postcss_value_parser2 = __toESM(require_lib(), 1);
var import_escape_html2 = __toESM(require_escape_html(), 1);

// node_modules/.pnpm/css-gradient-parser@0.0.17/node_modules/css-gradient-parser/dist/index.js
function c(e, o = ",") {
  let t = [], n = 0, i = 0;
  o = new RegExp(o);
  for (let r = 0; r < e.length; r++)
    e[r] === "(" ? i++ : e[r] === ")" && i--, i === 0 && o.test(e[r]) && (t.push(e.slice(n, r).trim()), n = r + 1);
  return t.push(e.slice(n).trim()), t;
}
function g(e) {
  let o = [];
  for (let t = 0, n = e.length; t < n; ) {
    let [i, r] = c(e[t], /\s+/);
    m(e[t + 1]) ? (o.push({ color: i, offset: l(r), hint: l(e[t + 1]) }), t += 2) : (o.push({ color: i, offset: l(r) }), t++);
  }
  return o;
}
var u = /^(-?\d+\.?\d*)(%|vw|vh|px|em|rem|deg|rad|grad|turn|ch|vmin|vmax)?$/;
function m(e) {
  return u.test(e);
}
function l(e) {
  if (!e)
    return;
  let [, o, t] = e.trim().match(u) || [];
  return { value: o, unit: t ?? "px" };
}
function P(e) {
  if (!/^(repeating-)?linear-gradient/.test(e))
    throw new SyntaxError(`could not find syntax for this item: ${e}`);
  let [, o, t] = e.match(/(repeating-)?linear-gradient\((.+)\)/), n = { orientation: { type: "directional", value: "bottom" }, repeating: !!o, stops: [] }, i = c(t), r = x(i[0]);
  return r && (n.orientation = r, i.shift()), { ...n, stops: g(i) };
}
function x(e) {
  return e.startsWith("to ") ? { type: "directional", value: e.replace("to ", "") } : ["turn", "deg", "grad", "rad"].some((o) => e.endsWith(o)) ? { type: "angular", value: l(e) } : null;
}
var v = /* @__PURE__ */ new Set(["closest-corner", "closest-side", "farthest-corner", "farthest-side"]);
var w = /* @__PURE__ */ new Set(["center", "left", "top", "right", "bottom"]);
function d(e) {
  return v.has(e);
}
function h(e) {
  return w.has(e);
}
function R(e) {
  let o = Array(2).fill("");
  for (let t = 0; t < 2; t++)
    e[t] ? o[t] = e[t] : o[t] = "center";
  return o;
}
function K(e) {
  if (!/(repeating-)?radial-gradient/.test(e))
    throw new SyntaxError(`could not find syntax for this item: ${e}`);
  let [, o, t] = e.match(/(repeating-)?radial-gradient\((.+)\)/), n = { shape: "ellipse", repeating: !!o, size: [{ type: "keyword", value: "farthest-corner" }], position: { x: { type: "keyword", value: "center" }, y: { type: "keyword", value: "center" } }, stops: [] }, i = c(t);
  if (S(i[0]))
    return { ...n, stops: g(i) };
  let r = i[0].split("at").map((f) => f.trim()), p = ((r[0] || "").match(/(circle|ellipse)/) || [])[1], a = (r[0] || "").match(/(-?\d+\.?\d*(vw|vh|px|em|rem|%|rad|grad|turn|deg)?|closest-corner|closest-side|farthest-corner|farthest-side)/g) || [], s = R((r[1] || "").split(" "));
  return p ? n.shape = p : a.length === 1 && !d(a[0]) ? n.shape = "circle" : n.shape = "ellipse", a.length === 0 && a.push("farthest-corner"), n.size = a.map((f) => d(f) ? { type: "keyword", value: f } : { type: "length", value: l(f) }), n.position.x = h(s[0]) ? { type: "keyword", value: s[0] } : { type: "length", value: l(s[0]) }, n.position.y = h(s[1]) ? { type: "keyword", value: s[1] } : { type: "length", value: l(s[1]) }, (p || a.length > 0 || r[1]) && i.shift(), { ...n, stops: g(i) };
}
function S(e) {
  return /(circle|ellipse|at)/.test(e) ? false : /^(rgba?|hwb|hsl|lab|lch|oklab|color|#|[a-zA-Z]+)/.test(e);
}

// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/standalone.js
var import_css_to_react_native3 = __toESM(require_css_to_react_native(), 1);

// node_modules/.pnpm/@shuding+opentype.js@1.4.0-beta.0/node_modules/@shuding/opentype.js/dist/opentype.module.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var u32 = Uint32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new u32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return [b, r];
};
var _a = freb(fleb, 2);
var fl = _a[0];
var revfl = _a[1];
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b[0];
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x2 = (i & 43690) >>> 1 | (i & 21845) << 1;
  x2 = (x2 & 52428) >>> 2 | (x2 & 13107) << 2;
  x2 = (x2 & 61680) >>> 4 | (x2 & 3855) << 4;
  rev[i] = ((x2 & 65280) >>> 8 | (x2 & 255) << 8) >>> 1;
}
var x2;
var i;
var hMap = function(cd2, mb, r) {
  var s = cd2.length;
  var i = 0;
  var l2 = new u16(mb);
  for (; i < s; ++i) {
    if (cd2[i]) {
      ++l2[cd2[i] - 1];
    }
  }
  var le = new u16(mb);
  for (i = 0; i < mb; ++i) {
    le[i] = le[i - 1] + l2[i - 1] << 1;
  }
  var co2;
  if (r) {
    co2 = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd2[i]) {
        var sv2 = i << 4 | cd2[i];
        var r_1 = mb - cd2[i];
        var v2 = le[cd2[i] - 1]++ << r_1;
        for (var m2 = v2 | (1 << r_1) - 1; v2 <= m2; ++v2) {
          co2[rev[v2] >>> rvb] = sv2;
        }
      }
    }
  } else {
    co2 = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd2[i]) {
        co2[i] = rev[le[cd2[i] - 1]++] >>> 15 - cd2[i];
      }
    }
  }
  return co2;
};
var flt = new u8(288);
for (i = 0; i < 144; ++i) {
  flt[i] = 8;
}
var i;
for (i = 144; i < 256; ++i) {
  flt[i] = 9;
}
var i;
for (i = 256; i < 280; ++i) {
  flt[i] = 7;
}
var i;
for (i = 280; i < 288; ++i) {
  flt[i] = 8;
}
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i) {
  fdt[i] = 5;
}
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m2 = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m2) {
      m2 = a[i];
    }
  }
  return m2;
};
var bits = function(d2, p, m2) {
  var o = p / 8 | 0;
  return (d2[o] | d2[o + 1] << 8) >> (p & 7) & m2;
};
var bits16 = function(d2, p) {
  var o = p / 8 | 0;
  return (d2[o] | d2[o + 1] << 8 | d2[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v2, s, e) {
  if (s == null || s < 0) {
    s = 0;
  }
  if (e == null || e > v2.length) {
    e = v2.length;
  }
  var n = new (v2.BYTES_PER_ELEMENT == 2 ? u16 : v2.BYTES_PER_ELEMENT == 4 ? u32 : u8)(e - s);
  n.set(v2.subarray(s, e));
  return n;
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(e, err);
  }
  if (!nt) {
    throw e;
  }
  return e;
};
var inflt = function(dat, buf, st) {
  var sl2 = dat.length;
  if (!sl2 || st && st.f && !st.l) {
    return buf || new u8(0);
  }
  var noBuf = !buf || st;
  var noSt = !st || st.i;
  if (!st) {
    st = {};
  }
  if (!buf) {
    buf = new u8(sl2 * 3);
  }
  var cbuf = function(l3) {
    var bl = buf.length;
    if (l3 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l3));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl2 * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l2 = dat[s - 4] | dat[s - 3] << 8, t = s + l2;
        if (t > sl2) {
          if (noSt) {
            err(0);
          }
          break;
        }
        if (noBuf) {
          cbuf(bt + l2);
        }
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l2, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1) {
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      } else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl2 = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl2);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl2; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >>> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c2 = 0, n = 0;
            if (s == 16) {
              n = 3 + bits(dat, pos, 3), pos += 2, c2 = ldt[i - 1];
            } else if (s == 17) {
              n = 3 + bits(dat, pos, 7), pos += 3;
            } else if (s == 18) {
              n = 11 + bits(dat, pos, 127), pos += 7;
            }
            while (n--) {
              ldt[i++] = c2;
            }
          }
        }
        var lt = ldt.subarray(0, hLit), dt2 = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt2);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt2, dbt, 1);
      } else {
        err(1);
      }
      if (pos > tbts) {
        if (noSt) {
          err(0);
        }
        break;
      }
    }
    if (noBuf) {
      cbuf(bt + 131072);
    }
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c2 = lm[bits16(dat, pos) & lms], sym = c2 >>> 4;
      pos += c2 & 15;
      if (pos > tbts) {
        if (noSt) {
          err(0);
        }
        break;
      }
      if (!c2) {
        err(2);
      }
      if (sym < 256) {
        buf[bt++] = sym;
      } else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d2 = dm[bits16(dat, pos) & dms], dsym = d2 >>> 4;
        if (!d2) {
          err(3);
        }
        pos += d2 & 15;
        var dt2 = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt2 += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt) {
            err(0);
          }
          break;
        }
        if (noBuf) {
          cbuf(bt + 131072);
        }
        var end = bt + add;
        for (; bt < end; bt += 4) {
          buf[bt] = buf[bt - dt2];
          buf[bt + 1] = buf[bt + 1 - dt2];
          buf[bt + 2] = buf[bt + 2 - dt2];
          buf[bt + 3] = buf[bt + 3 - dt2];
        }
        bt = end;
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm) {
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    }
  } while (!final);
  return bt == buf.length ? buf : slc(buf, 0, bt);
};
var et = /* @__PURE__ */ new u8(0);
function inflateSync(data, out) {
  return inflt(data, out);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
function Path() {
  this.commands = [];
  this.fill = "black";
  this.stroke = null;
  this.strokeWidth = 1;
}
Path.prototype.moveTo = function(x2, y) {
  this.commands.push({
    type: "M",
    x: x2,
    y
  });
};
Path.prototype.lineTo = function(x2, y) {
  this.commands.push({
    type: "L",
    x: x2,
    y
  });
};
Path.prototype.curveTo = Path.prototype.bezierCurveTo = function(x1, y1, x2, y2, x3, y) {
  this.commands.push({
    type: "C",
    x1,
    y1,
    x2,
    y2,
    x: x3,
    y
  });
};
Path.prototype.quadTo = Path.prototype.quadraticCurveTo = function(x1, y1, x2, y) {
  this.commands.push({
    type: "Q",
    x1,
    y1,
    x: x2,
    y
  });
};
Path.prototype.close = Path.prototype.closePath = function() {
  this.commands.push({
    type: "Z"
  });
};
Path.prototype.extend = function(pathOrCommands) {
  if (pathOrCommands.commands) {
    pathOrCommands = pathOrCommands.commands;
  }
  Array.prototype.push.apply(this.commands, pathOrCommands);
};
Path.prototype.toPathData = function(decimalPlaces) {
  decimalPlaces = decimalPlaces !== void 0 ? decimalPlaces : 2;
  function floatToString(v2) {
    if (Math.round(v2) === v2) {
      return "" + Math.round(v2);
    } else {
      return v2.toFixed(decimalPlaces);
    }
  }
  function packValues() {
    var arguments$1 = arguments;
    var s = "";
    for (var i2 = 0; i2 < arguments.length; i2 += 1) {
      var v2 = arguments$1[i2];
      if (v2 >= 0 && i2 > 0) {
        s += " ";
      }
      s += floatToString(v2);
    }
    return s;
  }
  var d2 = "";
  for (var i = 0; i < this.commands.length; i += 1) {
    var cmd = this.commands[i];
    if (cmd.type === "M") {
      d2 += "M" + packValues(cmd.x, cmd.y);
    } else if (cmd.type === "L") {
      d2 += "L" + packValues(cmd.x, cmd.y);
    } else if (cmd.type === "C") {
      d2 += "C" + packValues(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
    } else if (cmd.type === "Q") {
      d2 += "Q" + packValues(cmd.x1, cmd.y1, cmd.x, cmd.y);
    } else if (cmd.type === "Z") {
      d2 += "Z";
    }
  }
  return d2;
};
var cffStandardStrings = [
  ".notdef",
  "space",
  "exclam",
  "quotedbl",
  "numbersign",
  "dollar",
  "percent",
  "ampersand",
  "quoteright",
  "parenleft",
  "parenright",
  "asterisk",
  "plus",
  "comma",
  "hyphen",
  "period",
  "slash",
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "colon",
  "semicolon",
  "less",
  "equal",
  "greater",
  "question",
  "at",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "bracketleft",
  "backslash",
  "bracketright",
  "asciicircum",
  "underscore",
  "quoteleft",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "braceleft",
  "bar",
  "braceright",
  "asciitilde",
  "exclamdown",
  "cent",
  "sterling",
  "fraction",
  "yen",
  "florin",
  "section",
  "currency",
  "quotesingle",
  "quotedblleft",
  "guillemotleft",
  "guilsinglleft",
  "guilsinglright",
  "fi",
  "fl",
  "endash",
  "dagger",
  "daggerdbl",
  "periodcentered",
  "paragraph",
  "bullet",
  "quotesinglbase",
  "quotedblbase",
  "quotedblright",
  "guillemotright",
  "ellipsis",
  "perthousand",
  "questiondown",
  "grave",
  "acute",
  "circumflex",
  "tilde",
  "macron",
  "breve",
  "dotaccent",
  "dieresis",
  "ring",
  "cedilla",
  "hungarumlaut",
  "ogonek",
  "caron",
  "emdash",
  "AE",
  "ordfeminine",
  "Lslash",
  "Oslash",
  "OE",
  "ordmasculine",
  "ae",
  "dotlessi",
  "lslash",
  "oslash",
  "oe",
  "germandbls",
  "onesuperior",
  "logicalnot",
  "mu",
  "trademark",
  "Eth",
  "onehalf",
  "plusminus",
  "Thorn",
  "onequarter",
  "divide",
  "brokenbar",
  "degree",
  "thorn",
  "threequarters",
  "twosuperior",
  "registered",
  "minus",
  "eth",
  "multiply",
  "threesuperior",
  "copyright",
  "Aacute",
  "Acircumflex",
  "Adieresis",
  "Agrave",
  "Aring",
  "Atilde",
  "Ccedilla",
  "Eacute",
  "Ecircumflex",
  "Edieresis",
  "Egrave",
  "Iacute",
  "Icircumflex",
  "Idieresis",
  "Igrave",
  "Ntilde",
  "Oacute",
  "Ocircumflex",
  "Odieresis",
  "Ograve",
  "Otilde",
  "Scaron",
  "Uacute",
  "Ucircumflex",
  "Udieresis",
  "Ugrave",
  "Yacute",
  "Ydieresis",
  "Zcaron",
  "aacute",
  "acircumflex",
  "adieresis",
  "agrave",
  "aring",
  "atilde",
  "ccedilla",
  "eacute",
  "ecircumflex",
  "edieresis",
  "egrave",
  "iacute",
  "icircumflex",
  "idieresis",
  "igrave",
  "ntilde",
  "oacute",
  "ocircumflex",
  "odieresis",
  "ograve",
  "otilde",
  "scaron",
  "uacute",
  "ucircumflex",
  "udieresis",
  "ugrave",
  "yacute",
  "ydieresis",
  "zcaron",
  "exclamsmall",
  "Hungarumlautsmall",
  "dollaroldstyle",
  "dollarsuperior",
  "ampersandsmall",
  "Acutesmall",
  "parenleftsuperior",
  "parenrightsuperior",
  "266 ff",
  "onedotenleader",
  "zerooldstyle",
  "oneoldstyle",
  "twooldstyle",
  "threeoldstyle",
  "fouroldstyle",
  "fiveoldstyle",
  "sixoldstyle",
  "sevenoldstyle",
  "eightoldstyle",
  "nineoldstyle",
  "commasuperior",
  "threequartersemdash",
  "periodsuperior",
  "questionsmall",
  "asuperior",
  "bsuperior",
  "centsuperior",
  "dsuperior",
  "esuperior",
  "isuperior",
  "lsuperior",
  "msuperior",
  "nsuperior",
  "osuperior",
  "rsuperior",
  "ssuperior",
  "tsuperior",
  "ff",
  "ffi",
  "ffl",
  "parenleftinferior",
  "parenrightinferior",
  "Circumflexsmall",
  "hyphensuperior",
  "Gravesmall",
  "Asmall",
  "Bsmall",
  "Csmall",
  "Dsmall",
  "Esmall",
  "Fsmall",
  "Gsmall",
  "Hsmall",
  "Ismall",
  "Jsmall",
  "Ksmall",
  "Lsmall",
  "Msmall",
  "Nsmall",
  "Osmall",
  "Psmall",
  "Qsmall",
  "Rsmall",
  "Ssmall",
  "Tsmall",
  "Usmall",
  "Vsmall",
  "Wsmall",
  "Xsmall",
  "Ysmall",
  "Zsmall",
  "colonmonetary",
  "onefitted",
  "rupiah",
  "Tildesmall",
  "exclamdownsmall",
  "centoldstyle",
  "Lslashsmall",
  "Scaronsmall",
  "Zcaronsmall",
  "Dieresissmall",
  "Brevesmall",
  "Caronsmall",
  "Dotaccentsmall",
  "Macronsmall",
  "figuredash",
  "hypheninferior",
  "Ogoneksmall",
  "Ringsmall",
  "Cedillasmall",
  "questiondownsmall",
  "oneeighth",
  "threeeighths",
  "fiveeighths",
  "seveneighths",
  "onethird",
  "twothirds",
  "zerosuperior",
  "foursuperior",
  "fivesuperior",
  "sixsuperior",
  "sevensuperior",
  "eightsuperior",
  "ninesuperior",
  "zeroinferior",
  "oneinferior",
  "twoinferior",
  "threeinferior",
  "fourinferior",
  "fiveinferior",
  "sixinferior",
  "seveninferior",
  "eightinferior",
  "nineinferior",
  "centinferior",
  "dollarinferior",
  "periodinferior",
  "commainferior",
  "Agravesmall",
  "Aacutesmall",
  "Acircumflexsmall",
  "Atildesmall",
  "Adieresissmall",
  "Aringsmall",
  "AEsmall",
  "Ccedillasmall",
  "Egravesmall",
  "Eacutesmall",
  "Ecircumflexsmall",
  "Edieresissmall",
  "Igravesmall",
  "Iacutesmall",
  "Icircumflexsmall",
  "Idieresissmall",
  "Ethsmall",
  "Ntildesmall",
  "Ogravesmall",
  "Oacutesmall",
  "Ocircumflexsmall",
  "Otildesmall",
  "Odieresissmall",
  "OEsmall",
  "Oslashsmall",
  "Ugravesmall",
  "Uacutesmall",
  "Ucircumflexsmall",
  "Udieresissmall",
  "Yacutesmall",
  "Thornsmall",
  "Ydieresissmall",
  "001.000",
  "001.001",
  "001.002",
  "001.003",
  "Black",
  "Bold",
  "Book",
  "Light",
  "Medium",
  "Regular",
  "Roman",
  "Semibold"
];
var cffStandardEncoding = [
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "space",
  "exclam",
  "quotedbl",
  "numbersign",
  "dollar",
  "percent",
  "ampersand",
  "quoteright",
  "parenleft",
  "parenright",
  "asterisk",
  "plus",
  "comma",
  "hyphen",
  "period",
  "slash",
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "colon",
  "semicolon",
  "less",
  "equal",
  "greater",
  "question",
  "at",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "bracketleft",
  "backslash",
  "bracketright",
  "asciicircum",
  "underscore",
  "quoteleft",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "braceleft",
  "bar",
  "braceright",
  "asciitilde",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "exclamdown",
  "cent",
  "sterling",
  "fraction",
  "yen",
  "florin",
  "section",
  "currency",
  "quotesingle",
  "quotedblleft",
  "guillemotleft",
  "guilsinglleft",
  "guilsinglright",
  "fi",
  "fl",
  "",
  "endash",
  "dagger",
  "daggerdbl",
  "periodcentered",
  "",
  "paragraph",
  "bullet",
  "quotesinglbase",
  "quotedblbase",
  "quotedblright",
  "guillemotright",
  "ellipsis",
  "perthousand",
  "",
  "questiondown",
  "",
  "grave",
  "acute",
  "circumflex",
  "tilde",
  "macron",
  "breve",
  "dotaccent",
  "dieresis",
  "",
  "ring",
  "cedilla",
  "",
  "hungarumlaut",
  "ogonek",
  "caron",
  "emdash",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "AE",
  "",
  "ordfeminine",
  "",
  "",
  "",
  "",
  "Lslash",
  "Oslash",
  "OE",
  "ordmasculine",
  "",
  "",
  "",
  "",
  "",
  "ae",
  "",
  "",
  "",
  "dotlessi",
  "",
  "",
  "lslash",
  "oslash",
  "oe",
  "germandbls"
];
var cffExpertEncoding = [
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "space",
  "exclamsmall",
  "Hungarumlautsmall",
  "",
  "dollaroldstyle",
  "dollarsuperior",
  "ampersandsmall",
  "Acutesmall",
  "parenleftsuperior",
  "parenrightsuperior",
  "twodotenleader",
  "onedotenleader",
  "comma",
  "hyphen",
  "period",
  "fraction",
  "zerooldstyle",
  "oneoldstyle",
  "twooldstyle",
  "threeoldstyle",
  "fouroldstyle",
  "fiveoldstyle",
  "sixoldstyle",
  "sevenoldstyle",
  "eightoldstyle",
  "nineoldstyle",
  "colon",
  "semicolon",
  "commasuperior",
  "threequartersemdash",
  "periodsuperior",
  "questionsmall",
  "",
  "asuperior",
  "bsuperior",
  "centsuperior",
  "dsuperior",
  "esuperior",
  "",
  "",
  "isuperior",
  "",
  "",
  "lsuperior",
  "msuperior",
  "nsuperior",
  "osuperior",
  "",
  "",
  "rsuperior",
  "ssuperior",
  "tsuperior",
  "",
  "ff",
  "fi",
  "fl",
  "ffi",
  "ffl",
  "parenleftinferior",
  "",
  "parenrightinferior",
  "Circumflexsmall",
  "hyphensuperior",
  "Gravesmall",
  "Asmall",
  "Bsmall",
  "Csmall",
  "Dsmall",
  "Esmall",
  "Fsmall",
  "Gsmall",
  "Hsmall",
  "Ismall",
  "Jsmall",
  "Ksmall",
  "Lsmall",
  "Msmall",
  "Nsmall",
  "Osmall",
  "Psmall",
  "Qsmall",
  "Rsmall",
  "Ssmall",
  "Tsmall",
  "Usmall",
  "Vsmall",
  "Wsmall",
  "Xsmall",
  "Ysmall",
  "Zsmall",
  "colonmonetary",
  "onefitted",
  "rupiah",
  "Tildesmall",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "exclamdownsmall",
  "centoldstyle",
  "Lslashsmall",
  "",
  "",
  "Scaronsmall",
  "Zcaronsmall",
  "Dieresissmall",
  "Brevesmall",
  "Caronsmall",
  "",
  "Dotaccentsmall",
  "",
  "",
  "Macronsmall",
  "",
  "",
  "figuredash",
  "hypheninferior",
  "",
  "",
  "Ogoneksmall",
  "Ringsmall",
  "Cedillasmall",
  "",
  "",
  "",
  "onequarter",
  "onehalf",
  "threequarters",
  "questiondownsmall",
  "oneeighth",
  "threeeighths",
  "fiveeighths",
  "seveneighths",
  "onethird",
  "twothirds",
  "",
  "",
  "zerosuperior",
  "onesuperior",
  "twosuperior",
  "threesuperior",
  "foursuperior",
  "fivesuperior",
  "sixsuperior",
  "sevensuperior",
  "eightsuperior",
  "ninesuperior",
  "zeroinferior",
  "oneinferior",
  "twoinferior",
  "threeinferior",
  "fourinferior",
  "fiveinferior",
  "sixinferior",
  "seveninferior",
  "eightinferior",
  "nineinferior",
  "centinferior",
  "dollarinferior",
  "periodinferior",
  "commainferior",
  "Agravesmall",
  "Aacutesmall",
  "Acircumflexsmall",
  "Atildesmall",
  "Adieresissmall",
  "Aringsmall",
  "AEsmall",
  "Ccedillasmall",
  "Egravesmall",
  "Eacutesmall",
  "Ecircumflexsmall",
  "Edieresissmall",
  "Igravesmall",
  "Iacutesmall",
  "Icircumflexsmall",
  "Idieresissmall",
  "Ethsmall",
  "Ntildesmall",
  "Ogravesmall",
  "Oacutesmall",
  "Ocircumflexsmall",
  "Otildesmall",
  "Odieresissmall",
  "OEsmall",
  "Oslashsmall",
  "Ugravesmall",
  "Uacutesmall",
  "Ucircumflexsmall",
  "Udieresissmall",
  "Yacutesmall",
  "Thornsmall",
  "Ydieresissmall"
];
function DefaultEncoding(font) {
  this.font = font;
}
DefaultEncoding.prototype.charToGlyphIndex = function(c2) {
  var code = c2.codePointAt(0);
  var glyphs = this.font.glyphs;
  if (glyphs) {
    for (var i = 0; i < glyphs.length; i += 1) {
      var glyph = glyphs.get(i);
      for (var j = 0; j < glyph.unicodes.length; j += 1) {
        if (glyph.unicodes[j] === code) {
          return i;
        }
      }
    }
  }
  return null;
};
function CmapEncoding(cmap2) {
  this.cmap = cmap2;
}
CmapEncoding.prototype.charToGlyphIndex = function(c2) {
  return this.cmap.glyphIndexMap[c2.codePointAt(0)] || 0;
};
function CffEncoding(encoding, charset) {
  this.encoding = encoding;
  this.charset = charset;
}
CffEncoding.prototype.charToGlyphIndex = function(s) {
  var code = s.codePointAt(0);
  var charName = this.encoding[code];
  return this.charset.indexOf(charName);
};
function addGlyphNamesAll(font) {
  var glyph;
  var glyphIndexMap = font.tables.cmap.glyphIndexMap;
  var charCodes = Object.keys(glyphIndexMap);
  for (var i = 0; i < charCodes.length; i += 1) {
    var c2 = charCodes[i];
    var glyphIndex = glyphIndexMap[c2];
    glyph = font.glyphs.get(glyphIndex);
    glyph.addUnicode(parseInt(c2));
  }
}
function addGlyphNamesToUnicodeMap(font) {
  font._IndexToUnicodeMap = {};
  var glyphIndexMap = font.tables.cmap.glyphIndexMap;
  var charCodes = Object.keys(glyphIndexMap);
  for (var i = 0; i < charCodes.length; i += 1) {
    var c2 = charCodes[i];
    var glyphIndex = glyphIndexMap[c2];
    if (font._IndexToUnicodeMap[glyphIndex] === void 0) {
      font._IndexToUnicodeMap[glyphIndex] = {
        unicodes: [parseInt(c2)]
      };
    } else {
      font._IndexToUnicodeMap[glyphIndex].unicodes.push(parseInt(c2));
    }
  }
}
function addGlyphNames(font, opt) {
  if (opt.lowMemory) {
    addGlyphNamesToUnicodeMap(font);
  } else {
    addGlyphNamesAll(font);
  }
}
function fail(message) {
  throw new Error(message);
}
function argument(predicate, message) {
  if (!predicate) {
    fail(message);
  }
}
var check = { fail, argument, assert: argument };
function getPathDefinition(glyph, path) {
  var _path = path || new Path();
  return {
    configurable: true,
    get: function() {
      if (typeof _path === "function") {
        _path = _path();
      }
      return _path;
    },
    set: function(p) {
      _path = p;
    }
  };
}
function Glyph(options) {
  this.bindConstructorValues(options);
}
Glyph.prototype.bindConstructorValues = function(options) {
  this.index = options.index || 0;
  this.name = options.name || null;
  this.unicode = options.unicode || void 0;
  this.unicodes = options.unicodes || options.unicode !== void 0 ? [options.unicode] : [];
  if ("xMin" in options) {
    this.xMin = options.xMin;
  }
  if ("yMin" in options) {
    this.yMin = options.yMin;
  }
  if ("xMax" in options) {
    this.xMax = options.xMax;
  }
  if ("yMax" in options) {
    this.yMax = options.yMax;
  }
  if ("advanceWidth" in options) {
    this.advanceWidth = options.advanceWidth;
  }
  Object.defineProperty(this, "path", getPathDefinition(this, options.path));
};
Glyph.prototype.addUnicode = function(unicode) {
  if (this.unicodes.length === 0) {
    this.unicode = unicode;
  }
  this.unicodes.push(unicode);
};
Glyph.prototype.getPath = function(x2, y, fontSize, options, font) {
  x2 = x2 !== void 0 ? x2 : 0;
  y = y !== void 0 ? y : 0;
  fontSize = fontSize !== void 0 ? fontSize : 72;
  var commands;
  var hPoints;
  if (!options) {
    options = {};
  }
  var xScale = options.xScale;
  var yScale = options.yScale;
  if (options.hinting && font && font.hinting) {
    hPoints = this.path && font.hinting.exec(this, fontSize);
  }
  if (hPoints) {
    commands = font.hinting.getCommands(hPoints);
    x2 = Math.round(x2);
    y = Math.round(y);
    xScale = yScale = 1;
  } else {
    commands = this.path.commands;
    var scale = 1 / (this.path.unitsPerEm || 1e3) * fontSize;
    if (xScale === void 0) {
      xScale = scale;
    }
    if (yScale === void 0) {
      yScale = scale;
    }
  }
  var p = new Path();
  for (var i = 0; i < commands.length; i += 1) {
    var cmd = commands[i];
    if (cmd.type === "M") {
      p.moveTo(x2 + cmd.x * xScale, y + -cmd.y * yScale);
    } else if (cmd.type === "L") {
      p.lineTo(x2 + cmd.x * xScale, y + -cmd.y * yScale);
    } else if (cmd.type === "Q") {
      p.quadraticCurveTo(
        x2 + cmd.x1 * xScale,
        y + -cmd.y1 * yScale,
        x2 + cmd.x * xScale,
        y + -cmd.y * yScale
      );
    } else if (cmd.type === "C") {
      p.curveTo(
        x2 + cmd.x1 * xScale,
        y + -cmd.y1 * yScale,
        x2 + cmd.x2 * xScale,
        y + -cmd.y2 * yScale,
        x2 + cmd.x * xScale,
        y + -cmd.y * yScale
      );
    } else if (cmd.type === "Z") {
      p.closePath();
    }
  }
  return p;
};
Glyph.prototype.getContours = function() {
  if (this.points === void 0) {
    return [];
  }
  var contours = [];
  var currentContour = [];
  for (var i = 0; i < this.points.length; i += 1) {
    var pt2 = this.points[i];
    currentContour.push(pt2);
    if (pt2.lastPointOfContour) {
      contours.push(currentContour);
      currentContour = [];
    }
  }
  check.argument(
    currentContour.length === 0,
    "There are still points left in the current contour."
  );
  return contours;
};
Glyph.prototype.getMetrics = function() {
  var commands = this.path.commands;
  var xCoords = [];
  var yCoords = [];
  for (var i = 0; i < commands.length; i += 1) {
    var cmd = commands[i];
    if (cmd.type !== "Z") {
      xCoords.push(cmd.x);
      yCoords.push(cmd.y);
    }
    if (cmd.type === "Q" || cmd.type === "C") {
      xCoords.push(cmd.x1);
      yCoords.push(cmd.y1);
    }
    if (cmd.type === "C") {
      xCoords.push(cmd.x2);
      yCoords.push(cmd.y2);
    }
  }
  var metrics = {
    xMin: Math.min.apply(null, xCoords),
    yMin: Math.min.apply(null, yCoords),
    xMax: Math.max.apply(null, xCoords),
    yMax: Math.max.apply(null, yCoords),
    leftSideBearing: this.leftSideBearing
  };
  if (!isFinite(metrics.xMin)) {
    metrics.xMin = 0;
  }
  if (!isFinite(metrics.xMax)) {
    metrics.xMax = this.advanceWidth;
  }
  if (!isFinite(metrics.yMin)) {
    metrics.yMin = 0;
  }
  if (!isFinite(metrics.yMax)) {
    metrics.yMax = 0;
  }
  metrics.rightSideBearing = this.advanceWidth - metrics.leftSideBearing - (metrics.xMax - metrics.xMin);
  return metrics;
};
function defineDependentProperty(glyph, externalName, internalName) {
  Object.defineProperty(glyph, externalName, {
    get: function() {
      glyph.path;
      return glyph[internalName];
    },
    set: function(newValue) {
      glyph[internalName] = newValue;
    },
    enumerable: true,
    configurable: true
  });
}
function GlyphSet(font, glyphs) {
  this.font = font;
  this.glyphs = {};
  if (Array.isArray(glyphs)) {
    for (var i = 0; i < glyphs.length; i++) {
      var glyph = glyphs[i];
      glyph.path.unitsPerEm = font.unitsPerEm;
      this.glyphs[i] = glyph;
    }
  }
  this.length = glyphs && glyphs.length || 0;
}
GlyphSet.prototype.get = function(index) {
  if (this.glyphs[index] === void 0) {
    this.font._push(index);
    if (typeof this.glyphs[index] === "function") {
      this.glyphs[index] = this.glyphs[index]();
    }
    var glyph = this.glyphs[index];
    var unicodeObj = this.font._IndexToUnicodeMap[index];
    if (unicodeObj) {
      for (var j = 0; j < unicodeObj.unicodes.length; j++) {
        glyph.addUnicode(unicodeObj.unicodes[j]);
      }
    }
    this.glyphs[index].advanceWidth = this.font._hmtxTableData[index].advanceWidth;
    this.glyphs[index].leftSideBearing = this.font._hmtxTableData[index].leftSideBearing;
  } else {
    if (typeof this.glyphs[index] === "function") {
      this.glyphs[index] = this.glyphs[index]();
    }
  }
  return this.glyphs[index];
};
GlyphSet.prototype.push = function(index, loader) {
  this.glyphs[index] = loader;
  this.length++;
};
function glyphLoader(font, index) {
  return new Glyph({ index, font });
}
function ttfGlyphLoader(font, index, parseGlyph2, data, position, buildPath2) {
  return function() {
    var glyph = new Glyph({ index, font });
    glyph.path = function() {
      parseGlyph2(glyph, data, position);
      var path = buildPath2(font.glyphs, glyph);
      path.unitsPerEm = font.unitsPerEm;
      return path;
    };
    defineDependentProperty(glyph, "xMin", "_xMin");
    defineDependentProperty(glyph, "xMax", "_xMax");
    defineDependentProperty(glyph, "yMin", "_yMin");
    defineDependentProperty(glyph, "yMax", "_yMax");
    return glyph;
  };
}
function cffGlyphLoader(font, index, parseCFFCharstring2, charstring) {
  return function() {
    var glyph = new Glyph({ index, font });
    glyph.path = function() {
      var path = parseCFFCharstring2(font, glyph, charstring);
      path.unitsPerEm = font.unitsPerEm;
      return path;
    };
    return glyph;
  };
}
var glyphset = { GlyphSet, glyphLoader, ttfGlyphLoader, cffGlyphLoader };
function searchTag(arr, tag) {
  var imin = 0;
  var imax = arr.length - 1;
  while (imin <= imax) {
    var imid = imin + imax >>> 1;
    var val = arr[imid].tag;
    if (val === tag) {
      return imid;
    } else if (val < tag) {
      imin = imid + 1;
    } else {
      imax = imid - 1;
    }
  }
  return -imin - 1;
}
function binSearch(arr, value) {
  var imin = 0;
  var imax = arr.length - 1;
  while (imin <= imax) {
    var imid = imin + imax >>> 1;
    var val = arr[imid];
    if (val === value) {
      return imid;
    } else if (val < value) {
      imin = imid + 1;
    } else {
      imax = imid - 1;
    }
  }
  return -imin - 1;
}
function searchRange(ranges, value) {
  var range;
  var imin = 0;
  var imax = ranges.length - 1;
  while (imin <= imax) {
    var imid = imin + imax >>> 1;
    range = ranges[imid];
    var start = range.start;
    if (start === value) {
      return range;
    } else if (start < value) {
      imin = imid + 1;
    } else {
      imax = imid - 1;
    }
  }
  if (imin > 0) {
    range = ranges[imin - 1];
    if (value > range.end) {
      return 0;
    }
    return range;
  }
}
function Layout(font, tableName) {
  this.font = font;
  this.tableName = tableName;
}
Layout.prototype = {
  /**
   * Binary search an object by "tag" property
   * @instance
   * @function searchTag
   * @memberof opentype.Layout
   * @param  {Array} arr
   * @param  {string} tag
   * @return {number}
   */
  searchTag,
  /**
   * Binary search in a list of numbers
   * @instance
   * @function binSearch
   * @memberof opentype.Layout
   * @param  {Array} arr
   * @param  {number} value
   * @return {number}
   */
  binSearch,
  /**
   * Get or create the Layout table (GSUB, GPOS etc).
   * @param  {boolean} create - Whether to create a new one.
   * @return {Object} The GSUB or GPOS table.
   */
  getTable: function(create) {
    var layout = this.font.tables[this.tableName];
    if (!layout && create) {
      layout = this.font.tables[this.tableName] = this.createDefaultTable();
    }
    return layout;
  },
  /**
   * Returns the best bet for a script name.
   * Returns 'DFLT' if it exists.
   * If not, returns 'latn' if it exists.
   * If neither exist, returns undefined.
   */
  getDefaultScriptName: function() {
    var layout = this.getTable();
    if (!layout) {
      return;
    }
    var hasLatn = false;
    for (var i = 0; i < layout.scripts.length; i++) {
      var name = layout.scripts[i].tag;
      if (name === "DFLT") {
        return name;
      }
      if (name === "latn") {
        hasLatn = true;
      }
    }
    if (hasLatn) {
      return "latn";
    }
  },
  /**
   * Returns all LangSysRecords in the given script.
   * @instance
   * @param {string} [script='DFLT']
   * @param {boolean} create - forces the creation of this script table if it doesn't exist.
   * @return {Object} An object with tag and script properties.
   */
  getScriptTable: function(script, create) {
    var layout = this.getTable(create);
    if (layout) {
      script = script || "DFLT";
      var scripts = layout.scripts;
      var pos = searchTag(layout.scripts, script);
      if (pos >= 0) {
        return scripts[pos].script;
      } else if (create) {
        var scr = {
          tag: script,
          script: {
            defaultLangSys: {
              reserved: 0,
              reqFeatureIndex: 65535,
              featureIndexes: []
            },
            langSysRecords: []
          }
        };
        scripts.splice(-1 - pos, 0, scr);
        return scr.script;
      }
    }
  },
  /**
   * Returns a language system table
   * @instance
   * @param {string} [script='DFLT']
   * @param {string} [language='dlft']
   * @param {boolean} create - forces the creation of this langSysTable if it doesn't exist.
   * @return {Object}
   */
  getLangSysTable: function(script, language, create) {
    var scriptTable = this.getScriptTable(script, create);
    if (scriptTable) {
      if (!language || language === "dflt" || language === "DFLT") {
        return scriptTable.defaultLangSys;
      }
      var pos = searchTag(scriptTable.langSysRecords, language);
      if (pos >= 0) {
        return scriptTable.langSysRecords[pos].langSys;
      } else if (create) {
        var langSysRecord = {
          tag: language,
          langSys: {
            reserved: 0,
            reqFeatureIndex: 65535,
            featureIndexes: []
          }
        };
        scriptTable.langSysRecords.splice(-1 - pos, 0, langSysRecord);
        return langSysRecord.langSys;
      }
    }
  },
  /**
   * Get a specific feature table.
   * @instance
   * @param {string} [script='DFLT']
   * @param {string} [language='dlft']
   * @param {string} feature - One of the codes listed at https://www.microsoft.com/typography/OTSPEC/featurelist.htm
   * @param {boolean} create - forces the creation of the feature table if it doesn't exist.
   * @return {Object}
   */
  getFeatureTable: function(script, language, feature, create) {
    var langSysTable2 = this.getLangSysTable(script, language, create);
    if (langSysTable2) {
      var featureRecord;
      var featIndexes = langSysTable2.featureIndexes;
      var allFeatures = this.font.tables[this.tableName].features;
      for (var i = 0; i < featIndexes.length; i++) {
        featureRecord = allFeatures[featIndexes[i]];
        if (featureRecord.tag === feature) {
          return featureRecord.feature;
        }
      }
      if (create) {
        var index = allFeatures.length;
        check.assert(
          index === 0 || feature >= allFeatures[index - 1].tag,
          "Features must be added in alphabetical order."
        );
        featureRecord = {
          tag: feature,
          feature: { params: 0, lookupListIndexes: [] }
        };
        allFeatures.push(featureRecord);
        featIndexes.push(index);
        return featureRecord.feature;
      }
    }
  },
  /**
   * Get the lookup tables of a given type for a script/language/feature.
   * @instance
   * @param {string} [script='DFLT']
   * @param {string} [language='dlft']
   * @param {string} feature - 4-letter feature code
   * @param {number} lookupType - 1 to 9
   * @param {boolean} create - forces the creation of the lookup table if it doesn't exist, with no subtables.
   * @return {Object[]}
   */
  getLookupTables: function(script, language, feature, lookupType, create) {
    var featureTable = this.getFeatureTable(
      script,
      language,
      feature,
      create
    );
    var tables = [];
    if (featureTable) {
      var lookupTable;
      var lookupListIndexes = featureTable.lookupListIndexes;
      var allLookups = this.font.tables[this.tableName].lookups;
      for (var i = 0; i < lookupListIndexes.length; i++) {
        lookupTable = allLookups[lookupListIndexes[i]];
        if (lookupTable.lookupType === lookupType) {
          tables.push(lookupTable);
        }
      }
      if (tables.length === 0 && create) {
        lookupTable = {
          lookupType,
          lookupFlag: 0,
          subtables: [],
          markFilteringSet: void 0
        };
        var index = allLookups.length;
        allLookups.push(lookupTable);
        lookupListIndexes.push(index);
        return [lookupTable];
      }
    }
    return tables;
  },
  /**
   * Find a glyph in a class definition table
   * https://docs.microsoft.com/en-us/typography/opentype/spec/chapter2#class-definition-table
   * @param {object} classDefTable - an OpenType Layout class definition table
   * @param {number} glyphIndex - the index of the glyph to find
   * @returns {number} -1 if not found
   */
  getGlyphClass: function(classDefTable, glyphIndex) {
    switch (classDefTable.format) {
      case 1:
        if (classDefTable.startGlyph <= glyphIndex && glyphIndex < classDefTable.startGlyph + classDefTable.classes.length) {
          return classDefTable.classes[glyphIndex - classDefTable.startGlyph];
        }
        return 0;
      case 2:
        var range = searchRange(classDefTable.ranges, glyphIndex);
        return range ? range.classId : 0;
    }
  },
  /**
   * Find a glyph in a coverage table
   * https://docs.microsoft.com/en-us/typography/opentype/spec/chapter2#coverage-table
   * @param {object} coverageTable - an OpenType Layout coverage table
   * @param {number} glyphIndex - the index of the glyph to find
   * @returns {number} -1 if not found
   */
  getCoverageIndex: function(coverageTable, glyphIndex) {
    switch (coverageTable.format) {
      case 1:
        var index = binSearch(coverageTable.glyphs, glyphIndex);
        return index >= 0 ? index : -1;
      case 2:
        var range = searchRange(coverageTable.ranges, glyphIndex);
        return range ? range.index + glyphIndex - range.start : -1;
    }
  },
  /**
   * Returns the list of glyph indexes of a coverage table.
   * Format 1: the list is stored raw
   * Format 2: compact list as range records.
   * @instance
   * @param  {Object} coverageTable
   * @return {Array}
   */
  expandCoverage: function(coverageTable) {
    if (coverageTable.format === 1) {
      return coverageTable.glyphs;
    } else {
      var glyphs = [];
      var ranges = coverageTable.ranges;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var start = range.start;
        var end = range.end;
        for (var j = start; j <= end; j++) {
          glyphs.push(j);
        }
      }
      return glyphs;
    }
  }
};
function Position(font) {
  Layout.call(this, font, "gpos");
}
Position.prototype = Layout.prototype;
Position.prototype.init = function() {
  var script = this.getDefaultScriptName();
  this.defaultKerningTables = this.getKerningTables(script);
};
Position.prototype.getKerningValue = function(kerningLookups, leftIndex, rightIndex) {
  for (var i = 0; i < kerningLookups.length; i++) {
    var subtables = kerningLookups[i].subtables;
    for (var j = 0; j < subtables.length; j++) {
      var subtable = subtables[j];
      var covIndex = this.getCoverageIndex(subtable.coverage, leftIndex);
      if (covIndex < 0) {
        continue;
      }
      switch (subtable.posFormat) {
        case 1:
          var pairSet = subtable.pairSets[covIndex];
          for (var k2 = 0; k2 < pairSet.length; k2++) {
            var pair = pairSet[k2];
            if (pair.secondGlyph === rightIndex) {
              return pair.value1 && pair.value1.xAdvance || 0;
            }
          }
          break;
        case 2:
          var class1 = this.getGlyphClass(subtable.classDef1, leftIndex);
          var class2 = this.getGlyphClass(subtable.classDef2, rightIndex);
          var pair$1 = subtable.classRecords[class1][class2];
          return pair$1.value1 && pair$1.value1.xAdvance || 0;
      }
    }
  }
  return 0;
};
Position.prototype.getKerningTables = function(script, language) {
  if (this.font.tables.gpos) {
    return this.getLookupTables(script, language, "kern", 2);
  }
};
function Substitution(font) {
  Layout.call(this, font, "gsub");
}
function arraysEqual(ar1, ar2) {
  var n = ar1.length;
  if (n !== ar2.length) {
    return false;
  }
  for (var i = 0; i < n; i++) {
    if (ar1[i] !== ar2[i]) {
      return false;
    }
  }
  return true;
}
function getSubstFormat(lookupTable, format, defaultSubtable) {
  var subtables = lookupTable.subtables;
  for (var i = 0; i < subtables.length; i++) {
    var subtable = subtables[i];
    if (subtable.substFormat === format) {
      return subtable;
    }
  }
  if (defaultSubtable) {
    subtables.push(defaultSubtable);
    return defaultSubtable;
  }
  return void 0;
}
Substitution.prototype = Layout.prototype;
Substitution.prototype.createDefaultTable = function() {
  return {
    version: 1,
    scripts: [
      {
        tag: "DFLT",
        script: {
          defaultLangSys: {
            reserved: 0,
            reqFeatureIndex: 65535,
            featureIndexes: []
          },
          langSysRecords: []
        }
      }
    ],
    features: [],
    lookups: []
  };
};
Substitution.prototype.getSingle = function(feature, script, language) {
  var substitutions = [];
  var lookupTables = this.getLookupTables(script, language, feature, 1);
  for (var idx = 0; idx < lookupTables.length; idx++) {
    var subtables = lookupTables[idx].subtables;
    for (var i = 0; i < subtables.length; i++) {
      var subtable = subtables[i];
      var glyphs = this.expandCoverage(subtable.coverage);
      var j = void 0;
      if (subtable.substFormat === 1) {
        var delta = subtable.deltaGlyphId;
        for (j = 0; j < glyphs.length; j++) {
          var glyph = glyphs[j];
          substitutions.push({ sub: glyph, by: glyph + delta });
        }
      } else {
        var substitute = subtable.substitute;
        for (j = 0; j < glyphs.length; j++) {
          substitutions.push({ sub: glyphs[j], by: substitute[j] });
        }
      }
    }
  }
  return substitutions;
};
Substitution.prototype.getMultiple = function(feature, script, language) {
  var substitutions = [];
  var lookupTables = this.getLookupTables(script, language, feature, 2);
  for (var idx = 0; idx < lookupTables.length; idx++) {
    var subtables = lookupTables[idx].subtables;
    for (var i = 0; i < subtables.length; i++) {
      var subtable = subtables[i];
      var glyphs = this.expandCoverage(subtable.coverage);
      var j = void 0;
      for (j = 0; j < glyphs.length; j++) {
        var glyph = glyphs[j];
        var replacements = subtable.sequences[j];
        substitutions.push({ sub: glyph, by: replacements });
      }
    }
  }
  return substitutions;
};
Substitution.prototype.getAlternates = function(feature, script, language) {
  var alternates = [];
  var lookupTables = this.getLookupTables(script, language, feature, 3);
  for (var idx = 0; idx < lookupTables.length; idx++) {
    var subtables = lookupTables[idx].subtables;
    for (var i = 0; i < subtables.length; i++) {
      var subtable = subtables[i];
      var glyphs = this.expandCoverage(subtable.coverage);
      var alternateSets = subtable.alternateSets;
      for (var j = 0; j < glyphs.length; j++) {
        alternates.push({ sub: glyphs[j], by: alternateSets[j] });
      }
    }
  }
  return alternates;
};
Substitution.prototype.getLigatures = function(feature, script, language) {
  var ligatures = [];
  var lookupTables = this.getLookupTables(script, language, feature, 4);
  for (var idx = 0; idx < lookupTables.length; idx++) {
    var subtables = lookupTables[idx].subtables;
    for (var i = 0; i < subtables.length; i++) {
      var subtable = subtables[i];
      var glyphs = this.expandCoverage(subtable.coverage);
      var ligatureSets = subtable.ligatureSets;
      for (var j = 0; j < glyphs.length; j++) {
        var startGlyph = glyphs[j];
        var ligSet = ligatureSets[j];
        for (var k2 = 0; k2 < ligSet.length; k2++) {
          var lig = ligSet[k2];
          ligatures.push({
            sub: [startGlyph].concat(lig.components),
            by: lig.ligGlyph
          });
        }
      }
    }
  }
  return ligatures;
};
Substitution.prototype.addSingle = function(feature, substitution, script, language) {
  var lookupTable = this.getLookupTables(
    script,
    language,
    feature,
    1,
    true
  )[0];
  var subtable = getSubstFormat(lookupTable, 2, {
    // lookup type 1 subtable, format 2, coverage format 1
    substFormat: 2,
    coverage: { format: 1, glyphs: [] },
    substitute: []
  });
  check.assert(
    subtable.coverage.format === 1,
    "Single: unable to modify coverage table format " + subtable.coverage.format
  );
  var coverageGlyph = substitution.sub;
  var pos = this.binSearch(subtable.coverage.glyphs, coverageGlyph);
  if (pos < 0) {
    pos = -1 - pos;
    subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
    subtable.substitute.splice(pos, 0, 0);
  }
  subtable.substitute[pos] = substitution.by;
};
Substitution.prototype.addMultiple = function(feature, substitution, script, language) {
  check.assert(
    substitution.by instanceof Array && substitution.by.length > 1,
    'Multiple: "by" must be an array of two or more ids'
  );
  var lookupTable = this.getLookupTables(
    script,
    language,
    feature,
    2,
    true
  )[0];
  var subtable = getSubstFormat(lookupTable, 1, {
    // lookup type 2 subtable, format 1, coverage format 1
    substFormat: 1,
    coverage: { format: 1, glyphs: [] },
    sequences: []
  });
  check.assert(
    subtable.coverage.format === 1,
    "Multiple: unable to modify coverage table format " + subtable.coverage.format
  );
  var coverageGlyph = substitution.sub;
  var pos = this.binSearch(subtable.coverage.glyphs, coverageGlyph);
  if (pos < 0) {
    pos = -1 - pos;
    subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
    subtable.sequences.splice(pos, 0, 0);
  }
  subtable.sequences[pos] = substitution.by;
};
Substitution.prototype.addAlternate = function(feature, substitution, script, language) {
  var lookupTable = this.getLookupTables(
    script,
    language,
    feature,
    3,
    true
  )[0];
  var subtable = getSubstFormat(lookupTable, 1, {
    // lookup type 3 subtable, format 1, coverage format 1
    substFormat: 1,
    coverage: { format: 1, glyphs: [] },
    alternateSets: []
  });
  check.assert(
    subtable.coverage.format === 1,
    "Alternate: unable to modify coverage table format " + subtable.coverage.format
  );
  var coverageGlyph = substitution.sub;
  var pos = this.binSearch(subtable.coverage.glyphs, coverageGlyph);
  if (pos < 0) {
    pos = -1 - pos;
    subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
    subtable.alternateSets.splice(pos, 0, 0);
  }
  subtable.alternateSets[pos] = substitution.by;
};
Substitution.prototype.addLigature = function(feature, ligature, script, language) {
  var lookupTable = this.getLookupTables(
    script,
    language,
    feature,
    4,
    true
  )[0];
  var subtable = lookupTable.subtables[0];
  if (!subtable) {
    subtable = {
      // lookup type 4 subtable, format 1, coverage format 1
      substFormat: 1,
      coverage: { format: 1, glyphs: [] },
      ligatureSets: []
    };
    lookupTable.subtables[0] = subtable;
  }
  check.assert(
    subtable.coverage.format === 1,
    "Ligature: unable to modify coverage table format " + subtable.coverage.format
  );
  var coverageGlyph = ligature.sub[0];
  var ligComponents = ligature.sub.slice(1);
  var ligatureTable = {
    ligGlyph: ligature.by,
    components: ligComponents
  };
  var pos = this.binSearch(subtable.coverage.glyphs, coverageGlyph);
  if (pos >= 0) {
    var ligatureSet = subtable.ligatureSets[pos];
    for (var i = 0; i < ligatureSet.length; i++) {
      if (arraysEqual(ligatureSet[i].components, ligComponents)) {
        return;
      }
    }
    ligatureSet.push(ligatureTable);
  } else {
    pos = -1 - pos;
    subtable.coverage.glyphs.splice(pos, 0, coverageGlyph);
    subtable.ligatureSets.splice(pos, 0, [ligatureTable]);
  }
};
Substitution.prototype.getFeature = function(feature, script, language) {
  if (/ss\d\d/.test(feature)) {
    return this.getSingle(feature, script, language);
  }
  switch (feature) {
    case "aalt":
    case "salt":
      return this.getSingle(feature, script, language).concat(
        this.getAlternates(feature, script, language)
      );
    case "dlig":
    case "liga":
    case "rlig":
      return this.getLigatures(feature, script, language);
    case "ccmp":
      return this.getMultiple(feature, script, language).concat(
        this.getLigatures(feature, script, language)
      );
    case "stch":
      return this.getMultiple(feature, script, language);
  }
  return void 0;
};
Substitution.prototype.add = function(feature, sub, script, language) {
  if (/ss\d\d/.test(feature)) {
    return this.addSingle(feature, sub, script, language);
  }
  switch (feature) {
    case "aalt":
    case "salt":
      if (typeof sub.by === "number") {
        return this.addSingle(feature, sub, script, language);
      }
      return this.addAlternate(feature, sub, script, language);
    case "dlig":
    case "liga":
    case "rlig":
      return this.addLigature(feature, sub, script, language);
    case "ccmp":
      if (sub.by instanceof Array) {
        return this.addMultiple(feature, sub, script, language);
      }
      return this.addLigature(feature, sub, script, language);
  }
  return void 0;
};
function checkArgument(expression, message) {
  if (!expression) {
    throw message;
  }
}
function getByte(dataView, offset) {
  return dataView.getUint8(offset);
}
function getUShort(dataView, offset) {
  return dataView.getUint16(offset, false);
}
function getShort(dataView, offset) {
  return dataView.getInt16(offset, false);
}
function getULong(dataView, offset) {
  return dataView.getUint32(offset, false);
}
function getFixed(dataView, offset) {
  var decimal = dataView.getInt16(offset, false);
  var fraction = dataView.getUint16(offset + 2, false);
  return decimal + fraction / 65535;
}
function getTag(dataView, offset) {
  var tag = "";
  for (var i = offset; i < offset + 4; i += 1) {
    tag += String.fromCharCode(dataView.getInt8(i));
  }
  return tag;
}
function getOffset(dataView, offset, offSize) {
  var v2 = 0;
  for (var i = 0; i < offSize; i += 1) {
    v2 <<= 8;
    v2 += dataView.getUint8(offset + i);
  }
  return v2;
}
function getBytes(dataView, startOffset, endOffset) {
  var bytes = [];
  for (var i = startOffset; i < endOffset; i += 1) {
    bytes.push(dataView.getUint8(i));
  }
  return bytes;
}
function bytesToString(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}
var typeOffsets = {
  byte: 1,
  uShort: 2,
  short: 2,
  uLong: 4,
  fixed: 4,
  longDateTime: 8,
  tag: 4
};
function Parser(data, offset) {
  this.data = data;
  this.offset = offset;
  this.relativeOffset = 0;
}
Parser.prototype.parseByte = function() {
  var v2 = this.data.getUint8(this.offset + this.relativeOffset);
  this.relativeOffset += 1;
  return v2;
};
Parser.prototype.parseChar = function() {
  var v2 = this.data.getInt8(this.offset + this.relativeOffset);
  this.relativeOffset += 1;
  return v2;
};
Parser.prototype.parseCard8 = Parser.prototype.parseByte;
Parser.prototype.parseUShort = function() {
  var v2 = this.data.getUint16(this.offset + this.relativeOffset);
  this.relativeOffset += 2;
  return v2;
};
Parser.prototype.parseCard16 = Parser.prototype.parseUShort;
Parser.prototype.parseSID = Parser.prototype.parseUShort;
Parser.prototype.parseOffset16 = Parser.prototype.parseUShort;
Parser.prototype.parseShort = function() {
  var v2 = this.data.getInt16(this.offset + this.relativeOffset);
  this.relativeOffset += 2;
  return v2;
};
Parser.prototype.parseF2Dot14 = function() {
  var v2 = this.data.getInt16(this.offset + this.relativeOffset) / 16384;
  this.relativeOffset += 2;
  return v2;
};
Parser.prototype.parseULong = function() {
  var v2 = getULong(this.data, this.offset + this.relativeOffset);
  this.relativeOffset += 4;
  return v2;
};
Parser.prototype.parseOffset32 = Parser.prototype.parseULong;
Parser.prototype.parseFixed = function() {
  var v2 = getFixed(this.data, this.offset + this.relativeOffset);
  this.relativeOffset += 4;
  return v2;
};
Parser.prototype.parseString = function(length) {
  var dataView = this.data;
  var offset = this.offset + this.relativeOffset;
  var string = "";
  this.relativeOffset += length;
  for (var i = 0; i < length; i++) {
    string += String.fromCharCode(dataView.getUint8(offset + i));
  }
  return string;
};
Parser.prototype.parseTag = function() {
  return this.parseString(4);
};
Parser.prototype.parseLongDateTime = function() {
  var v2 = getULong(this.data, this.offset + this.relativeOffset + 4);
  v2 -= 2082844800;
  this.relativeOffset += 8;
  return v2;
};
Parser.prototype.parseVersion = function(minorBase) {
  var major = getUShort(this.data, this.offset + this.relativeOffset);
  var minor = getUShort(this.data, this.offset + this.relativeOffset + 2);
  this.relativeOffset += 4;
  if (minorBase === void 0) {
    minorBase = 4096;
  }
  return major + minor / minorBase / 10;
};
Parser.prototype.skip = function(type, amount) {
  if (amount === void 0) {
    amount = 1;
  }
  this.relativeOffset += typeOffsets[type] * amount;
};
Parser.prototype.parseULongList = function(count) {
  if (count === void 0) {
    count = this.parseULong();
  }
  var offsets = new Array(count);
  var dataView = this.data;
  var offset = this.offset + this.relativeOffset;
  for (var i = 0; i < count; i++) {
    offsets[i] = dataView.getUint32(offset);
    offset += 4;
  }
  this.relativeOffset += count * 4;
  return offsets;
};
Parser.prototype.parseOffset16List = Parser.prototype.parseUShortList = function(count) {
  if (count === void 0) {
    count = this.parseUShort();
  }
  var offsets = new Array(count);
  var dataView = this.data;
  var offset = this.offset + this.relativeOffset;
  for (var i = 0; i < count; i++) {
    offsets[i] = dataView.getUint16(offset);
    offset += 2;
  }
  this.relativeOffset += count * 2;
  return offsets;
};
Parser.prototype.parseShortList = function(count) {
  var list = new Array(count);
  var dataView = this.data;
  var offset = this.offset + this.relativeOffset;
  for (var i = 0; i < count; i++) {
    list[i] = dataView.getInt16(offset);
    offset += 2;
  }
  this.relativeOffset += count * 2;
  return list;
};
Parser.prototype.parseByteList = function(count) {
  var list = new Array(count);
  var dataView = this.data;
  var offset = this.offset + this.relativeOffset;
  for (var i = 0; i < count; i++) {
    list[i] = dataView.getUint8(offset++);
  }
  this.relativeOffset += count;
  return list;
};
Parser.prototype.parseList = function(count, itemCallback) {
  if (!itemCallback) {
    itemCallback = count;
    count = this.parseUShort();
  }
  var list = new Array(count);
  for (var i = 0; i < count; i++) {
    list[i] = itemCallback.call(this);
  }
  return list;
};
Parser.prototype.parseList32 = function(count, itemCallback) {
  if (!itemCallback) {
    itemCallback = count;
    count = this.parseULong();
  }
  var list = new Array(count);
  for (var i = 0; i < count; i++) {
    list[i] = itemCallback.call(this);
  }
  return list;
};
Parser.prototype.parseRecordList = function(count, recordDescription) {
  if (!recordDescription) {
    recordDescription = count;
    count = this.parseUShort();
  }
  var records = new Array(count);
  var fields = Object.keys(recordDescription);
  for (var i = 0; i < count; i++) {
    var rec = {};
    for (var j = 0; j < fields.length; j++) {
      var fieldName = fields[j];
      var fieldType = recordDescription[fieldName];
      rec[fieldName] = fieldType.call(this);
    }
    records[i] = rec;
  }
  return records;
};
Parser.prototype.parseRecordList32 = function(count, recordDescription) {
  if (!recordDescription) {
    recordDescription = count;
    count = this.parseULong();
  }
  var records = new Array(count);
  var fields = Object.keys(recordDescription);
  for (var i = 0; i < count; i++) {
    var rec = {};
    for (var j = 0; j < fields.length; j++) {
      var fieldName = fields[j];
      var fieldType = recordDescription[fieldName];
      rec[fieldName] = fieldType.call(this);
    }
    records[i] = rec;
  }
  return records;
};
Parser.prototype.parseStruct = function(description) {
  if (typeof description === "function") {
    return description.call(this);
  } else {
    var fields = Object.keys(description);
    var struct = {};
    for (var j = 0; j < fields.length; j++) {
      var fieldName = fields[j];
      var fieldType = description[fieldName];
      struct[fieldName] = fieldType.call(this);
    }
    return struct;
  }
};
Parser.prototype.parseValueRecord = function(valueFormat) {
  if (valueFormat === void 0) {
    valueFormat = this.parseUShort();
  }
  if (valueFormat === 0) {
    return;
  }
  var valueRecord = {};
  if (valueFormat & 1) {
    valueRecord.xPlacement = this.parseShort();
  }
  if (valueFormat & 2) {
    valueRecord.yPlacement = this.parseShort();
  }
  if (valueFormat & 4) {
    valueRecord.xAdvance = this.parseShort();
  }
  if (valueFormat & 8) {
    valueRecord.yAdvance = this.parseShort();
  }
  if (valueFormat & 16) {
    valueRecord.xPlaDevice = void 0;
    this.parseShort();
  }
  if (valueFormat & 32) {
    valueRecord.yPlaDevice = void 0;
    this.parseShort();
  }
  if (valueFormat & 64) {
    valueRecord.xAdvDevice = void 0;
    this.parseShort();
  }
  if (valueFormat & 128) {
    valueRecord.yAdvDevice = void 0;
    this.parseShort();
  }
  return valueRecord;
};
Parser.prototype.parseValueRecordList = function() {
  var valueFormat = this.parseUShort();
  var valueCount = this.parseUShort();
  var values = new Array(valueCount);
  for (var i = 0; i < valueCount; i++) {
    values[i] = this.parseValueRecord(valueFormat);
  }
  return values;
};
Parser.prototype.parsePointer = function(description) {
  var structOffset = this.parseOffset16();
  if (structOffset > 0) {
    return new Parser(this.data, this.offset + structOffset).parseStruct(description);
  }
  return void 0;
};
Parser.prototype.parsePointer32 = function(description) {
  var structOffset = this.parseOffset32();
  if (structOffset > 0) {
    return new Parser(this.data, this.offset + structOffset).parseStruct(description);
  }
  return void 0;
};
Parser.prototype.parseListOfLists = function(itemCallback) {
  var offsets = this.parseOffset16List();
  var count = offsets.length;
  var relativeOffset = this.relativeOffset;
  var list = new Array(count);
  for (var i = 0; i < count; i++) {
    var start = offsets[i];
    if (start === 0) {
      list[i] = void 0;
      continue;
    }
    this.relativeOffset = start;
    if (itemCallback) {
      var subOffsets = this.parseOffset16List();
      var subList = new Array(subOffsets.length);
      for (var j = 0; j < subOffsets.length; j++) {
        this.relativeOffset = start + subOffsets[j];
        subList[j] = itemCallback.call(this);
      }
      list[i] = subList;
    } else {
      list[i] = this.parseUShortList();
    }
  }
  this.relativeOffset = relativeOffset;
  return list;
};
Parser.prototype.parseCoverage = function() {
  var startOffset = this.offset + this.relativeOffset;
  var format = this.parseUShort();
  var count = this.parseUShort();
  if (format === 1) {
    return {
      format: 1,
      glyphs: this.parseUShortList(count)
    };
  } else if (format === 2) {
    var ranges = new Array(count);
    for (var i = 0; i < count; i++) {
      ranges[i] = {
        start: this.parseUShort(),
        end: this.parseUShort(),
        index: this.parseUShort()
      };
    }
    return {
      format: 2,
      ranges
    };
  }
  throw new Error("0x" + startOffset.toString(16) + ": Coverage format must be 1 or 2.");
};
Parser.prototype.parseClassDef = function() {
  var startOffset = this.offset + this.relativeOffset;
  var format = this.parseUShort();
  if (format === 1) {
    return {
      format: 1,
      startGlyph: this.parseUShort(),
      classes: this.parseUShortList()
    };
  } else if (format === 2) {
    return {
      format: 2,
      ranges: this.parseRecordList({
        start: Parser.uShort,
        end: Parser.uShort,
        classId: Parser.uShort
      })
    };
  }
  throw new Error("0x" + startOffset.toString(16) + ": ClassDef format must be 1 or 2.");
};
Parser.list = function(count, itemCallback) {
  return function() {
    return this.parseList(count, itemCallback);
  };
};
Parser.list32 = function(count, itemCallback) {
  return function() {
    return this.parseList32(count, itemCallback);
  };
};
Parser.recordList = function(count, recordDescription) {
  return function() {
    return this.parseRecordList(count, recordDescription);
  };
};
Parser.recordList32 = function(count, recordDescription) {
  return function() {
    return this.parseRecordList32(count, recordDescription);
  };
};
Parser.pointer = function(description) {
  return function() {
    return this.parsePointer(description);
  };
};
Parser.pointer32 = function(description) {
  return function() {
    return this.parsePointer32(description);
  };
};
Parser.tag = Parser.prototype.parseTag;
Parser.byte = Parser.prototype.parseByte;
Parser.uShort = Parser.offset16 = Parser.prototype.parseUShort;
Parser.uShortList = Parser.prototype.parseUShortList;
Parser.uLong = Parser.offset32 = Parser.prototype.parseULong;
Parser.uLongList = Parser.prototype.parseULongList;
Parser.struct = Parser.prototype.parseStruct;
Parser.coverage = Parser.prototype.parseCoverage;
Parser.classDef = Parser.prototype.parseClassDef;
var langSysTable = {
  reserved: Parser.uShort,
  reqFeatureIndex: Parser.uShort,
  featureIndexes: Parser.uShortList
};
Parser.prototype.parseScriptList = function() {
  return this.parsePointer(Parser.recordList({
    tag: Parser.tag,
    script: Parser.pointer({
      defaultLangSys: Parser.pointer(langSysTable),
      langSysRecords: Parser.recordList({
        tag: Parser.tag,
        langSys: Parser.pointer(langSysTable)
      })
    })
  })) || [];
};
Parser.prototype.parseFeatureList = function() {
  return this.parsePointer(Parser.recordList({
    tag: Parser.tag,
    feature: Parser.pointer({
      featureParams: Parser.offset16,
      lookupListIndexes: Parser.uShortList
    })
  })) || [];
};
Parser.prototype.parseLookupList = function(lookupTableParsers) {
  return this.parsePointer(Parser.list(Parser.pointer(function() {
    var lookupType = this.parseUShort();
    check.argument(1 <= lookupType && lookupType <= 9, "GPOS/GSUB lookup type " + lookupType + " unknown.");
    var lookupFlag = this.parseUShort();
    var useMarkFilteringSet = lookupFlag & 16;
    return {
      lookupType,
      lookupFlag,
      subtables: this.parseList(Parser.pointer(lookupTableParsers[lookupType])),
      markFilteringSet: useMarkFilteringSet ? this.parseUShort() : void 0
    };
  }))) || [];
};
Parser.prototype.parseFeatureVariationsList = function() {
  return this.parsePointer32(function() {
    var majorVersion = this.parseUShort();
    var minorVersion = this.parseUShort();
    check.argument(majorVersion === 1 && minorVersion < 1, "GPOS/GSUB feature variations table unknown.");
    var featureVariations = this.parseRecordList32({
      conditionSetOffset: Parser.offset32,
      featureTableSubstitutionOffset: Parser.offset32
    });
    return featureVariations;
  }) || [];
};
var parse = {
  getByte,
  getCard8: getByte,
  getUShort,
  getCard16: getUShort,
  getShort,
  getULong,
  getFixed,
  getTag,
  getOffset,
  getBytes,
  bytesToString,
  Parser
};
function parseGlyphCoordinate(p, flag, previousValue, shortVectorBitMask, sameBitMask) {
  var v2;
  if ((flag & shortVectorBitMask) > 0) {
    v2 = p.parseByte();
    if ((flag & sameBitMask) === 0) {
      v2 = -v2;
    }
    v2 = previousValue + v2;
  } else {
    if ((flag & sameBitMask) > 0) {
      v2 = previousValue;
    } else {
      v2 = previousValue + p.parseShort();
    }
  }
  return v2;
}
function parseGlyph(glyph, data, start) {
  var p = new parse.Parser(data, start);
  glyph.numberOfContours = p.parseShort();
  glyph._xMin = p.parseShort();
  glyph._yMin = p.parseShort();
  glyph._xMax = p.parseShort();
  glyph._yMax = p.parseShort();
  var flags;
  var flag;
  if (glyph.numberOfContours > 0) {
    var endPointIndices = glyph.endPointIndices = [];
    for (var i = 0; i < glyph.numberOfContours; i += 1) {
      endPointIndices.push(p.parseUShort());
    }
    glyph.instructionLength = p.parseUShort();
    glyph.instructions = [];
    for (var i$1 = 0; i$1 < glyph.instructionLength; i$1 += 1) {
      glyph.instructions.push(p.parseByte());
    }
    var numberOfCoordinates = endPointIndices[endPointIndices.length - 1] + 1;
    flags = [];
    for (var i$2 = 0; i$2 < numberOfCoordinates; i$2 += 1) {
      flag = p.parseByte();
      flags.push(flag);
      if ((flag & 8) > 0) {
        var repeatCount = p.parseByte();
        for (var j = 0; j < repeatCount; j += 1) {
          flags.push(flag);
          i$2 += 1;
        }
      }
    }
    check.argument(flags.length === numberOfCoordinates, "Bad flags.");
    if (endPointIndices.length > 0) {
      var points = [];
      var point;
      if (numberOfCoordinates > 0) {
        for (var i$3 = 0; i$3 < numberOfCoordinates; i$3 += 1) {
          flag = flags[i$3];
          point = {};
          point.onCurve = !!(flag & 1);
          point.lastPointOfContour = endPointIndices.indexOf(i$3) >= 0;
          points.push(point);
        }
        var px = 0;
        for (var i$4 = 0; i$4 < numberOfCoordinates; i$4 += 1) {
          flag = flags[i$4];
          point = points[i$4];
          point.x = parseGlyphCoordinate(p, flag, px, 2, 16);
          px = point.x;
        }
        var py = 0;
        for (var i$5 = 0; i$5 < numberOfCoordinates; i$5 += 1) {
          flag = flags[i$5];
          point = points[i$5];
          point.y = parseGlyphCoordinate(p, flag, py, 4, 32);
          py = point.y;
        }
      }
      glyph.points = points;
    } else {
      glyph.points = [];
    }
  } else if (glyph.numberOfContours === 0) {
    glyph.points = [];
  } else {
    glyph.isComposite = true;
    glyph.points = [];
    glyph.components = [];
    var moreComponents = true;
    while (moreComponents) {
      flags = p.parseUShort();
      var component = {
        glyphIndex: p.parseUShort(),
        xScale: 1,
        scale01: 0,
        scale10: 0,
        yScale: 1,
        dx: 0,
        dy: 0
      };
      if ((flags & 1) > 0) {
        if ((flags & 2) > 0) {
          component.dx = p.parseShort();
          component.dy = p.parseShort();
        } else {
          component.matchedPoints = [p.parseUShort(), p.parseUShort()];
        }
      } else {
        if ((flags & 2) > 0) {
          component.dx = p.parseChar();
          component.dy = p.parseChar();
        } else {
          component.matchedPoints = [p.parseByte(), p.parseByte()];
        }
      }
      if ((flags & 8) > 0) {
        component.xScale = component.yScale = p.parseF2Dot14();
      } else if ((flags & 64) > 0) {
        component.xScale = p.parseF2Dot14();
        component.yScale = p.parseF2Dot14();
      } else if ((flags & 128) > 0) {
        component.xScale = p.parseF2Dot14();
        component.scale01 = p.parseF2Dot14();
        component.scale10 = p.parseF2Dot14();
        component.yScale = p.parseF2Dot14();
      }
      glyph.components.push(component);
      moreComponents = !!(flags & 32);
    }
    if (flags & 256) {
      glyph.instructionLength = p.parseUShort();
      glyph.instructions = [];
      for (var i$6 = 0; i$6 < glyph.instructionLength; i$6 += 1) {
        glyph.instructions.push(p.parseByte());
      }
    }
  }
}
function transformPoints(points, transform) {
  var newPoints = [];
  for (var i = 0; i < points.length; i += 1) {
    var pt2 = points[i];
    var newPt = {
      x: transform.xScale * pt2.x + transform.scale01 * pt2.y + transform.dx,
      y: transform.scale10 * pt2.x + transform.yScale * pt2.y + transform.dy,
      onCurve: pt2.onCurve,
      lastPointOfContour: pt2.lastPointOfContour
    };
    newPoints.push(newPt);
  }
  return newPoints;
}
function getContours(points) {
  var contours = [];
  var currentContour = [];
  for (var i = 0; i < points.length; i += 1) {
    var pt2 = points[i];
    currentContour.push(pt2);
    if (pt2.lastPointOfContour) {
      contours.push(currentContour);
      currentContour = [];
    }
  }
  check.argument(currentContour.length === 0, "There are still points left in the current contour.");
  return contours;
}
function getPath(points) {
  var p = new Path();
  if (!points) {
    return p;
  }
  var contours = getContours(points);
  for (var contourIndex = 0; contourIndex < contours.length; ++contourIndex) {
    var contour = contours[contourIndex];
    var prev = null;
    var curr = contour[contour.length - 1];
    var next = contour[0];
    if (curr.onCurve) {
      p.moveTo(curr.x, curr.y);
    } else {
      if (next.onCurve) {
        p.moveTo(next.x, next.y);
      } else {
        var start = { x: (curr.x + next.x) * 0.5, y: (curr.y + next.y) * 0.5 };
        p.moveTo(start.x, start.y);
      }
    }
    for (var i = 0; i < contour.length; ++i) {
      prev = curr;
      curr = next;
      next = contour[(i + 1) % contour.length];
      if (curr.onCurve) {
        p.lineTo(curr.x, curr.y);
      } else {
        var prev2 = prev;
        var next2 = next;
        if (!prev.onCurve) {
          prev2 = { x: (curr.x + prev.x) * 0.5, y: (curr.y + prev.y) * 0.5 };
        }
        if (!next.onCurve) {
          next2 = { x: (curr.x + next.x) * 0.5, y: (curr.y + next.y) * 0.5 };
        }
        p.quadraticCurveTo(curr.x, curr.y, next2.x, next2.y);
      }
    }
    p.closePath();
  }
  return p;
}
function buildPath(glyphs, glyph) {
  if (glyph.isComposite) {
    for (var j = 0; j < glyph.components.length; j += 1) {
      var component = glyph.components[j];
      var componentGlyph = glyphs.get(component.glyphIndex);
      componentGlyph.getPath();
      if (componentGlyph.points) {
        var transformedPoints = void 0;
        if (component.matchedPoints === void 0) {
          transformedPoints = transformPoints(componentGlyph.points, component);
        } else {
          if (component.matchedPoints[0] > glyph.points.length - 1 || component.matchedPoints[1] > componentGlyph.points.length - 1) {
            throw Error("Matched points out of range in " + glyph.name);
          }
          var firstPt = glyph.points[component.matchedPoints[0]];
          var secondPt = componentGlyph.points[component.matchedPoints[1]];
          var transform = {
            xScale: component.xScale,
            scale01: component.scale01,
            scale10: component.scale10,
            yScale: component.yScale,
            dx: 0,
            dy: 0
          };
          secondPt = transformPoints([secondPt], transform)[0];
          transform.dx = firstPt.x - secondPt.x;
          transform.dy = firstPt.y - secondPt.y;
          transformedPoints = transformPoints(componentGlyph.points, transform);
        }
        glyph.points = glyph.points.concat(transformedPoints);
      }
    }
  }
  return getPath(glyph.points);
}
function parseGlyfTableAll(data, start, loca2, font) {
  var glyphs = new glyphset.GlyphSet(font);
  for (var i = 0; i < loca2.length - 1; i += 1) {
    var offset = loca2[i];
    var nextOffset = loca2[i + 1];
    if (offset !== nextOffset) {
      glyphs.push(i, glyphset.ttfGlyphLoader(font, i, parseGlyph, data, start + offset, buildPath));
    } else {
      glyphs.push(i, glyphset.glyphLoader(font, i));
    }
  }
  return glyphs;
}
function parseGlyfTableOnLowMemory(data, start, loca2, font) {
  var glyphs = new glyphset.GlyphSet(font);
  font._push = function(i) {
    var offset = loca2[i];
    var nextOffset = loca2[i + 1];
    if (offset !== nextOffset) {
      glyphs.push(i, glyphset.ttfGlyphLoader(font, i, parseGlyph, data, start + offset, buildPath));
    } else {
      glyphs.push(i, glyphset.glyphLoader(font, i));
    }
  };
  return glyphs;
}
function parseGlyfTable(data, start, loca2, font, opt) {
  if (opt.lowMemory) {
    return parseGlyfTableOnLowMemory(data, start, loca2, font);
  } else {
    return parseGlyfTableAll(data, start, loca2, font);
  }
}
var glyf = { getPath, parse: parseGlyfTable };
var instructionTable;
var exec;
var execGlyph;
var execComponent;
function Hinting(font) {
  this.font = font;
  this.getCommands = function(hPoints) {
    return glyf.getPath(hPoints).commands;
  };
  this._fpgmState = this._prepState = void 0;
  this._errorState = 0;
}
function roundOff(v2) {
  return v2;
}
function roundToGrid(v2) {
  return Math.sign(v2) * Math.round(Math.abs(v2));
}
function roundToDoubleGrid(v2) {
  return Math.sign(v2) * Math.round(Math.abs(v2 * 2)) / 2;
}
function roundToHalfGrid(v2) {
  return Math.sign(v2) * (Math.round(Math.abs(v2) + 0.5) - 0.5);
}
function roundUpToGrid(v2) {
  return Math.sign(v2) * Math.ceil(Math.abs(v2));
}
function roundDownToGrid(v2) {
  return Math.sign(v2) * Math.floor(Math.abs(v2));
}
var roundSuper = function(v2) {
  var period = this.srPeriod;
  var phase = this.srPhase;
  var threshold = this.srThreshold;
  var sign = 1;
  if (v2 < 0) {
    v2 = -v2;
    sign = -1;
  }
  v2 += threshold - phase;
  v2 = Math.trunc(v2 / period) * period;
  v2 += phase;
  if (v2 < 0) {
    return phase * sign;
  }
  return v2 * sign;
};
var xUnitVector = {
  x: 1,
  y: 0,
  axis: "x",
  // Gets the projected distance between two points.
  // o1/o2 ... if true, respective original position is used.
  distance: function(p1, p2, o1, o2) {
    return (o1 ? p1.xo : p1.x) - (o2 ? p2.xo : p2.x);
  },
  // Moves point p so the moved position has the same relative
  // position to the moved positions of rp1 and rp2 than the
  // original positions had.
  //
  // See APPENDIX on INTERPOLATE at the bottom of this file.
  interpolate: function(p, rp1, rp2, pv2) {
    var do1;
    var do2;
    var doa1;
    var doa2;
    var dm1;
    var dm2;
    var dt2;
    if (!pv2 || pv2 === this) {
      do1 = p.xo - rp1.xo;
      do2 = p.xo - rp2.xo;
      dm1 = rp1.x - rp1.xo;
      dm2 = rp2.x - rp2.xo;
      doa1 = Math.abs(do1);
      doa2 = Math.abs(do2);
      dt2 = doa1 + doa2;
      if (dt2 === 0) {
        p.x = p.xo + (dm1 + dm2) / 2;
        return;
      }
      p.x = p.xo + (dm1 * doa2 + dm2 * doa1) / dt2;
      return;
    }
    do1 = pv2.distance(p, rp1, true, true);
    do2 = pv2.distance(p, rp2, true, true);
    dm1 = pv2.distance(rp1, rp1, false, true);
    dm2 = pv2.distance(rp2, rp2, false, true);
    doa1 = Math.abs(do1);
    doa2 = Math.abs(do2);
    dt2 = doa1 + doa2;
    if (dt2 === 0) {
      xUnitVector.setRelative(p, p, (dm1 + dm2) / 2, pv2, true);
      return;
    }
    xUnitVector.setRelative(p, p, (dm1 * doa2 + dm2 * doa1) / dt2, pv2, true);
  },
  // Slope of line normal to this
  normalSlope: Number.NEGATIVE_INFINITY,
  // Sets the point 'p' relative to point 'rp'
  // by the distance 'd'.
  //
  // See APPENDIX on SETRELATIVE at the bottom of this file.
  //
  // p   ... point to set
  // rp  ... reference point
  // d   ... distance on projection vector
  // pv  ... projection vector (undefined = this)
  // org ... if true, uses the original position of rp as reference.
  setRelative: function(p, rp2, d2, pv2, org) {
    if (!pv2 || pv2 === this) {
      p.x = (org ? rp2.xo : rp2.x) + d2;
      return;
    }
    var rpx = org ? rp2.xo : rp2.x;
    var rpy = org ? rp2.yo : rp2.y;
    var rpdx = rpx + d2 * pv2.x;
    var rpdy = rpy + d2 * pv2.y;
    p.x = rpdx + (p.y - rpdy) / pv2.normalSlope;
  },
  // Slope of vector line.
  slope: 0,
  // Touches the point p.
  touch: function(p) {
    p.xTouched = true;
  },
  // Tests if a point p is touched.
  touched: function(p) {
    return p.xTouched;
  },
  // Untouches the point p.
  untouch: function(p) {
    p.xTouched = false;
  }
};
var yUnitVector = {
  x: 0,
  y: 1,
  axis: "y",
  // Gets the projected distance between two points.
  // o1/o2 ... if true, respective original position is used.
  distance: function(p1, p2, o1, o2) {
    return (o1 ? p1.yo : p1.y) - (o2 ? p2.yo : p2.y);
  },
  // Moves point p so the moved position has the same relative
  // position to the moved positions of rp1 and rp2 than the
  // original positions had.
  //
  // See APPENDIX on INTERPOLATE at the bottom of this file.
  interpolate: function(p, rp1, rp2, pv2) {
    var do1;
    var do2;
    var doa1;
    var doa2;
    var dm1;
    var dm2;
    var dt2;
    if (!pv2 || pv2 === this) {
      do1 = p.yo - rp1.yo;
      do2 = p.yo - rp2.yo;
      dm1 = rp1.y - rp1.yo;
      dm2 = rp2.y - rp2.yo;
      doa1 = Math.abs(do1);
      doa2 = Math.abs(do2);
      dt2 = doa1 + doa2;
      if (dt2 === 0) {
        p.y = p.yo + (dm1 + dm2) / 2;
        return;
      }
      p.y = p.yo + (dm1 * doa2 + dm2 * doa1) / dt2;
      return;
    }
    do1 = pv2.distance(p, rp1, true, true);
    do2 = pv2.distance(p, rp2, true, true);
    dm1 = pv2.distance(rp1, rp1, false, true);
    dm2 = pv2.distance(rp2, rp2, false, true);
    doa1 = Math.abs(do1);
    doa2 = Math.abs(do2);
    dt2 = doa1 + doa2;
    if (dt2 === 0) {
      yUnitVector.setRelative(p, p, (dm1 + dm2) / 2, pv2, true);
      return;
    }
    yUnitVector.setRelative(p, p, (dm1 * doa2 + dm2 * doa1) / dt2, pv2, true);
  },
  // Slope of line normal to this.
  normalSlope: 0,
  // Sets the point 'p' relative to point 'rp'
  // by the distance 'd'
  //
  // See APPENDIX on SETRELATIVE at the bottom of this file.
  //
  // p   ... point to set
  // rp  ... reference point
  // d   ... distance on projection vector
  // pv  ... projection vector (undefined = this)
  // org ... if true, uses the original position of rp as reference.
  setRelative: function(p, rp2, d2, pv2, org) {
    if (!pv2 || pv2 === this) {
      p.y = (org ? rp2.yo : rp2.y) + d2;
      return;
    }
    var rpx = org ? rp2.xo : rp2.x;
    var rpy = org ? rp2.yo : rp2.y;
    var rpdx = rpx + d2 * pv2.x;
    var rpdy = rpy + d2 * pv2.y;
    p.y = rpdy + pv2.normalSlope * (p.x - rpdx);
  },
  // Slope of vector line.
  slope: Number.POSITIVE_INFINITY,
  // Touches the point p.
  touch: function(p) {
    p.yTouched = true;
  },
  // Tests if a point p is touched.
  touched: function(p) {
    return p.yTouched;
  },
  // Untouches the point p.
  untouch: function(p) {
    p.yTouched = false;
  }
};
Object.freeze(xUnitVector);
Object.freeze(yUnitVector);
function UnitVector(x2, y) {
  this.x = x2;
  this.y = y;
  this.axis = void 0;
  this.slope = y / x2;
  this.normalSlope = -x2 / y;
  Object.freeze(this);
}
UnitVector.prototype.distance = function(p1, p2, o1, o2) {
  return this.x * xUnitVector.distance(p1, p2, o1, o2) + this.y * yUnitVector.distance(p1, p2, o1, o2);
};
UnitVector.prototype.interpolate = function(p, rp1, rp2, pv2) {
  var dm1;
  var dm2;
  var do1;
  var do2;
  var doa1;
  var doa2;
  var dt2;
  do1 = pv2.distance(p, rp1, true, true);
  do2 = pv2.distance(p, rp2, true, true);
  dm1 = pv2.distance(rp1, rp1, false, true);
  dm2 = pv2.distance(rp2, rp2, false, true);
  doa1 = Math.abs(do1);
  doa2 = Math.abs(do2);
  dt2 = doa1 + doa2;
  if (dt2 === 0) {
    this.setRelative(p, p, (dm1 + dm2) / 2, pv2, true);
    return;
  }
  this.setRelative(p, p, (dm1 * doa2 + dm2 * doa1) / dt2, pv2, true);
};
UnitVector.prototype.setRelative = function(p, rp2, d2, pv2, org) {
  pv2 = pv2 || this;
  var rpx = org ? rp2.xo : rp2.x;
  var rpy = org ? rp2.yo : rp2.y;
  var rpdx = rpx + d2 * pv2.x;
  var rpdy = rpy + d2 * pv2.y;
  var pvns = pv2.normalSlope;
  var fvs = this.slope;
  var px = p.x;
  var py = p.y;
  p.x = (fvs * px - pvns * rpdx + rpdy - py) / (fvs - pvns);
  p.y = fvs * (p.x - px) + py;
};
UnitVector.prototype.touch = function(p) {
  p.xTouched = true;
  p.yTouched = true;
};
function getUnitVector(x2, y) {
  var d2 = Math.sqrt(x2 * x2 + y * y);
  x2 /= d2;
  y /= d2;
  if (x2 === 1 && y === 0) {
    return xUnitVector;
  } else if (x2 === 0 && y === 1) {
    return yUnitVector;
  } else {
    return new UnitVector(x2, y);
  }
}
function HPoint(x2, y, lastPointOfContour, onCurve) {
  this.x = this.xo = Math.round(x2 * 64) / 64;
  this.y = this.yo = Math.round(y * 64) / 64;
  this.lastPointOfContour = lastPointOfContour;
  this.onCurve = onCurve;
  this.prevPointOnContour = void 0;
  this.nextPointOnContour = void 0;
  this.xTouched = false;
  this.yTouched = false;
  Object.preventExtensions(this);
}
HPoint.prototype.nextTouched = function(v2) {
  var p = this.nextPointOnContour;
  while (!v2.touched(p) && p !== this) {
    p = p.nextPointOnContour;
  }
  return p;
};
HPoint.prototype.prevTouched = function(v2) {
  var p = this.prevPointOnContour;
  while (!v2.touched(p) && p !== this) {
    p = p.prevPointOnContour;
  }
  return p;
};
var HPZero = Object.freeze(new HPoint(0, 0));
var defaultState = {
  cvCutIn: 17 / 16,
  // control value cut in
  deltaBase: 9,
  deltaShift: 0.125,
  loop: 1,
  // loops some instructions
  minDis: 1,
  // minimum distance
  autoFlip: true
};
function State(env, prog) {
  this.env = env;
  this.stack = [];
  this.prog = prog;
  switch (env) {
    case "glyf":
      this.zp0 = this.zp1 = this.zp2 = 1;
      this.rp0 = this.rp1 = this.rp2 = 0;
    case "prep":
      this.fv = this.pv = this.dpv = xUnitVector;
      this.round = roundToGrid;
  }
}
Hinting.prototype.exec = function(glyph, ppem) {
  if (typeof ppem !== "number") {
    throw new Error("Point size is not a number!");
  }
  if (this._errorState > 2) {
    return;
  }
  var font = this.font;
  var prepState = this._prepState;
  if (!prepState || prepState.ppem !== ppem) {
    var fpgmState = this._fpgmState;
    if (!fpgmState) {
      State.prototype = defaultState;
      fpgmState = this._fpgmState = new State("fpgm", font.tables.fpgm);
      fpgmState.funcs = [];
      fpgmState.font = font;
      if (exports.DEBUG) {
        console.log("---EXEC FPGM---");
        fpgmState.step = -1;
      }
      try {
        exec(fpgmState);
      } catch (e) {
        console.log("Hinting error in FPGM:" + e);
        this._errorState = 3;
        return;
      }
    }
    State.prototype = fpgmState;
    prepState = this._prepState = new State("prep", font.tables.prep);
    prepState.ppem = ppem;
    var oCvt = font.tables.cvt;
    if (oCvt) {
      var cvt = prepState.cvt = new Array(oCvt.length);
      var scale = ppem / font.unitsPerEm;
      for (var c2 = 0; c2 < oCvt.length; c2++) {
        cvt[c2] = oCvt[c2] * scale;
      }
    } else {
      prepState.cvt = [];
    }
    if (exports.DEBUG) {
      console.log("---EXEC PREP---");
      prepState.step = -1;
    }
    try {
      exec(prepState);
    } catch (e) {
      if (this._errorState < 2) {
        console.log("Hinting error in PREP:" + e);
      }
      this._errorState = 2;
    }
  }
  if (this._errorState > 1) {
    return;
  }
  try {
    return execGlyph(glyph, prepState);
  } catch (e) {
    if (this._errorState < 1) {
      console.log("Hinting error:" + e);
      console.log("Note: further hinting errors are silenced");
    }
    this._errorState = 1;
    return void 0;
  }
};
execGlyph = function(glyph, prepState) {
  var xScale = prepState.ppem / prepState.font.unitsPerEm;
  var yScale = xScale;
  var components = glyph.components;
  var contours;
  var gZone;
  var state;
  State.prototype = prepState;
  if (!components) {
    state = new State("glyf", glyph.instructions);
    if (exports.DEBUG) {
      console.log("---EXEC GLYPH---");
      state.step = -1;
    }
    execComponent(glyph, state, xScale, yScale);
    gZone = state.gZone;
  } else {
    var font = prepState.font;
    gZone = [];
    contours = [];
    for (var i = 0; i < components.length; i++) {
      var c2 = components[i];
      var cg = font.glyphs.get(c2.glyphIndex);
      state = new State("glyf", cg.instructions);
      if (exports.DEBUG) {
        console.log("---EXEC COMP " + i + "---");
        state.step = -1;
      }
      execComponent(cg, state, xScale, yScale);
      var dx = Math.round(c2.dx * xScale);
      var dy = Math.round(c2.dy * yScale);
      var gz = state.gZone;
      var cc2 = state.contours;
      for (var pi2 = 0; pi2 < gz.length; pi2++) {
        var p = gz[pi2];
        p.xTouched = p.yTouched = false;
        p.xo = p.x = p.x + dx;
        p.yo = p.y = p.y + dy;
      }
      var gLen = gZone.length;
      gZone.push.apply(gZone, gz);
      for (var j = 0; j < cc2.length; j++) {
        contours.push(cc2[j] + gLen);
      }
    }
    if (glyph.instructions && !state.inhibitGridFit) {
      state = new State("glyf", glyph.instructions);
      state.gZone = state.z0 = state.z1 = state.z2 = gZone;
      state.contours = contours;
      gZone.push(
        new HPoint(0, 0),
        new HPoint(Math.round(glyph.advanceWidth * xScale), 0)
      );
      if (exports.DEBUG) {
        console.log("---EXEC COMPOSITE---");
        state.step = -1;
      }
      exec(state);
      gZone.length -= 2;
    }
  }
  return gZone;
};
execComponent = function(glyph, state, xScale, yScale) {
  var points = glyph.points || [];
  var pLen = points.length;
  var gZone = state.gZone = state.z0 = state.z1 = state.z2 = [];
  var contours = state.contours = [];
  var cp2;
  for (var i = 0; i < pLen; i++) {
    cp2 = points[i];
    gZone[i] = new HPoint(
      cp2.x * xScale,
      cp2.y * yScale,
      cp2.lastPointOfContour,
      cp2.onCurve
    );
  }
  var sp2;
  var np2;
  for (var i$1 = 0; i$1 < pLen; i$1++) {
    cp2 = gZone[i$1];
    if (!sp2) {
      sp2 = cp2;
      contours.push(i$1);
    }
    if (cp2.lastPointOfContour) {
      cp2.nextPointOnContour = sp2;
      sp2.prevPointOnContour = cp2;
      sp2 = void 0;
    } else {
      np2 = gZone[i$1 + 1];
      cp2.nextPointOnContour = np2;
      np2.prevPointOnContour = cp2;
    }
  }
  if (state.inhibitGridFit) {
    return;
  }
  if (exports.DEBUG) {
    console.log("PROCESSING GLYPH", state.stack);
    for (var i$2 = 0; i$2 < pLen; i$2++) {
      console.log(i$2, gZone[i$2].x, gZone[i$2].y);
    }
  }
  gZone.push(
    new HPoint(0, 0),
    new HPoint(Math.round(glyph.advanceWidth * xScale), 0)
  );
  exec(state);
  gZone.length -= 2;
  if (exports.DEBUG) {
    console.log("FINISHED GLYPH", state.stack);
    for (var i$3 = 0; i$3 < pLen; i$3++) {
      console.log(i$3, gZone[i$3].x, gZone[i$3].y);
    }
  }
};
exec = function(state) {
  var prog = state.prog;
  if (!prog) {
    return;
  }
  var pLen = prog.length;
  var ins;
  for (state.ip = 0; state.ip < pLen; state.ip++) {
    if (exports.DEBUG) {
      state.step++;
    }
    ins = instructionTable[prog[state.ip]];
    if (!ins) {
      throw new Error(
        "unknown instruction: 0x" + Number(prog[state.ip]).toString(16)
      );
    }
    ins(state);
  }
};
function initTZone(state) {
  var tZone = state.tZone = new Array(state.gZone.length);
  for (var i = 0; i < tZone.length; i++) {
    tZone[i] = new HPoint(0, 0);
  }
}
function skip(state, handleElse) {
  var prog = state.prog;
  var ip2 = state.ip;
  var nesting = 1;
  var ins;
  do {
    ins = prog[++ip2];
    if (ins === 88) {
      nesting++;
    } else if (ins === 89) {
      nesting--;
    } else if (ins === 64) {
      ip2 += prog[ip2 + 1] + 1;
    } else if (ins === 65) {
      ip2 += 2 * prog[ip2 + 1] + 1;
    } else if (ins >= 176 && ins <= 183) {
      ip2 += ins - 176 + 1;
    } else if (ins >= 184 && ins <= 191) {
      ip2 += (ins - 184 + 1) * 2;
    } else if (handleElse && nesting === 1 && ins === 27) {
      break;
    }
  } while (nesting > 0);
  state.ip = ip2;
}
function SVTCA(v2, state) {
  if (exports.DEBUG) {
    console.log(state.step, "SVTCA[" + v2.axis + "]");
  }
  state.fv = state.pv = state.dpv = v2;
}
function SPVTCA(v2, state) {
  if (exports.DEBUG) {
    console.log(state.step, "SPVTCA[" + v2.axis + "]");
  }
  state.pv = state.dpv = v2;
}
function SFVTCA(v2, state) {
  if (exports.DEBUG) {
    console.log(state.step, "SFVTCA[" + v2.axis + "]");
  }
  state.fv = v2;
}
function SPVTL(a, state) {
  var stack = state.stack;
  var p2i = stack.pop();
  var p1i = stack.pop();
  var p2 = state.z2[p2i];
  var p1 = state.z1[p1i];
  if (exports.DEBUG) {
    console.log("SPVTL[" + a + "]", p2i, p1i);
  }
  var dx;
  var dy;
  if (!a) {
    dx = p1.x - p2.x;
    dy = p1.y - p2.y;
  } else {
    dx = p2.y - p1.y;
    dy = p1.x - p2.x;
  }
  state.pv = state.dpv = getUnitVector(dx, dy);
}
function SFVTL(a, state) {
  var stack = state.stack;
  var p2i = stack.pop();
  var p1i = stack.pop();
  var p2 = state.z2[p2i];
  var p1 = state.z1[p1i];
  if (exports.DEBUG) {
    console.log("SFVTL[" + a + "]", p2i, p1i);
  }
  var dx;
  var dy;
  if (!a) {
    dx = p1.x - p2.x;
    dy = p1.y - p2.y;
  } else {
    dx = p2.y - p1.y;
    dy = p1.x - p2.x;
  }
  state.fv = getUnitVector(dx, dy);
}
function SPVFS(state) {
  var stack = state.stack;
  var y = stack.pop();
  var x2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SPVFS[]", y, x2);
  }
  state.pv = state.dpv = getUnitVector(x2, y);
}
function SFVFS(state) {
  var stack = state.stack;
  var y = stack.pop();
  var x2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SPVFS[]", y, x2);
  }
  state.fv = getUnitVector(x2, y);
}
function GPV(state) {
  var stack = state.stack;
  var pv2 = state.pv;
  if (exports.DEBUG) {
    console.log(state.step, "GPV[]");
  }
  stack.push(pv2.x * 16384);
  stack.push(pv2.y * 16384);
}
function GFV(state) {
  var stack = state.stack;
  var fv = state.fv;
  if (exports.DEBUG) {
    console.log(state.step, "GFV[]");
  }
  stack.push(fv.x * 16384);
  stack.push(fv.y * 16384);
}
function SFVTPV(state) {
  state.fv = state.pv;
  if (exports.DEBUG) {
    console.log(state.step, "SFVTPV[]");
  }
}
function ISECT(state) {
  var stack = state.stack;
  var pa0i = stack.pop();
  var pa1i = stack.pop();
  var pb0i = stack.pop();
  var pb1i = stack.pop();
  var pi2 = stack.pop();
  var z0 = state.z0;
  var z1 = state.z1;
  var pa0 = z0[pa0i];
  var pa1 = z0[pa1i];
  var pb0 = z1[pb0i];
  var pb1 = z1[pb1i];
  var p = state.z2[pi2];
  if (exports.DEBUG) {
    console.log("ISECT[], ", pa0i, pa1i, pb0i, pb1i, pi2);
  }
  var x1 = pa0.x;
  var y1 = pa0.y;
  var x2 = pa1.x;
  var y2 = pa1.y;
  var x3 = pb0.x;
  var y3 = pb0.y;
  var x4 = pb1.x;
  var y4 = pb1.y;
  var div = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  var f1 = x1 * y2 - y1 * x2;
  var f2 = x3 * y4 - y3 * x4;
  p.x = (f1 * (x3 - x4) - f2 * (x1 - x2)) / div;
  p.y = (f1 * (y3 - y4) - f2 * (y1 - y2)) / div;
}
function SRP0(state) {
  state.rp0 = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SRP0[]", state.rp0);
  }
}
function SRP1(state) {
  state.rp1 = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SRP1[]", state.rp1);
  }
}
function SRP2(state) {
  state.rp2 = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SRP2[]", state.rp2);
  }
}
function SZP0(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SZP0[]", n);
  }
  state.zp0 = n;
  switch (n) {
    case 0:
      if (!state.tZone) {
        initTZone(state);
      }
      state.z0 = state.tZone;
      break;
    case 1:
      state.z0 = state.gZone;
      break;
    default:
      throw new Error("Invalid zone pointer");
  }
}
function SZP1(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SZP1[]", n);
  }
  state.zp1 = n;
  switch (n) {
    case 0:
      if (!state.tZone) {
        initTZone(state);
      }
      state.z1 = state.tZone;
      break;
    case 1:
      state.z1 = state.gZone;
      break;
    default:
      throw new Error("Invalid zone pointer");
  }
}
function SZP2(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SZP2[]", n);
  }
  state.zp2 = n;
  switch (n) {
    case 0:
      if (!state.tZone) {
        initTZone(state);
      }
      state.z2 = state.tZone;
      break;
    case 1:
      state.z2 = state.gZone;
      break;
    default:
      throw new Error("Invalid zone pointer");
  }
}
function SZPS(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SZPS[]", n);
  }
  state.zp0 = state.zp1 = state.zp2 = n;
  switch (n) {
    case 0:
      if (!state.tZone) {
        initTZone(state);
      }
      state.z0 = state.z1 = state.z2 = state.tZone;
      break;
    case 1:
      state.z0 = state.z1 = state.z2 = state.gZone;
      break;
    default:
      throw new Error("Invalid zone pointer");
  }
}
function SLOOP(state) {
  state.loop = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SLOOP[]", state.loop);
  }
}
function RTG(state) {
  if (exports.DEBUG) {
    console.log(state.step, "RTG[]");
  }
  state.round = roundToGrid;
}
function RTHG(state) {
  if (exports.DEBUG) {
    console.log(state.step, "RTHG[]");
  }
  state.round = roundToHalfGrid;
}
function SMD(state) {
  var d2 = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SMD[]", d2);
  }
  state.minDis = d2 / 64;
}
function ELSE(state) {
  if (exports.DEBUG) {
    console.log(state.step, "ELSE[]");
  }
  skip(state, false);
}
function JMPR(state) {
  var o = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "JMPR[]", o);
  }
  state.ip += o - 1;
}
function SCVTCI(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SCVTCI[]", n);
  }
  state.cvCutIn = n / 64;
}
function DUP(state) {
  var stack = state.stack;
  if (exports.DEBUG) {
    console.log(state.step, "DUP[]");
  }
  stack.push(stack[stack.length - 1]);
}
function POP(state) {
  if (exports.DEBUG) {
    console.log(state.step, "POP[]");
  }
  state.stack.pop();
}
function CLEAR(state) {
  if (exports.DEBUG) {
    console.log(state.step, "CLEAR[]");
  }
  state.stack.length = 0;
}
function SWAP(state) {
  var stack = state.stack;
  var a = stack.pop();
  var b = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SWAP[]");
  }
  stack.push(a);
  stack.push(b);
}
function DEPTH(state) {
  var stack = state.stack;
  if (exports.DEBUG) {
    console.log(state.step, "DEPTH[]");
  }
  stack.push(stack.length);
}
function LOOPCALL(state) {
  var stack = state.stack;
  var fn = stack.pop();
  var c2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "LOOPCALL[]", fn, c2);
  }
  var cip = state.ip;
  var cprog = state.prog;
  state.prog = state.funcs[fn];
  for (var i = 0; i < c2; i++) {
    exec(state);
    if (exports.DEBUG) {
      console.log(
        ++state.step,
        i + 1 < c2 ? "next loopcall" : "done loopcall",
        i
      );
    }
  }
  state.ip = cip;
  state.prog = cprog;
}
function CALL(state) {
  var fn = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "CALL[]", fn);
  }
  var cip = state.ip;
  var cprog = state.prog;
  state.prog = state.funcs[fn];
  exec(state);
  state.ip = cip;
  state.prog = cprog;
  if (exports.DEBUG) {
    console.log(++state.step, "returning from", fn);
  }
}
function CINDEX(state) {
  var stack = state.stack;
  var k2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "CINDEX[]", k2);
  }
  stack.push(stack[stack.length - k2]);
}
function MINDEX(state) {
  var stack = state.stack;
  var k2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "MINDEX[]", k2);
  }
  stack.push(stack.splice(stack.length - k2, 1)[0]);
}
function FDEF(state) {
  if (state.env !== "fpgm") {
    throw new Error("FDEF not allowed here");
  }
  var stack = state.stack;
  var prog = state.prog;
  var ip2 = state.ip;
  var fn = stack.pop();
  var ipBegin = ip2;
  if (exports.DEBUG) {
    console.log(state.step, "FDEF[]", fn);
  }
  while (prog[++ip2] !== 45) {
  }
  state.ip = ip2;
  state.funcs[fn] = prog.slice(ipBegin + 1, ip2);
}
function MDAP(round, state) {
  var pi2 = state.stack.pop();
  var p = state.z0[pi2];
  var fv = state.fv;
  var pv2 = state.pv;
  if (exports.DEBUG) {
    console.log(state.step, "MDAP[" + round + "]", pi2);
  }
  var d2 = pv2.distance(p, HPZero);
  if (round) {
    d2 = state.round(d2);
  }
  fv.setRelative(p, HPZero, d2, pv2);
  fv.touch(p);
  state.rp0 = state.rp1 = pi2;
}
function IUP(v2, state) {
  var z2 = state.z2;
  var pLen = z2.length - 2;
  var cp2;
  var pp2;
  var np2;
  if (exports.DEBUG) {
    console.log(state.step, "IUP[" + v2.axis + "]");
  }
  for (var i = 0; i < pLen; i++) {
    cp2 = z2[i];
    if (v2.touched(cp2)) {
      continue;
    }
    pp2 = cp2.prevTouched(v2);
    if (pp2 === cp2) {
      continue;
    }
    np2 = cp2.nextTouched(v2);
    if (pp2 === np2) {
      v2.setRelative(cp2, cp2, v2.distance(pp2, pp2, false, true), v2, true);
    }
    v2.interpolate(cp2, pp2, np2, v2);
  }
}
function SHP(a, state) {
  var stack = state.stack;
  var rpi = a ? state.rp1 : state.rp2;
  var rp2 = (a ? state.z0 : state.z1)[rpi];
  var fv = state.fv;
  var pv2 = state.pv;
  var loop = state.loop;
  var z2 = state.z2;
  while (loop--) {
    var pi2 = stack.pop();
    var p = z2[pi2];
    var d2 = pv2.distance(rp2, rp2, false, true);
    fv.setRelative(p, p, d2, pv2);
    fv.touch(p);
    if (exports.DEBUG) {
      console.log(
        state.step,
        (state.loop > 1 ? "loop " + (state.loop - loop) + ": " : "") + "SHP[" + (a ? "rp1" : "rp2") + "]",
        pi2
      );
    }
  }
  state.loop = 1;
}
function SHC(a, state) {
  var stack = state.stack;
  var rpi = a ? state.rp1 : state.rp2;
  var rp2 = (a ? state.z0 : state.z1)[rpi];
  var fv = state.fv;
  var pv2 = state.pv;
  var ci2 = stack.pop();
  var sp2 = state.z2[state.contours[ci2]];
  var p = sp2;
  if (exports.DEBUG) {
    console.log(state.step, "SHC[" + a + "]", ci2);
  }
  var d2 = pv2.distance(rp2, rp2, false, true);
  do {
    if (p !== rp2) {
      fv.setRelative(p, p, d2, pv2);
    }
    p = p.nextPointOnContour;
  } while (p !== sp2);
}
function SHZ(a, state) {
  var stack = state.stack;
  var rpi = a ? state.rp1 : state.rp2;
  var rp2 = (a ? state.z0 : state.z1)[rpi];
  var fv = state.fv;
  var pv2 = state.pv;
  var e = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SHZ[" + a + "]", e);
  }
  var z;
  switch (e) {
    case 0:
      z = state.tZone;
      break;
    case 1:
      z = state.gZone;
      break;
    default:
      throw new Error("Invalid zone");
  }
  var p;
  var d2 = pv2.distance(rp2, rp2, false, true);
  var pLen = z.length - 2;
  for (var i = 0; i < pLen; i++) {
    p = z[i];
    fv.setRelative(p, p, d2, pv2);
  }
}
function SHPIX(state) {
  var stack = state.stack;
  var loop = state.loop;
  var fv = state.fv;
  var d2 = stack.pop() / 64;
  var z2 = state.z2;
  while (loop--) {
    var pi2 = stack.pop();
    var p = z2[pi2];
    if (exports.DEBUG) {
      console.log(
        state.step,
        (state.loop > 1 ? "loop " + (state.loop - loop) + ": " : "") + "SHPIX[]",
        pi2,
        d2
      );
    }
    fv.setRelative(p, p, d2);
    fv.touch(p);
  }
  state.loop = 1;
}
function IP(state) {
  var stack = state.stack;
  var rp1i = state.rp1;
  var rp2i = state.rp2;
  var loop = state.loop;
  var rp1 = state.z0[rp1i];
  var rp2 = state.z1[rp2i];
  var fv = state.fv;
  var pv2 = state.dpv;
  var z2 = state.z2;
  while (loop--) {
    var pi2 = stack.pop();
    var p = z2[pi2];
    if (exports.DEBUG) {
      console.log(
        state.step,
        (state.loop > 1 ? "loop " + (state.loop - loop) + ": " : "") + "IP[]",
        pi2,
        rp1i,
        "<->",
        rp2i
      );
    }
    fv.interpolate(p, rp1, rp2, pv2);
    fv.touch(p);
  }
  state.loop = 1;
}
function MSIRP(a, state) {
  var stack = state.stack;
  var d2 = stack.pop() / 64;
  var pi2 = stack.pop();
  var p = state.z1[pi2];
  var rp0 = state.z0[state.rp0];
  var fv = state.fv;
  var pv2 = state.pv;
  fv.setRelative(p, rp0, d2, pv2);
  fv.touch(p);
  if (exports.DEBUG) {
    console.log(state.step, "MSIRP[" + a + "]", d2, pi2);
  }
  state.rp1 = state.rp0;
  state.rp2 = pi2;
  if (a) {
    state.rp0 = pi2;
  }
}
function ALIGNRP(state) {
  var stack = state.stack;
  var rp0i = state.rp0;
  var rp0 = state.z0[rp0i];
  var loop = state.loop;
  var fv = state.fv;
  var pv2 = state.pv;
  var z1 = state.z1;
  while (loop--) {
    var pi2 = stack.pop();
    var p = z1[pi2];
    if (exports.DEBUG) {
      console.log(
        state.step,
        (state.loop > 1 ? "loop " + (state.loop - loop) + ": " : "") + "ALIGNRP[]",
        pi2
      );
    }
    fv.setRelative(p, rp0, 0, pv2);
    fv.touch(p);
  }
  state.loop = 1;
}
function RTDG(state) {
  if (exports.DEBUG) {
    console.log(state.step, "RTDG[]");
  }
  state.round = roundToDoubleGrid;
}
function MIAP(round, state) {
  var stack = state.stack;
  var n = stack.pop();
  var pi2 = stack.pop();
  var p = state.z0[pi2];
  var fv = state.fv;
  var pv2 = state.pv;
  var cv2 = state.cvt[n];
  if (exports.DEBUG) {
    console.log(
      state.step,
      "MIAP[" + round + "]",
      n,
      "(",
      cv2,
      ")",
      pi2
    );
  }
  var d2 = pv2.distance(p, HPZero);
  if (round) {
    if (Math.abs(d2 - cv2) < state.cvCutIn) {
      d2 = cv2;
    }
    d2 = state.round(d2);
  }
  fv.setRelative(p, HPZero, d2, pv2);
  if (state.zp0 === 0) {
    p.xo = p.x;
    p.yo = p.y;
  }
  fv.touch(p);
  state.rp0 = state.rp1 = pi2;
}
function NPUSHB(state) {
  var prog = state.prog;
  var ip2 = state.ip;
  var stack = state.stack;
  var n = prog[++ip2];
  if (exports.DEBUG) {
    console.log(state.step, "NPUSHB[]", n);
  }
  for (var i = 0; i < n; i++) {
    stack.push(prog[++ip2]);
  }
  state.ip = ip2;
}
function NPUSHW(state) {
  var ip2 = state.ip;
  var prog = state.prog;
  var stack = state.stack;
  var n = prog[++ip2];
  if (exports.DEBUG) {
    console.log(state.step, "NPUSHW[]", n);
  }
  for (var i = 0; i < n; i++) {
    var w2 = prog[++ip2] << 8 | prog[++ip2];
    if (w2 & 32768) {
      w2 = -((w2 ^ 65535) + 1);
    }
    stack.push(w2);
  }
  state.ip = ip2;
}
function WS(state) {
  var stack = state.stack;
  var store = state.store;
  if (!store) {
    store = state.store = [];
  }
  var v2 = stack.pop();
  var l2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "WS", v2, l2);
  }
  store[l2] = v2;
}
function RS(state) {
  var stack = state.stack;
  var store = state.store;
  var l2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "RS", l2);
  }
  var v2 = store && store[l2] || 0;
  stack.push(v2);
}
function WCVTP(state) {
  var stack = state.stack;
  var v2 = stack.pop();
  var l2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "WCVTP", v2, l2);
  }
  state.cvt[l2] = v2 / 64;
}
function RCVT(state) {
  var stack = state.stack;
  var cvte = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "RCVT", cvte);
  }
  stack.push(state.cvt[cvte] * 64);
}
function GC(a, state) {
  var stack = state.stack;
  var pi2 = stack.pop();
  var p = state.z2[pi2];
  if (exports.DEBUG) {
    console.log(state.step, "GC[" + a + "]", pi2);
  }
  stack.push(state.dpv.distance(p, HPZero, a, false) * 64);
}
function MD(a, state) {
  var stack = state.stack;
  var pi2 = stack.pop();
  var pi1 = stack.pop();
  var p2 = state.z1[pi2];
  var p1 = state.z0[pi1];
  var d2 = state.dpv.distance(p1, p2, a, a);
  if (exports.DEBUG) {
    console.log(state.step, "MD[" + a + "]", pi2, pi1, "->", d2);
  }
  state.stack.push(Math.round(d2 * 64));
}
function MPPEM(state) {
  if (exports.DEBUG) {
    console.log(state.step, "MPPEM[]");
  }
  state.stack.push(state.ppem);
}
function FLIPON(state) {
  if (exports.DEBUG) {
    console.log(state.step, "FLIPON[]");
  }
  state.autoFlip = true;
}
function LT(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "LT[]", e2, e1);
  }
  stack.push(e1 < e2 ? 1 : 0);
}
function LTEQ(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "LTEQ[]", e2, e1);
  }
  stack.push(e1 <= e2 ? 1 : 0);
}
function GT(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "GT[]", e2, e1);
  }
  stack.push(e1 > e2 ? 1 : 0);
}
function GTEQ(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "GTEQ[]", e2, e1);
  }
  stack.push(e1 >= e2 ? 1 : 0);
}
function EQ(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "EQ[]", e2, e1);
  }
  stack.push(e2 === e1 ? 1 : 0);
}
function NEQ(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "NEQ[]", e2, e1);
  }
  stack.push(e2 !== e1 ? 1 : 0);
}
function ODD(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "ODD[]", n);
  }
  stack.push(Math.trunc(n) % 2 ? 1 : 0);
}
function EVEN(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "EVEN[]", n);
  }
  stack.push(Math.trunc(n) % 2 ? 0 : 1);
}
function IF(state) {
  var test = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "IF[]", test);
  }
  if (!test) {
    skip(state, true);
    if (exports.DEBUG) {
      console.log(state.step, "EIF[]");
    }
  }
}
function EIF(state) {
  if (exports.DEBUG) {
    console.log(state.step, "EIF[]");
  }
}
function AND(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "AND[]", e2, e1);
  }
  stack.push(e2 && e1 ? 1 : 0);
}
function OR(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "OR[]", e2, e1);
  }
  stack.push(e2 || e1 ? 1 : 0);
}
function NOT(state) {
  var stack = state.stack;
  var e = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "NOT[]", e);
  }
  stack.push(e ? 0 : 1);
}
function DELTAP123(b, state) {
  var stack = state.stack;
  var n = stack.pop();
  var fv = state.fv;
  var pv2 = state.pv;
  var ppem = state.ppem;
  var base = state.deltaBase + (b - 1) * 16;
  var ds = state.deltaShift;
  var z0 = state.z0;
  if (exports.DEBUG) {
    console.log(state.step, "DELTAP[" + b + "]", n, stack);
  }
  for (var i = 0; i < n; i++) {
    var pi2 = stack.pop();
    var arg = stack.pop();
    var appem = base + ((arg & 240) >> 4);
    if (appem !== ppem) {
      continue;
    }
    var mag = (arg & 15) - 8;
    if (mag >= 0) {
      mag++;
    }
    if (exports.DEBUG) {
      console.log(state.step, "DELTAPFIX", pi2, "by", mag * ds);
    }
    var p = z0[pi2];
    fv.setRelative(p, p, mag * ds, pv2);
  }
}
function SDB(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SDB[]", n);
  }
  state.deltaBase = n;
}
function SDS(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SDS[]", n);
  }
  state.deltaShift = Math.pow(0.5, n);
}
function ADD(state) {
  var stack = state.stack;
  var n2 = stack.pop();
  var n1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "ADD[]", n2, n1);
  }
  stack.push(n1 + n2);
}
function SUB(state) {
  var stack = state.stack;
  var n2 = stack.pop();
  var n1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SUB[]", n2, n1);
  }
  stack.push(n1 - n2);
}
function DIV(state) {
  var stack = state.stack;
  var n2 = stack.pop();
  var n1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "DIV[]", n2, n1);
  }
  stack.push(n1 * 64 / n2);
}
function MUL(state) {
  var stack = state.stack;
  var n2 = stack.pop();
  var n1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "MUL[]", n2, n1);
  }
  stack.push(n1 * n2 / 64);
}
function ABS(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "ABS[]", n);
  }
  stack.push(Math.abs(n));
}
function NEG(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "NEG[]", n);
  }
  stack.push(-n);
}
function FLOOR(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "FLOOR[]", n);
  }
  stack.push(Math.floor(n / 64) * 64);
}
function CEILING(state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "CEILING[]", n);
  }
  stack.push(Math.ceil(n / 64) * 64);
}
function ROUND(dt2, state) {
  var stack = state.stack;
  var n = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "ROUND[]");
  }
  stack.push(state.round(n / 64) * 64);
}
function WCVTF(state) {
  var stack = state.stack;
  var v2 = stack.pop();
  var l2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "WCVTF[]", v2, l2);
  }
  state.cvt[l2] = v2 * state.ppem / state.font.unitsPerEm;
}
function DELTAC123(b, state) {
  var stack = state.stack;
  var n = stack.pop();
  var ppem = state.ppem;
  var base = state.deltaBase + (b - 1) * 16;
  var ds = state.deltaShift;
  if (exports.DEBUG) {
    console.log(state.step, "DELTAC[" + b + "]", n, stack);
  }
  for (var i = 0; i < n; i++) {
    var c2 = stack.pop();
    var arg = stack.pop();
    var appem = base + ((arg & 240) >> 4);
    if (appem !== ppem) {
      continue;
    }
    var mag = (arg & 15) - 8;
    if (mag >= 0) {
      mag++;
    }
    var delta = mag * ds;
    if (exports.DEBUG) {
      console.log(state.step, "DELTACFIX", c2, "by", delta);
    }
    state.cvt[c2] += delta;
  }
}
function SROUND(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SROUND[]", n);
  }
  state.round = roundSuper;
  var period;
  switch (n & 192) {
    case 0:
      period = 0.5;
      break;
    case 64:
      period = 1;
      break;
    case 128:
      period = 2;
      break;
    default:
      throw new Error("invalid SROUND value");
  }
  state.srPeriod = period;
  switch (n & 48) {
    case 0:
      state.srPhase = 0;
      break;
    case 16:
      state.srPhase = 0.25 * period;
      break;
    case 32:
      state.srPhase = 0.5 * period;
      break;
    case 48:
      state.srPhase = 0.75 * period;
      break;
    default:
      throw new Error("invalid SROUND value");
  }
  n &= 15;
  if (n === 0) {
    state.srThreshold = 0;
  } else {
    state.srThreshold = (n / 8 - 0.5) * period;
  }
}
function S45ROUND(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "S45ROUND[]", n);
  }
  state.round = roundSuper;
  var period;
  switch (n & 192) {
    case 0:
      period = Math.sqrt(2) / 2;
      break;
    case 64:
      period = Math.sqrt(2);
      break;
    case 128:
      period = 2 * Math.sqrt(2);
      break;
    default:
      throw new Error("invalid S45ROUND value");
  }
  state.srPeriod = period;
  switch (n & 48) {
    case 0:
      state.srPhase = 0;
      break;
    case 16:
      state.srPhase = 0.25 * period;
      break;
    case 32:
      state.srPhase = 0.5 * period;
      break;
    case 48:
      state.srPhase = 0.75 * period;
      break;
    default:
      throw new Error("invalid S45ROUND value");
  }
  n &= 15;
  if (n === 0) {
    state.srThreshold = 0;
  } else {
    state.srThreshold = (n / 8 - 0.5) * period;
  }
}
function ROFF(state) {
  if (exports.DEBUG) {
    console.log(state.step, "ROFF[]");
  }
  state.round = roundOff;
}
function RUTG(state) {
  if (exports.DEBUG) {
    console.log(state.step, "RUTG[]");
  }
  state.round = roundUpToGrid;
}
function RDTG(state) {
  if (exports.DEBUG) {
    console.log(state.step, "RDTG[]");
  }
  state.round = roundDownToGrid;
}
function SCANCTRL(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SCANCTRL[]", n);
  }
}
function SDPVTL(a, state) {
  var stack = state.stack;
  var p2i = stack.pop();
  var p1i = stack.pop();
  var p2 = state.z2[p2i];
  var p1 = state.z1[p1i];
  if (exports.DEBUG) {
    console.log(state.step, "SDPVTL[" + a + "]", p2i, p1i);
  }
  var dx;
  var dy;
  if (!a) {
    dx = p1.x - p2.x;
    dy = p1.y - p2.y;
  } else {
    dx = p2.y - p1.y;
    dy = p1.x - p2.x;
  }
  state.dpv = getUnitVector(dx, dy);
}
function GETINFO(state) {
  var stack = state.stack;
  var sel = stack.pop();
  var r = 0;
  if (exports.DEBUG) {
    console.log(state.step, "GETINFO[]", sel);
  }
  if (sel & 1) {
    r = 35;
  }
  if (sel & 32) {
    r |= 4096;
  }
  stack.push(r);
}
function ROLL(state) {
  var stack = state.stack;
  var a = stack.pop();
  var b = stack.pop();
  var c2 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "ROLL[]");
  }
  stack.push(b);
  stack.push(a);
  stack.push(c2);
}
function MAX(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "MAX[]", e2, e1);
  }
  stack.push(Math.max(e1, e2));
}
function MIN(state) {
  var stack = state.stack;
  var e2 = stack.pop();
  var e1 = stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "MIN[]", e2, e1);
  }
  stack.push(Math.min(e1, e2));
}
function SCANTYPE(state) {
  var n = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "SCANTYPE[]", n);
  }
}
function INSTCTRL(state) {
  var s = state.stack.pop();
  var v2 = state.stack.pop();
  if (exports.DEBUG) {
    console.log(state.step, "INSTCTRL[]", s, v2);
  }
  switch (s) {
    case 1:
      state.inhibitGridFit = !!v2;
      return;
    case 2:
      state.ignoreCvt = !!v2;
      return;
    default:
      throw new Error("invalid INSTCTRL[] selector");
  }
}
function PUSHB(n, state) {
  var stack = state.stack;
  var prog = state.prog;
  var ip2 = state.ip;
  if (exports.DEBUG) {
    console.log(state.step, "PUSHB[" + n + "]");
  }
  for (var i = 0; i < n; i++) {
    stack.push(prog[++ip2]);
  }
  state.ip = ip2;
}
function PUSHW(n, state) {
  var ip2 = state.ip;
  var prog = state.prog;
  var stack = state.stack;
  if (exports.DEBUG) {
    console.log(state.ip, "PUSHW[" + n + "]");
  }
  for (var i = 0; i < n; i++) {
    var w2 = prog[++ip2] << 8 | prog[++ip2];
    if (w2 & 32768) {
      w2 = -((w2 ^ 65535) + 1);
    }
    stack.push(w2);
  }
  state.ip = ip2;
}
function MDRP_MIRP(indirect, setRp0, keepD, ro2, dt2, state) {
  var stack = state.stack;
  var cvte = indirect && stack.pop();
  var pi2 = stack.pop();
  var rp0i = state.rp0;
  var rp2 = state.z0[rp0i];
  var p = state.z1[pi2];
  var md2 = state.minDis;
  var fv = state.fv;
  var pv2 = state.dpv;
  var od2;
  var d2;
  var sign;
  var cv2;
  d2 = od2 = pv2.distance(p, rp2, true, true);
  sign = d2 >= 0 ? 1 : -1;
  d2 = Math.abs(d2);
  if (indirect) {
    cv2 = state.cvt[cvte];
    if (ro2 && Math.abs(d2 - cv2) < state.cvCutIn) {
      d2 = cv2;
    }
  }
  if (keepD && d2 < md2) {
    d2 = md2;
  }
  if (ro2) {
    d2 = state.round(d2);
  }
  fv.setRelative(p, rp2, sign * d2, pv2);
  fv.touch(p);
  if (exports.DEBUG) {
    console.log(
      state.step,
      (indirect ? "MIRP[" : "MDRP[") + (setRp0 ? "M" : "m") + (keepD ? ">" : "_") + (ro2 ? "R" : "_") + (dt2 === 0 ? "Gr" : dt2 === 1 ? "Bl" : dt2 === 2 ? "Wh" : "") + "]",
      indirect ? cvte + "(" + state.cvt[cvte] + "," + cv2 + ")" : "",
      pi2,
      "(d =",
      od2,
      "->",
      sign * d2,
      ")"
    );
  }
  state.rp1 = state.rp0;
  state.rp2 = pi2;
  if (setRp0) {
    state.rp0 = pi2;
  }
}
instructionTable = [
  /* 0x00 */
  SVTCA.bind(void 0, yUnitVector),
  /* 0x01 */
  SVTCA.bind(void 0, xUnitVector),
  /* 0x02 */
  SPVTCA.bind(void 0, yUnitVector),
  /* 0x03 */
  SPVTCA.bind(void 0, xUnitVector),
  /* 0x04 */
  SFVTCA.bind(void 0, yUnitVector),
  /* 0x05 */
  SFVTCA.bind(void 0, xUnitVector),
  /* 0x06 */
  SPVTL.bind(void 0, 0),
  /* 0x07 */
  SPVTL.bind(void 0, 1),
  /* 0x08 */
  SFVTL.bind(void 0, 0),
  /* 0x09 */
  SFVTL.bind(void 0, 1),
  /* 0x0A */
  SPVFS,
  /* 0x0B */
  SFVFS,
  /* 0x0C */
  GPV,
  /* 0x0D */
  GFV,
  /* 0x0E */
  SFVTPV,
  /* 0x0F */
  ISECT,
  /* 0x10 */
  SRP0,
  /* 0x11 */
  SRP1,
  /* 0x12 */
  SRP2,
  /* 0x13 */
  SZP0,
  /* 0x14 */
  SZP1,
  /* 0x15 */
  SZP2,
  /* 0x16 */
  SZPS,
  /* 0x17 */
  SLOOP,
  /* 0x18 */
  RTG,
  /* 0x19 */
  RTHG,
  /* 0x1A */
  SMD,
  /* 0x1B */
  ELSE,
  /* 0x1C */
  JMPR,
  /* 0x1D */
  SCVTCI,
  /* 0x1E */
  void 0,
  // TODO SSWCI
  /* 0x1F */
  void 0,
  // TODO SSW
  /* 0x20 */
  DUP,
  /* 0x21 */
  POP,
  /* 0x22 */
  CLEAR,
  /* 0x23 */
  SWAP,
  /* 0x24 */
  DEPTH,
  /* 0x25 */
  CINDEX,
  /* 0x26 */
  MINDEX,
  /* 0x27 */
  void 0,
  // TODO ALIGNPTS
  /* 0x28 */
  void 0,
  /* 0x29 */
  void 0,
  // TODO UTP
  /* 0x2A */
  LOOPCALL,
  /* 0x2B */
  CALL,
  /* 0x2C */
  FDEF,
  /* 0x2D */
  void 0,
  // ENDF (eaten by FDEF)
  /* 0x2E */
  MDAP.bind(void 0, 0),
  /* 0x2F */
  MDAP.bind(void 0, 1),
  /* 0x30 */
  IUP.bind(void 0, yUnitVector),
  /* 0x31 */
  IUP.bind(void 0, xUnitVector),
  /* 0x32 */
  SHP.bind(void 0, 0),
  /* 0x33 */
  SHP.bind(void 0, 1),
  /* 0x34 */
  SHC.bind(void 0, 0),
  /* 0x35 */
  SHC.bind(void 0, 1),
  /* 0x36 */
  SHZ.bind(void 0, 0),
  /* 0x37 */
  SHZ.bind(void 0, 1),
  /* 0x38 */
  SHPIX,
  /* 0x39 */
  IP,
  /* 0x3A */
  MSIRP.bind(void 0, 0),
  /* 0x3B */
  MSIRP.bind(void 0, 1),
  /* 0x3C */
  ALIGNRP,
  /* 0x3D */
  RTDG,
  /* 0x3E */
  MIAP.bind(void 0, 0),
  /* 0x3F */
  MIAP.bind(void 0, 1),
  /* 0x40 */
  NPUSHB,
  /* 0x41 */
  NPUSHW,
  /* 0x42 */
  WS,
  /* 0x43 */
  RS,
  /* 0x44 */
  WCVTP,
  /* 0x45 */
  RCVT,
  /* 0x46 */
  GC.bind(void 0, 0),
  /* 0x47 */
  GC.bind(void 0, 1),
  /* 0x48 */
  void 0,
  // TODO SCFS
  /* 0x49 */
  MD.bind(void 0, 0),
  /* 0x4A */
  MD.bind(void 0, 1),
  /* 0x4B */
  MPPEM,
  /* 0x4C */
  void 0,
  // TODO MPS
  /* 0x4D */
  FLIPON,
  /* 0x4E */
  void 0,
  // TODO FLIPOFF
  /* 0x4F */
  void 0,
  // TODO DEBUG
  /* 0x50 */
  LT,
  /* 0x51 */
  LTEQ,
  /* 0x52 */
  GT,
  /* 0x53 */
  GTEQ,
  /* 0x54 */
  EQ,
  /* 0x55 */
  NEQ,
  /* 0x56 */
  ODD,
  /* 0x57 */
  EVEN,
  /* 0x58 */
  IF,
  /* 0x59 */
  EIF,
  /* 0x5A */
  AND,
  /* 0x5B */
  OR,
  /* 0x5C */
  NOT,
  /* 0x5D */
  DELTAP123.bind(void 0, 1),
  /* 0x5E */
  SDB,
  /* 0x5F */
  SDS,
  /* 0x60 */
  ADD,
  /* 0x61 */
  SUB,
  /* 0x62 */
  DIV,
  /* 0x63 */
  MUL,
  /* 0x64 */
  ABS,
  /* 0x65 */
  NEG,
  /* 0x66 */
  FLOOR,
  /* 0x67 */
  CEILING,
  /* 0x68 */
  ROUND.bind(void 0, 0),
  /* 0x69 */
  ROUND.bind(void 0, 1),
  /* 0x6A */
  ROUND.bind(void 0, 2),
  /* 0x6B */
  ROUND.bind(void 0, 3),
  /* 0x6C */
  void 0,
  // TODO NROUND[ab]
  /* 0x6D */
  void 0,
  // TODO NROUND[ab]
  /* 0x6E */
  void 0,
  // TODO NROUND[ab]
  /* 0x6F */
  void 0,
  // TODO NROUND[ab]
  /* 0x70 */
  WCVTF,
  /* 0x71 */
  DELTAP123.bind(void 0, 2),
  /* 0x72 */
  DELTAP123.bind(void 0, 3),
  /* 0x73 */
  DELTAC123.bind(void 0, 1),
  /* 0x74 */
  DELTAC123.bind(void 0, 2),
  /* 0x75 */
  DELTAC123.bind(void 0, 3),
  /* 0x76 */
  SROUND,
  /* 0x77 */
  S45ROUND,
  /* 0x78 */
  void 0,
  // TODO JROT[]
  /* 0x79 */
  void 0,
  // TODO JROF[]
  /* 0x7A */
  ROFF,
  /* 0x7B */
  void 0,
  /* 0x7C */
  RUTG,
  /* 0x7D */
  RDTG,
  /* 0x7E */
  POP,
  // actually SANGW, supposed to do only a pop though
  /* 0x7F */
  POP,
  // actually AA, supposed to do only a pop though
  /* 0x80 */
  void 0,
  // TODO FLIPPT
  /* 0x81 */
  void 0,
  // TODO FLIPRGON
  /* 0x82 */
  void 0,
  // TODO FLIPRGOFF
  /* 0x83 */
  void 0,
  /* 0x84 */
  void 0,
  /* 0x85 */
  SCANCTRL,
  /* 0x86 */
  SDPVTL.bind(void 0, 0),
  /* 0x87 */
  SDPVTL.bind(void 0, 1),
  /* 0x88 */
  GETINFO,
  /* 0x89 */
  void 0,
  // TODO IDEF
  /* 0x8A */
  ROLL,
  /* 0x8B */
  MAX,
  /* 0x8C */
  MIN,
  /* 0x8D */
  SCANTYPE,
  /* 0x8E */
  INSTCTRL,
  /* 0x8F */
  void 0,
  /* 0x90 */
  void 0,
  /* 0x91 */
  void 0,
  /* 0x92 */
  void 0,
  /* 0x93 */
  void 0,
  /* 0x94 */
  void 0,
  /* 0x95 */
  void 0,
  /* 0x96 */
  void 0,
  /* 0x97 */
  void 0,
  /* 0x98 */
  void 0,
  /* 0x99 */
  void 0,
  /* 0x9A */
  void 0,
  /* 0x9B */
  void 0,
  /* 0x9C */
  void 0,
  /* 0x9D */
  void 0,
  /* 0x9E */
  void 0,
  /* 0x9F */
  void 0,
  /* 0xA0 */
  void 0,
  /* 0xA1 */
  void 0,
  /* 0xA2 */
  void 0,
  /* 0xA3 */
  void 0,
  /* 0xA4 */
  void 0,
  /* 0xA5 */
  void 0,
  /* 0xA6 */
  void 0,
  /* 0xA7 */
  void 0,
  /* 0xA8 */
  void 0,
  /* 0xA9 */
  void 0,
  /* 0xAA */
  void 0,
  /* 0xAB */
  void 0,
  /* 0xAC */
  void 0,
  /* 0xAD */
  void 0,
  /* 0xAE */
  void 0,
  /* 0xAF */
  void 0,
  /* 0xB0 */
  PUSHB.bind(void 0, 1),
  /* 0xB1 */
  PUSHB.bind(void 0, 2),
  /* 0xB2 */
  PUSHB.bind(void 0, 3),
  /* 0xB3 */
  PUSHB.bind(void 0, 4),
  /* 0xB4 */
  PUSHB.bind(void 0, 5),
  /* 0xB5 */
  PUSHB.bind(void 0, 6),
  /* 0xB6 */
  PUSHB.bind(void 0, 7),
  /* 0xB7 */
  PUSHB.bind(void 0, 8),
  /* 0xB8 */
  PUSHW.bind(void 0, 1),
  /* 0xB9 */
  PUSHW.bind(void 0, 2),
  /* 0xBA */
  PUSHW.bind(void 0, 3),
  /* 0xBB */
  PUSHW.bind(void 0, 4),
  /* 0xBC */
  PUSHW.bind(void 0, 5),
  /* 0xBD */
  PUSHW.bind(void 0, 6),
  /* 0xBE */
  PUSHW.bind(void 0, 7),
  /* 0xBF */
  PUSHW.bind(void 0, 8),
  /* 0xC0 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 0, 0),
  /* 0xC1 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 0, 1),
  /* 0xC2 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 0, 2),
  /* 0xC3 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 0, 3),
  /* 0xC4 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 1, 0),
  /* 0xC5 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 1, 1),
  /* 0xC6 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 1, 2),
  /* 0xC7 */
  MDRP_MIRP.bind(void 0, 0, 0, 0, 1, 3),
  /* 0xC8 */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 0, 0),
  /* 0xC9 */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 0, 1),
  /* 0xCA */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 0, 2),
  /* 0xCB */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 0, 3),
  /* 0xCC */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 1, 0),
  /* 0xCD */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 1, 1),
  /* 0xCE */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 1, 2),
  /* 0xCF */
  MDRP_MIRP.bind(void 0, 0, 0, 1, 1, 3),
  /* 0xD0 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 0, 0),
  /* 0xD1 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 0, 1),
  /* 0xD2 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 0, 2),
  /* 0xD3 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 0, 3),
  /* 0xD4 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 1, 0),
  /* 0xD5 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 1, 1),
  /* 0xD6 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 1, 2),
  /* 0xD7 */
  MDRP_MIRP.bind(void 0, 0, 1, 0, 1, 3),
  /* 0xD8 */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 0, 0),
  /* 0xD9 */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 0, 1),
  /* 0xDA */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 0, 2),
  /* 0xDB */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 0, 3),
  /* 0xDC */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 1, 0),
  /* 0xDD */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 1, 1),
  /* 0xDE */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 1, 2),
  /* 0xDF */
  MDRP_MIRP.bind(void 0, 0, 1, 1, 1, 3),
  /* 0xE0 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 0, 0),
  /* 0xE1 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 0, 1),
  /* 0xE2 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 0, 2),
  /* 0xE3 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 0, 3),
  /* 0xE4 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 1, 0),
  /* 0xE5 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 1, 1),
  /* 0xE6 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 1, 2),
  /* 0xE7 */
  MDRP_MIRP.bind(void 0, 1, 0, 0, 1, 3),
  /* 0xE8 */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 0, 0),
  /* 0xE9 */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 0, 1),
  /* 0xEA */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 0, 2),
  /* 0xEB */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 0, 3),
  /* 0xEC */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 1, 0),
  /* 0xED */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 1, 1),
  /* 0xEE */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 1, 2),
  /* 0xEF */
  MDRP_MIRP.bind(void 0, 1, 0, 1, 1, 3),
  /* 0xF0 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 0, 0),
  /* 0xF1 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 0, 1),
  /* 0xF2 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 0, 2),
  /* 0xF3 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 0, 3),
  /* 0xF4 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 1, 0),
  /* 0xF5 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 1, 1),
  /* 0xF6 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 1, 2),
  /* 0xF7 */
  MDRP_MIRP.bind(void 0, 1, 1, 0, 1, 3),
  /* 0xF8 */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 0, 0),
  /* 0xF9 */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 0, 1),
  /* 0xFA */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 0, 2),
  /* 0xFB */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 0, 3),
  /* 0xFC */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 1, 0),
  /* 0xFD */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 1, 1),
  /* 0xFE */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 1, 2),
  /* 0xFF */
  MDRP_MIRP.bind(void 0, 1, 1, 1, 1, 3)
];
function Token(char) {
  this.char = char;
  this.state = {};
  this.activeState = null;
}
function ContextRange(startIndex, endOffset, contextName) {
  this.contextName = contextName;
  this.startIndex = startIndex;
  this.endOffset = endOffset;
}
function ContextChecker(contextName, checkStart, checkEnd) {
  this.contextName = contextName;
  this.openRange = null;
  this.ranges = [];
  this.checkStart = checkStart;
  this.checkEnd = checkEnd;
}
function ContextParams(context, currentIndex) {
  this.context = context;
  this.index = currentIndex;
  this.length = context.length;
  this.current = context[currentIndex];
  this.backtrack = context.slice(0, currentIndex);
  this.lookahead = context.slice(currentIndex + 1);
}
function Event(eventId) {
  this.eventId = eventId;
  this.subscribers = [];
}
function initializeCoreEvents(events) {
  var this$1 = this;
  var coreEvents = [
    "start",
    "end",
    "next",
    "newToken",
    "contextStart",
    "contextEnd",
    "insertToken",
    "removeToken",
    "removeRange",
    "replaceToken",
    "replaceRange",
    "composeRUD",
    "updateContextsRanges"
  ];
  coreEvents.forEach(function(eventId) {
    Object.defineProperty(this$1.events, eventId, {
      value: new Event(eventId)
    });
  });
  if (!!events) {
    coreEvents.forEach(function(eventId) {
      var event = events[eventId];
      if (typeof event === "function") {
        this$1.events[eventId].subscribe(event);
      }
    });
  }
  var requiresContextUpdate = [
    "insertToken",
    "removeToken",
    "removeRange",
    "replaceToken",
    "replaceRange",
    "composeRUD"
  ];
  requiresContextUpdate.forEach(function(eventId) {
    this$1.events[eventId].subscribe(
      this$1.updateContextsRanges
    );
  });
}
function Tokenizer(events) {
  this.tokens = [];
  this.registeredContexts = {};
  this.contextCheckers = [];
  this.events = {};
  this.registeredModifiers = [];
  initializeCoreEvents.call(this, events);
}
Token.prototype.setState = function(key, value) {
  this.state[key] = value;
  this.activeState = { key, value: this.state[key] };
  return this.activeState;
};
Token.prototype.getState = function(stateId) {
  return this.state[stateId] || null;
};
Tokenizer.prototype.inboundIndex = function(index) {
  return index >= 0 && index < this.tokens.length;
};
Tokenizer.prototype.composeRUD = function(RUDs) {
  var this$1 = this;
  var silent = true;
  var state = RUDs.map(function(RUD) {
    return this$1[RUD[0]].apply(this$1, RUD.slice(1).concat(silent));
  });
  var hasFAILObject = function(obj) {
    return typeof obj === "object" && obj.hasOwnProperty("FAIL");
  };
  if (state.every(hasFAILObject)) {
    return {
      FAIL: "composeRUD: one or more operations hasn't completed successfully",
      report: state.filter(hasFAILObject)
    };
  }
  this.dispatch("composeRUD", [state.filter(function(op2) {
    return !hasFAILObject(op2);
  })]);
};
Tokenizer.prototype.replaceRange = function(startIndex, offset, tokens, silent) {
  offset = offset !== null ? offset : this.tokens.length;
  var isTokenType = tokens.every(function(token) {
    return token instanceof Token;
  });
  if (!isNaN(startIndex) && this.inboundIndex(startIndex) && isTokenType) {
    var replaced = this.tokens.splice.apply(
      this.tokens,
      [startIndex, offset].concat(tokens)
    );
    if (!silent) {
      this.dispatch("replaceToken", [startIndex, offset, tokens]);
    }
    return [replaced, tokens];
  } else {
    return { FAIL: "replaceRange: invalid tokens or startIndex." };
  }
};
Tokenizer.prototype.replaceToken = function(index, token, silent) {
  if (!isNaN(index) && this.inboundIndex(index) && token instanceof Token) {
    var replaced = this.tokens.splice(index, 1, token);
    if (!silent) {
      this.dispatch("replaceToken", [index, token]);
    }
    return [replaced[0], token];
  } else {
    return { FAIL: "replaceToken: invalid token or index." };
  }
};
Tokenizer.prototype.removeRange = function(startIndex, offset, silent) {
  offset = !isNaN(offset) ? offset : this.tokens.length;
  var tokens = this.tokens.splice(startIndex, offset);
  if (!silent) {
    this.dispatch("removeRange", [tokens, startIndex, offset]);
  }
  return tokens;
};
Tokenizer.prototype.removeToken = function(index, silent) {
  if (!isNaN(index) && this.inboundIndex(index)) {
    var token = this.tokens.splice(index, 1);
    if (!silent) {
      this.dispatch("removeToken", [token, index]);
    }
    return token;
  } else {
    return { FAIL: "removeToken: invalid token index." };
  }
};
Tokenizer.prototype.insertToken = function(tokens, index, silent) {
  var tokenType = tokens.every(
    function(token) {
      return token instanceof Token;
    }
  );
  if (tokenType) {
    this.tokens.splice.apply(
      this.tokens,
      [index, 0].concat(tokens)
    );
    if (!silent) {
      this.dispatch("insertToken", [tokens, index]);
    }
    return tokens;
  } else {
    return { FAIL: "insertToken: invalid token(s)." };
  }
};
Tokenizer.prototype.registerModifier = function(modifierId, condition, modifier) {
  this.events.newToken.subscribe(function(token, contextParams) {
    var conditionParams = [token, contextParams];
    var canApplyModifier = condition === null || condition.apply(this, conditionParams) === true;
    var modifierParams = [token, contextParams];
    if (canApplyModifier) {
      var newStateValue = modifier.apply(this, modifierParams);
      token.setState(modifierId, newStateValue);
    }
  });
  this.registeredModifiers.push(modifierId);
};
Event.prototype.subscribe = function(eventHandler) {
  if (typeof eventHandler === "function") {
    return this.subscribers.push(eventHandler) - 1;
  } else {
    return { FAIL: "invalid '" + this.eventId + "' event handler" };
  }
};
Event.prototype.unsubscribe = function(subsId) {
  this.subscribers.splice(subsId, 1);
};
ContextParams.prototype.setCurrentIndex = function(index) {
  this.index = index;
  this.current = this.context[index];
  this.backtrack = this.context.slice(0, index);
  this.lookahead = this.context.slice(index + 1);
};
ContextParams.prototype.get = function(offset) {
  switch (true) {
    case offset === 0:
      return this.current;
    case (offset < 0 && Math.abs(offset) <= this.backtrack.length):
      return this.backtrack.slice(offset)[0];
    case (offset > 0 && offset <= this.lookahead.length):
      return this.lookahead[offset - 1];
    default:
      return null;
  }
};
Tokenizer.prototype.rangeToText = function(range) {
  if (range instanceof ContextRange) {
    return this.getRangeTokens(range).map(function(token) {
      return token.char;
    }).join("");
  }
};
Tokenizer.prototype.getText = function() {
  return this.tokens.map(function(token) {
    return token.char;
  }).join("");
};
Tokenizer.prototype.getContext = function(contextName) {
  var context = this.registeredContexts[contextName];
  return !!context ? context : null;
};
Tokenizer.prototype.on = function(eventName, eventHandler) {
  var event = this.events[eventName];
  if (!!event) {
    return event.subscribe(eventHandler);
  } else {
    return null;
  }
};
Tokenizer.prototype.dispatch = function(eventName, args) {
  var this$1 = this;
  var event = this.events[eventName];
  if (event instanceof Event) {
    event.subscribers.forEach(function(subscriber) {
      subscriber.apply(this$1, args || []);
    });
  }
};
Tokenizer.prototype.registerContextChecker = function(contextName, contextStartCheck, contextEndCheck) {
  if (!!this.getContext(contextName)) {
    return {
      FAIL: "context name '" + contextName + "' is already registered."
    };
  }
  if (typeof contextStartCheck !== "function") {
    return {
      FAIL: "missing context start check."
    };
  }
  if (typeof contextEndCheck !== "function") {
    return {
      FAIL: "missing context end check."
    };
  }
  var contextCheckers = new ContextChecker(
    contextName,
    contextStartCheck,
    contextEndCheck
  );
  this.registeredContexts[contextName] = contextCheckers;
  this.contextCheckers.push(contextCheckers);
  return contextCheckers;
};
Tokenizer.prototype.getRangeTokens = function(range) {
  var endIndex = range.startIndex + range.endOffset;
  return [].concat(
    this.tokens.slice(range.startIndex, endIndex)
  );
};
Tokenizer.prototype.getContextRanges = function(contextName) {
  var context = this.getContext(contextName);
  if (!!context) {
    return context.ranges;
  } else {
    return { FAIL: "context checker '" + contextName + "' is not registered." };
  }
};
Tokenizer.prototype.resetContextsRanges = function() {
  var registeredContexts = this.registeredContexts;
  for (var contextName in registeredContexts) {
    if (registeredContexts.hasOwnProperty(contextName)) {
      var context = registeredContexts[contextName];
      context.ranges = [];
    }
  }
};
Tokenizer.prototype.updateContextsRanges = function() {
  this.resetContextsRanges();
  var chars = this.tokens.map(function(token) {
    return token.char;
  });
  for (var i = 0; i < chars.length; i++) {
    var contextParams = new ContextParams(chars, i);
    this.runContextCheck(contextParams);
  }
  this.dispatch("updateContextsRanges", [this.registeredContexts]);
};
Tokenizer.prototype.setEndOffset = function(offset, contextName) {
  var startIndex = this.getContext(contextName).openRange.startIndex;
  var range = new ContextRange(startIndex, offset, contextName);
  var ranges = this.getContext(contextName).ranges;
  range.rangeId = contextName + "." + ranges.length;
  ranges.push(range);
  this.getContext(contextName).openRange = null;
  return range;
};
Tokenizer.prototype.runContextCheck = function(contextParams) {
  var this$1 = this;
  var index = contextParams.index;
  this.contextCheckers.forEach(function(contextChecker) {
    var contextName = contextChecker.contextName;
    var openRange = this$1.getContext(contextName).openRange;
    if (!openRange && contextChecker.checkStart(contextParams)) {
      openRange = new ContextRange(index, null, contextName);
      this$1.getContext(contextName).openRange = openRange;
      this$1.dispatch("contextStart", [contextName, index]);
    }
    if (!!openRange && contextChecker.checkEnd(contextParams)) {
      var offset = index - openRange.startIndex + 1;
      var range = this$1.setEndOffset(offset, contextName);
      this$1.dispatch("contextEnd", [contextName, range]);
    }
  });
};
Tokenizer.prototype.tokenize = function(text) {
  this.tokens = [];
  this.resetContextsRanges();
  var chars = Array.from(text);
  this.dispatch("start");
  for (var i = 0; i < chars.length; i++) {
    var char = chars[i];
    var contextParams = new ContextParams(chars, i);
    this.dispatch("next", [contextParams]);
    this.runContextCheck(contextParams);
    var token = new Token(char);
    this.tokens.push(token);
    this.dispatch("newToken", [token, contextParams]);
  }
  this.dispatch("end", [this.tokens]);
  return this.tokens;
};
function isArabicChar(c2) {
  return /[\u0600-\u065F\u066A-\u06D2\u06FA-\u06FF]/.test(c2);
}
function isIsolatedArabicChar(char) {
  return /[\u0630\u0690\u0621\u0631\u0661\u0671\u0622\u0632\u0672\u0692\u06C2\u0623\u0673\u0693\u06C3\u0624\u0694\u06C4\u0625\u0675\u0695\u06C5\u06E5\u0676\u0696\u06C6\u0627\u0677\u0697\u06C7\u0648\u0688\u0698\u06C8\u0689\u0699\u06C9\u068A\u06CA\u066B\u068B\u06CB\u068C\u068D\u06CD\u06FD\u068E\u06EE\u06FE\u062F\u068F\u06CF\u06EF]/.test(char);
}
function isTashkeelArabicChar(char) {
  return /[\u0600-\u0605\u060C-\u060E\u0610-\u061B\u061E\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/.test(char);
}
function isLatinChar(c2) {
  return /[A-z]/.test(c2);
}
function isWhiteSpace(c2) {
  return /\s/.test(c2);
}
function FeatureQuery(font) {
  this.font = font;
  this.features = {};
}
function SubstitutionAction(action) {
  this.id = action.id;
  this.tag = action.tag;
  this.substitution = action.substitution;
}
function lookupCoverage(glyphIndex, coverage) {
  if (!glyphIndex) {
    return -1;
  }
  switch (coverage.format) {
    case 1:
      return coverage.glyphs.indexOf(glyphIndex);
    case 2:
      var ranges = coverage.ranges;
      for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        if (glyphIndex >= range.start && glyphIndex <= range.end) {
          var offset = glyphIndex - range.start;
          return range.index + offset;
        }
      }
      break;
    default:
      return -1;
  }
  return -1;
}
function singleSubstitutionFormat1(glyphIndex, subtable) {
  var substituteIndex = lookupCoverage(glyphIndex, subtable.coverage);
  if (substituteIndex === -1) {
    return null;
  }
  return glyphIndex + subtable.deltaGlyphId;
}
function singleSubstitutionFormat2(glyphIndex, subtable) {
  var substituteIndex = lookupCoverage(glyphIndex, subtable.coverage);
  if (substituteIndex === -1) {
    return null;
  }
  return subtable.substitute[substituteIndex];
}
function lookupCoverageList(coverageList, contextParams) {
  var lookupList = [];
  for (var i = 0; i < coverageList.length; i++) {
    var coverage = coverageList[i];
    var glyphIndex = contextParams.current;
    glyphIndex = Array.isArray(glyphIndex) ? glyphIndex[0] : glyphIndex;
    var lookupIndex = lookupCoverage(glyphIndex, coverage);
    if (lookupIndex !== -1) {
      lookupList.push(lookupIndex);
    }
  }
  if (lookupList.length !== coverageList.length) {
    return -1;
  }
  return lookupList;
}
function chainingSubstitutionFormat3(contextParams, subtable) {
  var lookupsCount = subtable.inputCoverage.length + subtable.lookaheadCoverage.length + subtable.backtrackCoverage.length;
  if (contextParams.context.length < lookupsCount) {
    return [];
  }
  var inputLookups = lookupCoverageList(
    subtable.inputCoverage,
    contextParams
  );
  if (inputLookups === -1) {
    return [];
  }
  var lookaheadOffset = subtable.inputCoverage.length - 1;
  if (contextParams.lookahead.length < subtable.lookaheadCoverage.length) {
    return [];
  }
  var lookaheadContext = contextParams.lookahead.slice(lookaheadOffset);
  while (lookaheadContext.length && isTashkeelArabicChar(lookaheadContext[0].char)) {
    lookaheadContext.shift();
  }
  var lookaheadParams = new ContextParams(lookaheadContext, 0);
  var lookaheadLookups = lookupCoverageList(
    subtable.lookaheadCoverage,
    lookaheadParams
  );
  var backtrackContext = [].concat(contextParams.backtrack);
  backtrackContext.reverse();
  while (backtrackContext.length && isTashkeelArabicChar(backtrackContext[0].char)) {
    backtrackContext.shift();
  }
  if (backtrackContext.length < subtable.backtrackCoverage.length) {
    return [];
  }
  var backtrackParams = new ContextParams(backtrackContext, 0);
  var backtrackLookups = lookupCoverageList(
    subtable.backtrackCoverage,
    backtrackParams
  );
  var contextRulesMatch = inputLookups.length === subtable.inputCoverage.length && lookaheadLookups.length === subtable.lookaheadCoverage.length && backtrackLookups.length === subtable.backtrackCoverage.length;
  var substitutions = [];
  if (contextRulesMatch) {
    for (var i = 0; i < subtable.lookupRecords.length; i++) {
      var lookupRecord = subtable.lookupRecords[i];
      var lookupListIndex = lookupRecord.lookupListIndex;
      var lookupTable = this.getLookupByIndex(lookupListIndex);
      for (var s = 0; s < lookupTable.subtables.length; s++) {
        var subtable$1 = lookupTable.subtables[s];
        var lookup = this.getLookupMethod(lookupTable, subtable$1);
        var substitutionType = this.getSubstitutionType(lookupTable, subtable$1);
        if (substitutionType === "12") {
          for (var n = 0; n < inputLookups.length; n++) {
            var glyphIndex = contextParams.get(n);
            var substitution = lookup(glyphIndex);
            if (substitution) {
              substitutions.push(substitution);
            }
          }
        }
      }
    }
  }
  return substitutions;
}
function ligatureSubstitutionFormat1(contextParams, subtable) {
  var glyphIndex = contextParams.current;
  var ligSetIndex = lookupCoverage(glyphIndex, subtable.coverage);
  if (ligSetIndex === -1) {
    return null;
  }
  var ligature;
  var ligatureSet = subtable.ligatureSets[ligSetIndex];
  for (var s = 0; s < ligatureSet.length; s++) {
    ligature = ligatureSet[s];
    for (var l2 = 0; l2 < ligature.components.length; l2++) {
      var lookaheadItem = contextParams.lookahead[l2];
      var component = ligature.components[l2];
      if (lookaheadItem !== component) {
        break;
      }
      if (l2 === ligature.components.length - 1) {
        return ligature;
      }
    }
  }
  return null;
}
function decompositionSubstitutionFormat1(glyphIndex, subtable) {
  var substituteIndex = lookupCoverage(glyphIndex, subtable.coverage);
  if (substituteIndex === -1) {
    return null;
  }
  return subtable.sequences[substituteIndex];
}
FeatureQuery.prototype.getDefaultScriptFeaturesIndexes = function() {
  var scripts = this.font.tables.gsub.scripts;
  for (var s = 0; s < scripts.length; s++) {
    var script = scripts[s];
    if (script.tag === "DFLT") {
      return script.script.defaultLangSys.featureIndexes;
    }
  }
  return [];
};
FeatureQuery.prototype.getScriptFeaturesIndexes = function(scriptTag) {
  var tables = this.font.tables;
  if (!tables.gsub) {
    return [];
  }
  if (!scriptTag) {
    return this.getDefaultScriptFeaturesIndexes();
  }
  var scripts = this.font.tables.gsub.scripts;
  for (var i = 0; i < scripts.length; i++) {
    var script = scripts[i];
    if (script.tag === scriptTag && script.script.defaultLangSys) {
      return script.script.defaultLangSys.featureIndexes;
    } else {
      var langSysRecords = script.langSysRecords;
      if (!!langSysRecords) {
        for (var j = 0; j < langSysRecords.length; j++) {
          var langSysRecord = langSysRecords[j];
          if (langSysRecord.tag === scriptTag) {
            var langSys = langSysRecord.langSys;
            return langSys.featureIndexes;
          }
        }
      }
    }
  }
  return this.getDefaultScriptFeaturesIndexes();
};
FeatureQuery.prototype.mapTagsToFeatures = function(features, scriptTag) {
  var tags = {};
  for (var i = 0; i < features.length; i++) {
    var tag = features[i].tag;
    var feature = features[i].feature;
    tags[tag] = feature;
  }
  this.features[scriptTag].tags = tags;
};
FeatureQuery.prototype.getScriptFeatures = function(scriptTag) {
  var features = this.features[scriptTag];
  if (this.features.hasOwnProperty(scriptTag)) {
    return features;
  }
  var featuresIndexes = this.getScriptFeaturesIndexes(scriptTag);
  if (!featuresIndexes) {
    return null;
  }
  var gsub2 = this.font.tables.gsub;
  features = featuresIndexes.map(function(index) {
    return gsub2.features[index];
  });
  this.features[scriptTag] = features;
  this.mapTagsToFeatures(features, scriptTag);
  return features;
};
FeatureQuery.prototype.getSubstitutionType = function(lookupTable, subtable) {
  var lookupType = lookupTable.lookupType.toString();
  var substFormat = subtable.substFormat.toString();
  return lookupType + substFormat;
};
FeatureQuery.prototype.getLookupMethod = function(lookupTable, subtable) {
  var this$1 = this;
  var substitutionType = this.getSubstitutionType(lookupTable, subtable);
  switch (substitutionType) {
    case "11":
      return function(glyphIndex) {
        return singleSubstitutionFormat1.apply(
          this$1,
          [glyphIndex, subtable]
        );
      };
    case "12":
      return function(glyphIndex) {
        return singleSubstitutionFormat2.apply(
          this$1,
          [glyphIndex, subtable]
        );
      };
    case "63":
      return function(contextParams) {
        return chainingSubstitutionFormat3.apply(
          this$1,
          [contextParams, subtable]
        );
      };
    case "41":
      return function(contextParams) {
        return ligatureSubstitutionFormat1.apply(
          this$1,
          [contextParams, subtable]
        );
      };
    case "21":
      return function(glyphIndex) {
        return decompositionSubstitutionFormat1.apply(
          this$1,
          [glyphIndex, subtable]
        );
      };
    default:
      throw new Error(
        "lookupType: " + lookupTable.lookupType + " - substFormat: " + subtable.substFormat + " is not yet supported"
      );
  }
};
FeatureQuery.prototype.lookupFeature = function(query) {
  var contextParams = query.contextParams;
  var currentIndex = contextParams.index;
  var feature = this.getFeature({
    tag: query.tag,
    script: query.script
  });
  if (!feature) {
    return new Error(
      "font '" + this.font.names.fullName.en + "' doesn't support feature '" + query.tag + "' for script '" + query.script + "'."
    );
  }
  var lookups = this.getFeatureLookups(feature);
  var substitutions = [].concat(contextParams.context);
  for (var l2 = 0; l2 < lookups.length; l2++) {
    var lookupTable = lookups[l2];
    var subtables = this.getLookupSubtables(lookupTable);
    for (var s = 0; s < subtables.length; s++) {
      var subtable = subtables[s];
      var substType = this.getSubstitutionType(lookupTable, subtable);
      var lookup = this.getLookupMethod(lookupTable, subtable);
      var substitution = void 0;
      switch (substType) {
        case "11":
          substitution = lookup(contextParams.current);
          if (substitution) {
            substitutions.splice(currentIndex, 1, new SubstitutionAction({
              id: 11,
              tag: query.tag,
              substitution
            }));
          }
          break;
        case "12":
          substitution = lookup(contextParams.current);
          if (substitution) {
            substitutions.splice(currentIndex, 1, new SubstitutionAction({
              id: 12,
              tag: query.tag,
              substitution
            }));
          }
          break;
        case "63":
          substitution = lookup(contextParams);
          if (Array.isArray(substitution) && substitution.length) {
            substitutions.splice(currentIndex, 1, new SubstitutionAction({
              id: 63,
              tag: query.tag,
              substitution
            }));
          }
          break;
        case "41":
          substitution = lookup(contextParams);
          if (substitution) {
            substitutions.splice(currentIndex, 1, new SubstitutionAction({
              id: 41,
              tag: query.tag,
              substitution
            }));
          }
          break;
        case "21":
          substitution = lookup(contextParams.current);
          if (substitution) {
            substitutions.splice(currentIndex, 1, new SubstitutionAction({
              id: 21,
              tag: query.tag,
              substitution
            }));
          }
          break;
      }
      contextParams = new ContextParams(substitutions, currentIndex);
      if (Array.isArray(substitution) && !substitution.length) {
        continue;
      }
      substitution = null;
    }
  }
  return substitutions.length ? substitutions : null;
};
FeatureQuery.prototype.supports = function(query) {
  if (!query.script) {
    return false;
  }
  this.getScriptFeatures(query.script);
  var supportedScript = this.features.hasOwnProperty(query.script);
  if (!query.tag) {
    return supportedScript;
  }
  var supportedFeature = this.features[query.script].some(function(feature) {
    return feature.tag === query.tag;
  });
  return supportedScript && supportedFeature;
};
FeatureQuery.prototype.getLookupSubtables = function(lookupTable) {
  return lookupTable.subtables || null;
};
FeatureQuery.prototype.getLookupByIndex = function(index) {
  var lookups = this.font.tables.gsub.lookups;
  return lookups[index] || null;
};
FeatureQuery.prototype.getFeatureLookups = function(feature) {
  return feature.lookupListIndexes.map(this.getLookupByIndex.bind(this));
};
FeatureQuery.prototype.getFeature = function getFeature(query) {
  if (!this.font) {
    return { FAIL: "No font was found" };
  }
  if (!this.features.hasOwnProperty(query.script)) {
    this.getScriptFeatures(query.script);
  }
  var scriptFeatures = this.features[query.script];
  if (!scriptFeatures) {
    return { FAIL: "No feature for script " + query.script };
  }
  if (!scriptFeatures.tags[query.tag]) {
    return null;
  }
  return this.features[query.script].tags[query.tag];
};
function arabicWordStartCheck(contextParams) {
  var char = contextParams.current;
  var prevChar = contextParams.get(-1);
  return (
    // ? arabic first char
    prevChar === null && isArabicChar(char) || // ? arabic char preceded with a non arabic char
    !isArabicChar(prevChar) && isArabicChar(char)
  );
}
function arabicWordEndCheck(contextParams) {
  var nextChar = contextParams.get(1);
  return (
    // ? last arabic char
    nextChar === null || // ? next char is not arabic
    !isArabicChar(nextChar)
  );
}
var arabicWordCheck = {
  startCheck: arabicWordStartCheck,
  endCheck: arabicWordEndCheck
};
function arabicSentenceStartCheck(contextParams) {
  var char = contextParams.current;
  var prevChar = contextParams.get(-1);
  return (
    // ? an arabic char preceded with a non arabic char
    (isArabicChar(char) || isTashkeelArabicChar(char)) && !isArabicChar(prevChar)
  );
}
function arabicSentenceEndCheck(contextParams) {
  var nextChar = contextParams.get(1);
  switch (true) {
    case nextChar === null:
      return true;
    case (!isArabicChar(nextChar) && !isTashkeelArabicChar(nextChar)):
      var nextIsWhitespace = isWhiteSpace(nextChar);
      if (!nextIsWhitespace) {
        return true;
      }
      if (nextIsWhitespace) {
        var arabicCharAhead = false;
        arabicCharAhead = contextParams.lookahead.some(
          function(c2) {
            return isArabicChar(c2) || isTashkeelArabicChar(c2);
          }
        );
        if (!arabicCharAhead) {
          return true;
        }
      }
      break;
    default:
      return false;
  }
}
var arabicSentenceCheck = {
  startCheck: arabicSentenceStartCheck,
  endCheck: arabicSentenceEndCheck
};
function singleSubstitutionFormat1$1(action, tokens, index) {
  tokens[index].setState(action.tag, action.substitution);
}
function singleSubstitutionFormat2$1(action, tokens, index) {
  tokens[index].setState(action.tag, action.substitution);
}
function chainingSubstitutionFormat3$1(action, tokens, index) {
  action.substitution.forEach(function(subst, offset) {
    var token = tokens[index + offset];
    token.setState(action.tag, subst);
  });
}
function ligatureSubstitutionFormat1$1(action, tokens, index) {
  var token = tokens[index];
  token.setState(action.tag, action.substitution.ligGlyph);
  var compsCount = action.substitution.components.length;
  for (var i = 0; i < compsCount; i++) {
    token = tokens[index + i + 1];
    token.setState("deleted", true);
  }
}
var SUBSTITUTIONS = {
  11: singleSubstitutionFormat1$1,
  12: singleSubstitutionFormat2$1,
  63: chainingSubstitutionFormat3$1,
  41: ligatureSubstitutionFormat1$1
};
function applySubstitution(action, tokens, index) {
  if (action instanceof SubstitutionAction && SUBSTITUTIONS[action.id]) {
    SUBSTITUTIONS[action.id](action, tokens, index);
  }
}
function willConnectPrev(charContextParams) {
  var backtrack = [].concat(charContextParams.backtrack);
  for (var i = backtrack.length - 1; i >= 0; i--) {
    var prevChar = backtrack[i];
    var isolated = isIsolatedArabicChar(prevChar);
    var tashkeel = isTashkeelArabicChar(prevChar);
    if (!isolated && !tashkeel) {
      return true;
    }
    if (isolated) {
      return false;
    }
  }
  return false;
}
function willConnectNext(charContextParams) {
  if (isIsolatedArabicChar(charContextParams.current)) {
    return false;
  }
  for (var i = 0; i < charContextParams.lookahead.length; i++) {
    var nextChar = charContextParams.lookahead[i];
    var tashkeel = isTashkeelArabicChar(nextChar);
    if (!tashkeel) {
      return true;
    }
  }
  return false;
}
function arabicPresentationForms(range) {
  var this$1 = this;
  var script = "arab";
  var tags = this.featuresTags[script];
  var tokens = this.tokenizer.getRangeTokens(range);
  if (tokens.length === 1) {
    return;
  }
  var contextParams = new ContextParams(
    tokens.map(
      function(token) {
        return token.getState("glyphIndex");
      }
    ),
    0
  );
  var charContextParams = new ContextParams(
    tokens.map(
      function(token) {
        return token.char;
      }
    ),
    0
  );
  tokens.forEach(function(token, index) {
    if (isTashkeelArabicChar(token.char)) {
      return;
    }
    contextParams.setCurrentIndex(index);
    charContextParams.setCurrentIndex(index);
    var CONNECT = 0;
    if (willConnectPrev(charContextParams)) {
      CONNECT |= 1;
    }
    if (willConnectNext(charContextParams)) {
      CONNECT |= 2;
    }
    var tag;
    switch (CONNECT) {
      case 1:
        tag = "fina";
        break;
      case 2:
        tag = "init";
        break;
      case 3:
        tag = "medi";
        break;
    }
    if (tags.indexOf(tag) === -1) {
      return;
    }
    var substitutions = this$1.query.lookupFeature({
      tag,
      script,
      contextParams
    });
    if (substitutions instanceof Error) {
      return console.info(substitutions.message);
    }
    substitutions.forEach(function(action, index2) {
      if (action instanceof SubstitutionAction) {
        applySubstitution(action, tokens, index2);
        contextParams.context[index2] = action.substitution;
      }
    });
  });
}
function getContextParams(tokens, index) {
  var context = tokens.map(function(token) {
    return token.activeState.value;
  });
  return new ContextParams(context, index || 0);
}
function arabicRequiredLigatures(range) {
  var this$1 = this;
  var script = "arab";
  var tokens = this.tokenizer.getRangeTokens(range);
  var contextParams = getContextParams(tokens);
  contextParams.context.forEach(function(glyphIndex, index) {
    contextParams.setCurrentIndex(index);
    var substitutions = this$1.query.lookupFeature({
      tag: "rlig",
      script,
      contextParams
    });
    if (substitutions.length) {
      substitutions.forEach(
        function(action) {
          return applySubstitution(action, tokens, index);
        }
      );
      contextParams = getContextParams(tokens);
    }
  });
}
function latinWordStartCheck(contextParams) {
  var char = contextParams.current;
  var prevChar = contextParams.get(-1);
  return (
    // ? latin first char
    prevChar === null && isLatinChar(char) || // ? latin char preceded with a non latin char
    !isLatinChar(prevChar) && isLatinChar(char)
  );
}
function latinWordEndCheck(contextParams) {
  var nextChar = contextParams.get(1);
  return (
    // ? last latin char
    nextChar === null || // ? next char is not latin
    !isLatinChar(nextChar)
  );
}
var latinWordCheck = {
  startCheck: latinWordStartCheck,
  endCheck: latinWordEndCheck
};
function getContextParams$1(tokens, index) {
  var context = tokens.map(function(token) {
    return token.activeState.value;
  });
  return new ContextParams(context, index || 0);
}
function latinLigature(range) {
  var this$1 = this;
  var script = "latn";
  var tokens = this.tokenizer.getRangeTokens(range);
  var contextParams = getContextParams$1(tokens);
  contextParams.context.forEach(function(glyphIndex, index) {
    contextParams.setCurrentIndex(index);
    var substitutions = this$1.query.lookupFeature({
      tag: "liga",
      script,
      contextParams
    });
    if (substitutions.length) {
      substitutions.forEach(
        function(action) {
          return applySubstitution(action, tokens, index);
        }
      );
      contextParams = getContextParams$1(tokens);
    }
  });
}
function Bidi(baseDir) {
  this.baseDir = baseDir || "ltr";
  this.tokenizer = new Tokenizer();
  this.featuresTags = {};
}
Bidi.prototype.setText = function(text) {
  this.text = text;
};
Bidi.prototype.contextChecks = {
  latinWordCheck,
  arabicWordCheck,
  arabicSentenceCheck
};
function registerContextChecker(checkId) {
  var check2 = this.contextChecks[checkId + "Check"];
  return this.tokenizer.registerContextChecker(
    checkId,
    check2.startCheck,
    check2.endCheck
  );
}
function tokenizeText() {
  registerContextChecker.call(this, "latinWord");
  registerContextChecker.call(this, "arabicWord");
  registerContextChecker.call(this, "arabicSentence");
  return this.tokenizer.tokenize(this.text);
}
function reverseArabicSentences() {
  var this$1 = this;
  var ranges = this.tokenizer.getContextRanges("arabicSentence");
  ranges.forEach(function(range) {
    var rangeTokens = this$1.tokenizer.getRangeTokens(range);
    this$1.tokenizer.replaceRange(
      range.startIndex,
      range.endOffset,
      rangeTokens.reverse()
    );
  });
}
Bidi.prototype.registerFeatures = function(script, tags) {
  var this$1 = this;
  var supportedTags = tags.filter(
    function(tag) {
      return this$1.query.supports({ script, tag });
    }
  );
  if (!this.featuresTags.hasOwnProperty(script)) {
    this.featuresTags[script] = supportedTags;
  } else {
    this.featuresTags[script] = this.featuresTags[script].concat(supportedTags);
  }
};
Bidi.prototype.applyFeatures = function(font, features) {
  if (!font) {
    throw new Error(
      "No valid font was provided to apply features"
    );
  }
  if (!this.query) {
    this.query = new FeatureQuery(font);
  }
  for (var f = 0; f < features.length; f++) {
    var feature = features[f];
    if (!this.query.supports({ script: feature.script })) {
      continue;
    }
    this.registerFeatures(feature.script, feature.tags);
  }
};
Bidi.prototype.registerModifier = function(modifierId, condition, modifier) {
  this.tokenizer.registerModifier(modifierId, condition, modifier);
};
function checkGlyphIndexStatus() {
  if (this.tokenizer.registeredModifiers.indexOf("glyphIndex") === -1) {
    throw new Error(
      "glyphIndex modifier is required to apply arabic presentation features."
    );
  }
}
function applyArabicPresentationForms() {
  var this$1 = this;
  var script = "arab";
  if (!this.featuresTags.hasOwnProperty(script)) {
    return;
  }
  checkGlyphIndexStatus.call(this);
  var ranges = this.tokenizer.getContextRanges("arabicWord");
  ranges.forEach(function(range) {
    arabicPresentationForms.call(this$1, range);
  });
}
function applyArabicRequireLigatures() {
  var this$1 = this;
  var script = "arab";
  if (!this.featuresTags.hasOwnProperty(script)) {
    return;
  }
  var tags = this.featuresTags[script];
  if (tags.indexOf("rlig") === -1) {
    return;
  }
  checkGlyphIndexStatus.call(this);
  var ranges = this.tokenizer.getContextRanges("arabicWord");
  ranges.forEach(function(range) {
    arabicRequiredLigatures.call(this$1, range);
  });
}
function applyLatinLigatures() {
  var this$1 = this;
  var script = "latn";
  if (!this.featuresTags.hasOwnProperty(script)) {
    return;
  }
  var tags = this.featuresTags[script];
  if (tags.indexOf("liga") === -1) {
    return;
  }
  checkGlyphIndexStatus.call(this);
  var ranges = this.tokenizer.getContextRanges("latinWord");
  ranges.forEach(function(range) {
    latinLigature.call(this$1, range);
  });
}
Bidi.prototype.checkContextReady = function(contextId) {
  return !!this.tokenizer.getContext(contextId);
};
Bidi.prototype.applyFeaturesToContexts = function() {
  if (this.checkContextReady("arabicWord")) {
    applyArabicPresentationForms.call(this);
    applyArabicRequireLigatures.call(this);
  }
  if (this.checkContextReady("latinWord")) {
    applyLatinLigatures.call(this);
  }
  if (this.checkContextReady("arabicSentence")) {
    reverseArabicSentences.call(this);
  }
};
Bidi.prototype.processText = function(text) {
  if (!this.text || this.text !== text) {
    this.setText(text);
    tokenizeText.call(this);
    this.applyFeaturesToContexts();
  }
};
Bidi.prototype.getBidiText = function(text) {
  this.processText(text);
  return this.tokenizer.getText();
};
Bidi.prototype.getTextGlyphs = function(text) {
  this.processText(text);
  var indexes = [];
  for (var i = 0; i < this.tokenizer.tokens.length; i++) {
    var token = this.tokenizer.tokens[i];
    if (token.state.deleted) {
      continue;
    }
    var index = token.activeState.value;
    indexes.push(Array.isArray(index) ? index[0] : index);
  }
  return indexes;
};
function Font(options) {
  options = options || {};
  options.tables = options.tables || {};
  if (!options.empty) {
    checkArgument(
      options.familyName,
      "When creating a new Font object, familyName is required."
    );
    checkArgument(
      options.styleName,
      "When creating a new Font object, styleName is required."
    );
    checkArgument(
      options.unitsPerEm,
      "When creating a new Font object, unitsPerEm is required."
    );
    checkArgument(
      options.ascender,
      "When creating a new Font object, ascender is required."
    );
    checkArgument(
      options.descender <= 0,
      "When creating a new Font object, negative descender value is required."
    );
    this.unitsPerEm = options.unitsPerEm || 1e3;
    this.ascender = options.ascender;
    this.descender = options.descender;
    this.createdTimestamp = options.createdTimestamp;
    this.tables = Object.assign(options.tables, {
      os2: Object.assign(
        {
          usWeightClass: options.weightClass || this.usWeightClasses.MEDIUM,
          usWidthClass: options.widthClass || this.usWidthClasses.MEDIUM,
          fsSelection: options.fsSelection || this.fsSelectionValues.REGULAR
        },
        options.tables.os2
      )
    });
  }
  this.supported = true;
  this.glyphs = new glyphset.GlyphSet(this, options.glyphs || []);
  this.encoding = new DefaultEncoding(this);
  this.position = new Position(this);
  this.substitution = new Substitution(this);
  this.tables = this.tables || {};
  this._push = null;
  this._hmtxTableData = {};
  Object.defineProperty(this, "hinting", {
    get: function() {
      if (this._hinting) {
        return this._hinting;
      }
      if (this.outlinesFormat === "truetype") {
        return this._hinting = new Hinting(this);
      }
    }
  });
}
Font.prototype.hasChar = function(c2) {
  return this.encoding.charToGlyphIndex(c2) !== null;
};
Font.prototype.charToGlyphIndex = function(s) {
  return this.encoding.charToGlyphIndex(s);
};
Font.prototype.charToGlyph = function(c2) {
  var glyphIndex = this.charToGlyphIndex(c2);
  var glyph = this.glyphs.get(glyphIndex);
  if (!glyph) {
    glyph = this.glyphs.get(0);
  }
  return glyph;
};
Font.prototype.updateFeatures = function(options) {
  return this.defaultRenderOptions.features.map(function(feature) {
    if (feature.script === "latn") {
      return {
        script: "latn",
        tags: feature.tags.filter(function(tag) {
          return options[tag];
        })
      };
    } else {
      return feature;
    }
  });
};
Font.prototype.stringToGlyphs = function(s, options) {
  var this$1 = this;
  var bidi = new Bidi();
  var charToGlyphIndexMod = function(token) {
    return this$1.charToGlyphIndex(token.char);
  };
  bidi.registerModifier("glyphIndex", null, charToGlyphIndexMod);
  var features = options ? this.updateFeatures(options.features) : this.defaultRenderOptions.features;
  bidi.applyFeatures(this, features);
  var indexes = bidi.getTextGlyphs(s);
  var length = indexes.length;
  var glyphs = new Array(length);
  var notdef = this.glyphs.get(0);
  for (var i = 0; i < length; i += 1) {
    glyphs[i] = this.glyphs.get(indexes[i]) || notdef;
  }
  return glyphs;
};
Font.prototype.getKerningValue = function(leftGlyph, rightGlyph) {
  leftGlyph = leftGlyph.index || leftGlyph;
  rightGlyph = rightGlyph.index || rightGlyph;
  var gposKerning = this.position.defaultKerningTables;
  if (gposKerning) {
    return this.position.getKerningValue(
      gposKerning,
      leftGlyph,
      rightGlyph
    );
  }
  return this.kerningPairs[leftGlyph + "," + rightGlyph] || 0;
};
Font.prototype.defaultRenderOptions = {
  kerning: true,
  features: [
    /**
     * these 4 features are required to render Arabic text properly
     * and shouldn't be turned off when rendering arabic text.
     */
    { script: "arab", tags: ["init", "medi", "fina", "rlig"] },
    { script: "latn", tags: ["liga", "rlig"] }
  ]
};
Font.prototype.forEachGlyph = function(text, x2, y, fontSize, options, callback) {
  x2 = x2 !== void 0 ? x2 : 0;
  y = y !== void 0 ? y : 0;
  fontSize = fontSize !== void 0 ? fontSize : 72;
  options = Object.assign({}, this.defaultRenderOptions, options);
  var fontScale = 1 / this.unitsPerEm * fontSize;
  var glyphs = this.stringToGlyphs(text, options);
  var kerningLookups;
  if (options.kerning) {
    var script = options.script || this.position.getDefaultScriptName();
    kerningLookups = this.position.getKerningTables(
      script,
      options.language
    );
  }
  for (var i = 0; i < glyphs.length; i += 1) {
    var glyph = glyphs[i];
    callback.call(this, glyph, x2, y, fontSize, options);
    if (glyph.advanceWidth) {
      x2 += glyph.advanceWidth * fontScale;
    }
    if (options.kerning && i < glyphs.length - 1) {
      var kerningValue = kerningLookups ? this.position.getKerningValue(
        kerningLookups,
        glyph.index,
        glyphs[i + 1].index
      ) : this.getKerningValue(glyph, glyphs[i + 1]);
      x2 += kerningValue * fontScale;
    }
    if (options.letterSpacing) {
      x2 += options.letterSpacing * fontSize;
    } else if (options.tracking) {
      x2 += options.tracking / 1e3 * fontSize;
    }
  }
  return x2;
};
Font.prototype.getPath = function(text, x2, y, fontSize, options) {
  var fullPath = new Path();
  this.forEachGlyph(
    text,
    x2,
    y,
    fontSize,
    options,
    function(glyph, gX, gY, gFontSize) {
      var glyphPath = glyph.getPath(gX, gY, gFontSize, options, this);
      fullPath.extend(glyphPath);
    }
  );
  return fullPath;
};
Font.prototype.getPaths = function(text, x2, y, fontSize, options) {
  var glyphPaths = [];
  this.forEachGlyph(
    text,
    x2,
    y,
    fontSize,
    options,
    function(glyph, gX, gY, gFontSize) {
      var glyphPath = glyph.getPath(gX, gY, gFontSize, options, this);
      glyphPaths.push(glyphPath);
    }
  );
  return glyphPaths;
};
Font.prototype.getAdvanceWidth = function(text, fontSize, options) {
  return this.forEachGlyph(text, 0, 0, fontSize, options, function() {
  });
};
Font.prototype.fsSelectionValues = {
  ITALIC: 1,
  //1
  UNDERSCORE: 2,
  //2
  NEGATIVE: 4,
  //4
  OUTLINED: 8,
  //8
  STRIKEOUT: 16,
  //16
  BOLD: 32,
  //32
  REGULAR: 64,
  //64
  USER_TYPO_METRICS: 128,
  //128
  WWS: 256,
  //256
  OBLIQUE: 512
  //512
};
Font.prototype.usWidthClasses = {
  ULTRA_CONDENSED: 1,
  EXTRA_CONDENSED: 2,
  CONDENSED: 3,
  SEMI_CONDENSED: 4,
  MEDIUM: 5,
  SEMI_EXPANDED: 6,
  EXPANDED: 7,
  EXTRA_EXPANDED: 8,
  ULTRA_EXPANDED: 9
};
Font.prototype.usWeightClasses = {
  THIN: 100,
  EXTRA_LIGHT: 200,
  LIGHT: 300,
  NORMAL: 400,
  MEDIUM: 500,
  SEMI_BOLD: 600,
  BOLD: 700,
  EXTRA_BOLD: 800,
  BLACK: 900
};
function parseCmapTableFormat12(cmap2, p) {
  p.parseUShort();
  cmap2.length = p.parseULong();
  cmap2.language = p.parseULong();
  var groupCount;
  cmap2.groupCount = groupCount = p.parseULong();
  cmap2.glyphIndexMap = {};
  for (var i = 0; i < groupCount; i += 1) {
    var startCharCode = p.parseULong();
    var endCharCode = p.parseULong();
    var startGlyphId = p.parseULong();
    for (var c2 = startCharCode; c2 <= endCharCode; c2 += 1) {
      cmap2.glyphIndexMap[c2] = startGlyphId;
      startGlyphId++;
    }
  }
}
function parseCmapTableFormat4(cmap2, p, data, start, offset) {
  cmap2.length = p.parseUShort();
  cmap2.language = p.parseUShort();
  var segCount;
  cmap2.segCount = segCount = p.parseUShort() >> 1;
  p.skip("uShort", 3);
  cmap2.glyphIndexMap = {};
  var endCountParser = new parse.Parser(data, start + offset + 14);
  var startCountParser = new parse.Parser(
    data,
    start + offset + 16 + segCount * 2
  );
  var idDeltaParser = new parse.Parser(
    data,
    start + offset + 16 + segCount * 4
  );
  var idRangeOffsetParser = new parse.Parser(
    data,
    start + offset + 16 + segCount * 6
  );
  var glyphIndexOffset = start + offset + 16 + segCount * 8;
  for (var i = 0; i < segCount - 1; i += 1) {
    var glyphIndex = void 0;
    var endCount = endCountParser.parseUShort();
    var startCount = startCountParser.parseUShort();
    var idDelta = idDeltaParser.parseShort();
    var idRangeOffset = idRangeOffsetParser.parseUShort();
    for (var c2 = startCount; c2 <= endCount; c2 += 1) {
      if (idRangeOffset !== 0) {
        glyphIndexOffset = idRangeOffsetParser.offset + idRangeOffsetParser.relativeOffset - 2;
        glyphIndexOffset += idRangeOffset;
        glyphIndexOffset += (c2 - startCount) * 2;
        glyphIndex = parse.getUShort(data, glyphIndexOffset);
        if (glyphIndex !== 0) {
          glyphIndex = glyphIndex + idDelta & 65535;
        }
      } else {
        glyphIndex = c2 + idDelta & 65535;
      }
      cmap2.glyphIndexMap[c2] = glyphIndex;
    }
  }
}
function parseCmapTable(data, start) {
  var cmap2 = {};
  cmap2.version = parse.getUShort(data, start);
  check.argument(cmap2.version === 0, "cmap table version should be 0.");
  cmap2.numTables = parse.getUShort(data, start + 2);
  var offset = -1;
  for (var i = cmap2.numTables - 1; i >= 0; i -= 1) {
    var platformId = parse.getUShort(data, start + 4 + i * 8);
    var encodingId = parse.getUShort(data, start + 4 + i * 8 + 2);
    if (platformId === 3 && (encodingId === 0 || encodingId === 1 || encodingId === 10) || platformId === 0 && (encodingId === 0 || encodingId === 1 || encodingId === 2 || encodingId === 3 || encodingId === 4)) {
      offset = parse.getULong(data, start + 4 + i * 8 + 4);
      break;
    }
  }
  if (offset === -1) {
    throw new Error("No valid cmap sub-tables found.");
  }
  var p = new parse.Parser(data, start + offset);
  cmap2.format = p.parseUShort();
  if (cmap2.format === 12) {
    parseCmapTableFormat12(cmap2, p);
  } else if (cmap2.format === 4) {
    parseCmapTableFormat4(cmap2, p, data, start, offset);
  } else {
    throw new Error(
      "Only format 4 and 12 cmap tables are supported (found format " + cmap2.format + ")."
    );
  }
  return cmap2;
}
var cmap = { parse: parseCmapTable };
function calcCFFSubroutineBias(subrs) {
  var bias;
  if (subrs.length < 1240) {
    bias = 107;
  } else if (subrs.length < 33900) {
    bias = 1131;
  } else {
    bias = 32768;
  }
  return bias;
}
function parseCFFIndex(data, start, conversionFn) {
  var offsets = [];
  var objects = [];
  var count = parse.getCard16(data, start);
  var objectOffset;
  var endOffset;
  if (count !== 0) {
    var offsetSize = parse.getByte(data, start + 2);
    objectOffset = start + (count + 1) * offsetSize + 2;
    var pos = start + 3;
    for (var i = 0; i < count + 1; i += 1) {
      offsets.push(parse.getOffset(data, pos, offsetSize));
      pos += offsetSize;
    }
    endOffset = objectOffset + offsets[count];
  } else {
    endOffset = start + 2;
  }
  for (var i$1 = 0; i$1 < offsets.length - 1; i$1 += 1) {
    var value = parse.getBytes(
      data,
      objectOffset + offsets[i$1],
      objectOffset + offsets[i$1 + 1]
    );
    if (conversionFn) {
      value = conversionFn(value);
    }
    objects.push(value);
  }
  return { objects, startOffset: start, endOffset };
}
function parseCFFIndexLowMemory(data, start) {
  var offsets = [];
  var count = parse.getCard16(data, start);
  var objectOffset;
  var endOffset;
  if (count !== 0) {
    var offsetSize = parse.getByte(data, start + 2);
    objectOffset = start + (count + 1) * offsetSize + 2;
    var pos = start + 3;
    for (var i = 0; i < count + 1; i += 1) {
      offsets.push(parse.getOffset(data, pos, offsetSize));
      pos += offsetSize;
    }
    endOffset = objectOffset + offsets[count];
  } else {
    endOffset = start + 2;
  }
  return { offsets, startOffset: start, endOffset };
}
function getCffIndexObject(i, offsets, data, start, conversionFn) {
  var count = parse.getCard16(data, start);
  var objectOffset = 0;
  if (count !== 0) {
    var offsetSize = parse.getByte(data, start + 2);
    objectOffset = start + (count + 1) * offsetSize + 2;
  }
  var value = parse.getBytes(
    data,
    objectOffset + offsets[i],
    objectOffset + offsets[i + 1]
  );
  if (conversionFn) {
    value = conversionFn(value);
  }
  return value;
}
function parseFloatOperand(parser) {
  var s = "";
  var eof = 15;
  var lookup = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    ".",
    "E",
    "E-",
    null,
    "-"
  ];
  while (true) {
    var b = parser.parseByte();
    var n1 = b >> 4;
    var n2 = b & 15;
    if (n1 === eof) {
      break;
    }
    s += lookup[n1];
    if (n2 === eof) {
      break;
    }
    s += lookup[n2];
  }
  return parseFloat(s);
}
function parseOperand(parser, b0) {
  var b1;
  var b2;
  var b3;
  var b4;
  if (b0 === 28) {
    b1 = parser.parseByte();
    b2 = parser.parseByte();
    return b1 << 8 | b2;
  }
  if (b0 === 29) {
    b1 = parser.parseByte();
    b2 = parser.parseByte();
    b3 = parser.parseByte();
    b4 = parser.parseByte();
    return b1 << 24 | b2 << 16 | b3 << 8 | b4;
  }
  if (b0 === 30) {
    return parseFloatOperand(parser);
  }
  if (b0 >= 32 && b0 <= 246) {
    return b0 - 139;
  }
  if (b0 >= 247 && b0 <= 250) {
    b1 = parser.parseByte();
    return (b0 - 247) * 256 + b1 + 108;
  }
  if (b0 >= 251 && b0 <= 254) {
    b1 = parser.parseByte();
    return -(b0 - 251) * 256 - b1 - 108;
  }
  throw new Error("Invalid b0 " + b0);
}
function entriesToObject(entries) {
  var o = {};
  for (var i = 0; i < entries.length; i += 1) {
    var key = entries[i][0];
    var values = entries[i][1];
    var value = void 0;
    if (values.length === 1) {
      value = values[0];
    } else {
      value = values;
    }
    if (o.hasOwnProperty(key) && !isNaN(o[key])) {
      throw new Error("Object " + o + " already has key " + key);
    }
    o[key] = value;
  }
  return o;
}
function parseCFFDict(data, start, size) {
  start = start !== void 0 ? start : 0;
  var parser = new parse.Parser(data, start);
  var entries = [];
  var operands = [];
  size = size !== void 0 ? size : data.length;
  while (parser.relativeOffset < size) {
    var op2 = parser.parseByte();
    if (op2 <= 21) {
      if (op2 === 12) {
        op2 = 1200 + parser.parseByte();
      }
      entries.push([op2, operands]);
      operands = [];
    } else {
      operands.push(parseOperand(parser, op2));
    }
  }
  return entriesToObject(entries);
}
function getCFFString(strings, index) {
  if (index <= 390) {
    index = cffStandardStrings[index];
  } else {
    index = strings[index - 391];
  }
  return index;
}
function interpretDict(dict, meta2, strings) {
  var newDict = {};
  var value;
  for (var i = 0; i < meta2.length; i += 1) {
    var m2 = meta2[i];
    if (Array.isArray(m2.type)) {
      var values = [];
      values.length = m2.type.length;
      for (var j = 0; j < m2.type.length; j++) {
        value = dict[m2.op] !== void 0 ? dict[m2.op][j] : void 0;
        if (value === void 0) {
          value = m2.value !== void 0 && m2.value[j] !== void 0 ? m2.value[j] : null;
        }
        if (m2.type[j] === "SID") {
          value = getCFFString(strings, value);
        }
        values[j] = value;
      }
      newDict[m2.name] = values;
    } else {
      value = dict[m2.op];
      if (value === void 0) {
        value = m2.value !== void 0 ? m2.value : null;
      }
      if (m2.type === "SID") {
        value = getCFFString(strings, value);
      }
      newDict[m2.name] = value;
    }
  }
  return newDict;
}
function parseCFFHeader(data, start) {
  var header = {};
  header.formatMajor = parse.getCard8(data, start);
  header.formatMinor = parse.getCard8(data, start + 1);
  header.size = parse.getCard8(data, start + 2);
  header.offsetSize = parse.getCard8(data, start + 3);
  header.startOffset = start;
  header.endOffset = start + 4;
  return header;
}
var TOP_DICT_META = [
  { name: "version", op: 0, type: "SID" },
  { name: "notice", op: 1, type: "SID" },
  { name: "copyright", op: 1200, type: "SID" },
  { name: "fullName", op: 2, type: "SID" },
  { name: "familyName", op: 3, type: "SID" },
  { name: "weight", op: 4, type: "SID" },
  { name: "isFixedPitch", op: 1201, type: "number", value: 0 },
  { name: "italicAngle", op: 1202, type: "number", value: 0 },
  { name: "underlinePosition", op: 1203, type: "number", value: -100 },
  { name: "underlineThickness", op: 1204, type: "number", value: 50 },
  { name: "paintType", op: 1205, type: "number", value: 0 },
  { name: "charstringType", op: 1206, type: "number", value: 2 },
  {
    name: "fontMatrix",
    op: 1207,
    type: ["real", "real", "real", "real", "real", "real"],
    value: [1e-3, 0, 0, 1e-3, 0, 0]
  },
  { name: "uniqueId", op: 13, type: "number" },
  {
    name: "fontBBox",
    op: 5,
    type: ["number", "number", "number", "number"],
    value: [0, 0, 0, 0]
  },
  { name: "strokeWidth", op: 1208, type: "number", value: 0 },
  { name: "xuid", op: 14, type: [], value: null },
  { name: "charset", op: 15, type: "offset", value: 0 },
  { name: "encoding", op: 16, type: "offset", value: 0 },
  { name: "charStrings", op: 17, type: "offset", value: 0 },
  { name: "private", op: 18, type: ["number", "offset"], value: [0, 0] },
  { name: "ros", op: 1230, type: ["SID", "SID", "number"] },
  { name: "cidFontVersion", op: 1231, type: "number", value: 0 },
  { name: "cidFontRevision", op: 1232, type: "number", value: 0 },
  { name: "cidFontType", op: 1233, type: "number", value: 0 },
  { name: "cidCount", op: 1234, type: "number", value: 8720 },
  { name: "uidBase", op: 1235, type: "number" },
  { name: "fdArray", op: 1236, type: "offset" },
  { name: "fdSelect", op: 1237, type: "offset" },
  { name: "fontName", op: 1238, type: "SID" }
];
var PRIVATE_DICT_META = [
  { name: "subrs", op: 19, type: "offset", value: 0 },
  { name: "defaultWidthX", op: 20, type: "number", value: 0 },
  { name: "nominalWidthX", op: 21, type: "number", value: 0 }
];
function parseCFFTopDict(data, strings) {
  var dict = parseCFFDict(data, 0, data.byteLength);
  return interpretDict(dict, TOP_DICT_META, strings);
}
function parseCFFPrivateDict(data, start, size, strings) {
  var dict = parseCFFDict(data, start, size);
  return interpretDict(dict, PRIVATE_DICT_META, strings);
}
function gatherCFFTopDicts(data, start, cffIndex, strings) {
  var topDictArray = [];
  for (var iTopDict = 0; iTopDict < cffIndex.length; iTopDict += 1) {
    var topDictData = new DataView(
      new Uint8Array(cffIndex[iTopDict]).buffer
    );
    var topDict = parseCFFTopDict(topDictData, strings);
    topDict._subrs = [];
    topDict._subrsBias = 0;
    topDict._defaultWidthX = 0;
    topDict._nominalWidthX = 0;
    var privateSize = topDict.private[0];
    var privateOffset = topDict.private[1];
    if (privateSize !== 0 && privateOffset !== 0) {
      var privateDict = parseCFFPrivateDict(
        data,
        privateOffset + start,
        privateSize,
        strings
      );
      topDict._defaultWidthX = privateDict.defaultWidthX;
      topDict._nominalWidthX = privateDict.nominalWidthX;
      if (privateDict.subrs !== 0) {
        var subrOffset = privateOffset + privateDict.subrs;
        var subrIndex = parseCFFIndex(data, subrOffset + start);
        topDict._subrs = subrIndex.objects;
        topDict._subrsBias = calcCFFSubroutineBias(topDict._subrs);
      }
      topDict._privateDict = privateDict;
    }
    topDictArray.push(topDict);
  }
  return topDictArray;
}
function parseCFFCharset(data, start, nGlyphs, strings) {
  var sid;
  var count;
  var parser = new parse.Parser(data, start);
  nGlyphs -= 1;
  var charset = [".notdef"];
  var format = parser.parseCard8();
  if (format === 0) {
    for (var i = 0; i < nGlyphs; i += 1) {
      sid = parser.parseSID();
      charset.push(getCFFString(strings, sid));
    }
  } else if (format === 1) {
    while (charset.length <= nGlyphs) {
      sid = parser.parseSID();
      count = parser.parseCard8();
      for (var i$1 = 0; i$1 <= count; i$1 += 1) {
        charset.push(getCFFString(strings, sid));
        sid += 1;
      }
    }
  } else if (format === 2) {
    while (charset.length <= nGlyphs) {
      sid = parser.parseSID();
      count = parser.parseCard16();
      for (var i$2 = 0; i$2 <= count; i$2 += 1) {
        charset.push(getCFFString(strings, sid));
        sid += 1;
      }
    }
  } else {
    throw new Error("Unknown charset format " + format);
  }
  return charset;
}
function parseCFFEncoding(data, start, charset) {
  var code;
  var enc = {};
  var parser = new parse.Parser(data, start);
  var format = parser.parseCard8();
  if (format === 0) {
    var nCodes = parser.parseCard8();
    for (var i = 0; i < nCodes; i += 1) {
      code = parser.parseCard8();
      enc[code] = i;
    }
  } else if (format === 1) {
    var nRanges = parser.parseCard8();
    code = 1;
    for (var i$1 = 0; i$1 < nRanges; i$1 += 1) {
      var first = parser.parseCard8();
      var nLeft = parser.parseCard8();
      for (var j = first; j <= first + nLeft; j += 1) {
        enc[j] = code;
        code += 1;
      }
    }
  } else {
    throw new Error("Unknown encoding format " + format);
  }
  return new CffEncoding(enc, charset);
}
function parseCFFCharstring(font, glyph, code) {
  var c1x;
  var c1y;
  var c2x;
  var c2y;
  var p = new Path();
  var stack = [];
  var nStems = 0;
  var haveWidth = false;
  var open = false;
  var x2 = 0;
  var y = 0;
  var subrs;
  var subrsBias;
  var defaultWidthX;
  var nominalWidthX;
  if (font.isCIDFont) {
    var fdIndex = font.tables.cff.topDict._fdSelect[glyph.index];
    var fdDict = font.tables.cff.topDict._fdArray[fdIndex];
    subrs = fdDict._subrs;
    subrsBias = fdDict._subrsBias;
    defaultWidthX = fdDict._defaultWidthX;
    nominalWidthX = fdDict._nominalWidthX;
  } else {
    subrs = font.tables.cff.topDict._subrs;
    subrsBias = font.tables.cff.topDict._subrsBias;
    defaultWidthX = font.tables.cff.topDict._defaultWidthX;
    nominalWidthX = font.tables.cff.topDict._nominalWidthX;
  }
  var width = defaultWidthX;
  function newContour(x3, y2) {
    if (open) {
      p.closePath();
    }
    p.moveTo(x3, y2);
    open = true;
  }
  function parseStems() {
    var hasWidthArg;
    hasWidthArg = stack.length % 2 !== 0;
    if (hasWidthArg && !haveWidth) {
      width = stack.shift() + nominalWidthX;
    }
    nStems += stack.length >> 1;
    stack.length = 0;
    haveWidth = true;
  }
  function parse2(code2) {
    var b1;
    var b2;
    var b3;
    var b4;
    var codeIndex;
    var subrCode;
    var jpx;
    var jpy;
    var c3x;
    var c3y;
    var c4x;
    var c4y;
    var i = 0;
    while (i < code2.length) {
      var v2 = code2[i];
      i += 1;
      switch (v2) {
        case 1:
          parseStems();
          break;
        case 3:
          parseStems();
          break;
        case 4:
          if (stack.length > 1 && !haveWidth) {
            width = stack.shift() + nominalWidthX;
            haveWidth = true;
          }
          y += stack.pop();
          newContour(x2, y);
          break;
        case 5:
          while (stack.length > 0) {
            x2 += stack.shift();
            y += stack.shift();
            p.lineTo(x2, y);
          }
          break;
        case 6:
          while (stack.length > 0) {
            x2 += stack.shift();
            p.lineTo(x2, y);
            if (stack.length === 0) {
              break;
            }
            y += stack.shift();
            p.lineTo(x2, y);
          }
          break;
        case 7:
          while (stack.length > 0) {
            y += stack.shift();
            p.lineTo(x2, y);
            if (stack.length === 0) {
              break;
            }
            x2 += stack.shift();
            p.lineTo(x2, y);
          }
          break;
        case 8:
          while (stack.length > 0) {
            c1x = x2 + stack.shift();
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x + stack.shift();
            y = c2y + stack.shift();
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          break;
        case 10:
          codeIndex = stack.pop() + subrsBias;
          subrCode = subrs[codeIndex];
          if (subrCode) {
            parse2(subrCode);
          }
          break;
        case 11:
          return;
        case 12:
          v2 = code2[i];
          i += 1;
          switch (v2) {
            case 35:
              c1x = x2 + stack.shift();
              c1y = y + stack.shift();
              c2x = c1x + stack.shift();
              c2y = c1y + stack.shift();
              jpx = c2x + stack.shift();
              jpy = c2y + stack.shift();
              c3x = jpx + stack.shift();
              c3y = jpy + stack.shift();
              c4x = c3x + stack.shift();
              c4y = c3y + stack.shift();
              x2 = c4x + stack.shift();
              y = c4y + stack.shift();
              stack.shift();
              p.curveTo(c1x, c1y, c2x, c2y, jpx, jpy);
              p.curveTo(c3x, c3y, c4x, c4y, x2, y);
              break;
            case 34:
              c1x = x2 + stack.shift();
              c1y = y;
              c2x = c1x + stack.shift();
              c2y = c1y + stack.shift();
              jpx = c2x + stack.shift();
              jpy = c2y;
              c3x = jpx + stack.shift();
              c3y = c2y;
              c4x = c3x + stack.shift();
              c4y = y;
              x2 = c4x + stack.shift();
              p.curveTo(c1x, c1y, c2x, c2y, jpx, jpy);
              p.curveTo(c3x, c3y, c4x, c4y, x2, y);
              break;
            case 36:
              c1x = x2 + stack.shift();
              c1y = y + stack.shift();
              c2x = c1x + stack.shift();
              c2y = c1y + stack.shift();
              jpx = c2x + stack.shift();
              jpy = c2y;
              c3x = jpx + stack.shift();
              c3y = c2y;
              c4x = c3x + stack.shift();
              c4y = c3y + stack.shift();
              x2 = c4x + stack.shift();
              p.curveTo(c1x, c1y, c2x, c2y, jpx, jpy);
              p.curveTo(c3x, c3y, c4x, c4y, x2, y);
              break;
            case 37:
              c1x = x2 + stack.shift();
              c1y = y + stack.shift();
              c2x = c1x + stack.shift();
              c2y = c1y + stack.shift();
              jpx = c2x + stack.shift();
              jpy = c2y + stack.shift();
              c3x = jpx + stack.shift();
              c3y = jpy + stack.shift();
              c4x = c3x + stack.shift();
              c4y = c3y + stack.shift();
              if (Math.abs(c4x - x2) > Math.abs(c4y - y)) {
                x2 = c4x + stack.shift();
              } else {
                y = c4y + stack.shift();
              }
              p.curveTo(c1x, c1y, c2x, c2y, jpx, jpy);
              p.curveTo(c3x, c3y, c4x, c4y, x2, y);
              break;
            default:
              console.log(
                "Glyph " + glyph.index + ": unknown operator 1200" + v2
              );
              stack.length = 0;
          }
          break;
        case 14:
          if (stack.length > 0 && !haveWidth) {
            width = stack.shift() + nominalWidthX;
            haveWidth = true;
          }
          if (open) {
            p.closePath();
            open = false;
          }
          break;
        case 18:
          parseStems();
          break;
        case 19:
        case 20:
          parseStems();
          i += nStems + 7 >> 3;
          break;
        case 21:
          if (stack.length > 2 && !haveWidth) {
            width = stack.shift() + nominalWidthX;
            haveWidth = true;
          }
          y += stack.pop();
          x2 += stack.pop();
          newContour(x2, y);
          break;
        case 22:
          if (stack.length > 1 && !haveWidth) {
            width = stack.shift() + nominalWidthX;
            haveWidth = true;
          }
          x2 += stack.pop();
          newContour(x2, y);
          break;
        case 23:
          parseStems();
          break;
        case 24:
          while (stack.length > 2) {
            c1x = x2 + stack.shift();
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x + stack.shift();
            y = c2y + stack.shift();
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          x2 += stack.shift();
          y += stack.shift();
          p.lineTo(x2, y);
          break;
        case 25:
          while (stack.length > 6) {
            x2 += stack.shift();
            y += stack.shift();
            p.lineTo(x2, y);
          }
          c1x = x2 + stack.shift();
          c1y = y + stack.shift();
          c2x = c1x + stack.shift();
          c2y = c1y + stack.shift();
          x2 = c2x + stack.shift();
          y = c2y + stack.shift();
          p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          break;
        case 26:
          if (stack.length % 2) {
            x2 += stack.shift();
          }
          while (stack.length > 0) {
            c1x = x2;
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x;
            y = c2y + stack.shift();
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          break;
        case 27:
          if (stack.length % 2) {
            y += stack.shift();
          }
          while (stack.length > 0) {
            c1x = x2 + stack.shift();
            c1y = y;
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x + stack.shift();
            y = c2y;
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          break;
        case 28:
          b1 = code2[i];
          b2 = code2[i + 1];
          stack.push((b1 << 24 | b2 << 16) >> 16);
          i += 2;
          break;
        case 29:
          codeIndex = stack.pop() + font.gsubrsBias;
          subrCode = font.gsubrs[codeIndex];
          if (subrCode) {
            parse2(subrCode);
          }
          break;
        case 30:
          while (stack.length > 0) {
            c1x = x2;
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x + stack.shift();
            y = c2y + (stack.length === 1 ? stack.shift() : 0);
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
            if (stack.length === 0) {
              break;
            }
            c1x = x2 + stack.shift();
            c1y = y;
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            y = c2y + stack.shift();
            x2 = c2x + (stack.length === 1 ? stack.shift() : 0);
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          break;
        case 31:
          while (stack.length > 0) {
            c1x = x2 + stack.shift();
            c1y = y;
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            y = c2y + stack.shift();
            x2 = c2x + (stack.length === 1 ? stack.shift() : 0);
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
            if (stack.length === 0) {
              break;
            }
            c1x = x2;
            c1y = y + stack.shift();
            c2x = c1x + stack.shift();
            c2y = c1y + stack.shift();
            x2 = c2x + stack.shift();
            y = c2y + (stack.length === 1 ? stack.shift() : 0);
            p.curveTo(c1x, c1y, c2x, c2y, x2, y);
          }
          break;
        default:
          if (v2 < 32) {
            console.log(
              "Glyph " + glyph.index + ": unknown operator " + v2
            );
          } else if (v2 < 247) {
            stack.push(v2 - 139);
          } else if (v2 < 251) {
            b1 = code2[i];
            i += 1;
            stack.push((v2 - 247) * 256 + b1 + 108);
          } else if (v2 < 255) {
            b1 = code2[i];
            i += 1;
            stack.push(-(v2 - 251) * 256 - b1 - 108);
          } else {
            b1 = code2[i];
            b2 = code2[i + 1];
            b3 = code2[i + 2];
            b4 = code2[i + 3];
            i += 4;
            stack.push(
              (b1 << 24 | b2 << 16 | b3 << 8 | b4) / 65536
            );
          }
      }
    }
  }
  parse2(code);
  glyph.advanceWidth = width;
  return p;
}
function parseCFFFDSelect(data, start, nGlyphs, fdArrayCount) {
  var fdSelect = [];
  var fdIndex;
  var parser = new parse.Parser(data, start);
  var format = parser.parseCard8();
  if (format === 0) {
    for (var iGid = 0; iGid < nGlyphs; iGid++) {
      fdIndex = parser.parseCard8();
      if (fdIndex >= fdArrayCount) {
        throw new Error(
          "CFF table CID Font FDSelect has bad FD index value " + fdIndex + " (FD count " + fdArrayCount + ")"
        );
      }
      fdSelect.push(fdIndex);
    }
  } else if (format === 3) {
    var nRanges = parser.parseCard16();
    var first = parser.parseCard16();
    if (first !== 0) {
      throw new Error(
        "CFF Table CID Font FDSelect format 3 range has bad initial GID " + first
      );
    }
    var next;
    for (var iRange = 0; iRange < nRanges; iRange++) {
      fdIndex = parser.parseCard8();
      next = parser.parseCard16();
      if (fdIndex >= fdArrayCount) {
        throw new Error(
          "CFF table CID Font FDSelect has bad FD index value " + fdIndex + " (FD count " + fdArrayCount + ")"
        );
      }
      if (next > nGlyphs) {
        throw new Error(
          "CFF Table CID Font FDSelect format 3 range has bad GID " + next
        );
      }
      for (; first < next; first++) {
        fdSelect.push(fdIndex);
      }
      first = next;
    }
    if (next !== nGlyphs) {
      throw new Error(
        "CFF Table CID Font FDSelect format 3 range has bad final GID " + next
      );
    }
  } else {
    throw new Error(
      "CFF Table CID Font FDSelect table has unsupported format " + format
    );
  }
  return fdSelect;
}
function parseCFFTable(data, start, font, opt) {
  font.tables.cff = {};
  var header = parseCFFHeader(data, start);
  var nameIndex = parseCFFIndex(
    data,
    header.endOffset,
    parse.bytesToString
  );
  var topDictIndex = parseCFFIndex(data, nameIndex.endOffset);
  var stringIndex = parseCFFIndex(
    data,
    topDictIndex.endOffset,
    parse.bytesToString
  );
  var globalSubrIndex = parseCFFIndex(data, stringIndex.endOffset);
  font.gsubrs = globalSubrIndex.objects;
  font.gsubrsBias = calcCFFSubroutineBias(font.gsubrs);
  var topDictArray = gatherCFFTopDicts(
    data,
    start,
    topDictIndex.objects,
    stringIndex.objects
  );
  if (topDictArray.length !== 1) {
    throw new Error(
      "CFF table has too many fonts in 'FontSet' - count of fonts NameIndex.length = " + topDictArray.length
    );
  }
  var topDict = topDictArray[0];
  font.tables.cff.topDict = topDict;
  if (topDict._privateDict) {
    font.defaultWidthX = topDict._privateDict.defaultWidthX;
    font.nominalWidthX = topDict._privateDict.nominalWidthX;
  }
  if (topDict.ros[0] !== void 0 && topDict.ros[1] !== void 0) {
    font.isCIDFont = true;
  }
  if (font.isCIDFont) {
    var fdArrayOffset = topDict.fdArray;
    var fdSelectOffset = topDict.fdSelect;
    if (fdArrayOffset === 0 || fdSelectOffset === 0) {
      throw new Error(
        "Font is marked as a CID font, but FDArray and/or FDSelect information is missing"
      );
    }
    fdArrayOffset += start;
    var fdArrayIndex = parseCFFIndex(data, fdArrayOffset);
    var fdArray = gatherCFFTopDicts(
      data,
      start,
      fdArrayIndex.objects,
      stringIndex.objects
    );
    topDict._fdArray = fdArray;
    fdSelectOffset += start;
    topDict._fdSelect = parseCFFFDSelect(
      data,
      fdSelectOffset,
      font.numGlyphs,
      fdArray.length
    );
  }
  var privateDictOffset = start + topDict.private[1];
  var privateDict = parseCFFPrivateDict(
    data,
    privateDictOffset,
    topDict.private[0],
    stringIndex.objects
  );
  font.defaultWidthX = privateDict.defaultWidthX;
  font.nominalWidthX = privateDict.nominalWidthX;
  if (privateDict.subrs !== 0) {
    var subrOffset = privateDictOffset + privateDict.subrs;
    var subrIndex = parseCFFIndex(data, subrOffset);
    font.subrs = subrIndex.objects;
    font.subrsBias = calcCFFSubroutineBias(font.subrs);
  } else {
    font.subrs = [];
    font.subrsBias = 0;
  }
  var charStringsIndex;
  if (opt.lowMemory) {
    charStringsIndex = parseCFFIndexLowMemory(
      data,
      start + topDict.charStrings
    );
    font.nGlyphs = charStringsIndex.offsets.length;
  } else {
    charStringsIndex = parseCFFIndex(data, start + topDict.charStrings);
    font.nGlyphs = charStringsIndex.objects.length;
  }
  var charset = parseCFFCharset(
    data,
    start + topDict.charset,
    font.nGlyphs,
    stringIndex.objects
  );
  if (topDict.encoding === 0) {
    font.cffEncoding = new CffEncoding(cffStandardEncoding, charset);
  } else if (topDict.encoding === 1) {
    font.cffEncoding = new CffEncoding(cffExpertEncoding, charset);
  } else {
    font.cffEncoding = parseCFFEncoding(
      data,
      start + topDict.encoding,
      charset
    );
  }
  font.encoding = font.encoding || font.cffEncoding;
  font.glyphs = new glyphset.GlyphSet(font);
  if (opt.lowMemory) {
    font._push = function(i2) {
      var charString2 = getCffIndexObject(
        i2,
        charStringsIndex.offsets,
        data,
        start + topDict.charStrings
      );
      font.glyphs.push(
        i2,
        glyphset.cffGlyphLoader(font, i2, parseCFFCharstring, charString2)
      );
    };
  } else {
    for (var i = 0; i < font.nGlyphs; i += 1) {
      var charString = charStringsIndex.objects[i];
      font.glyphs.push(
        i,
        glyphset.cffGlyphLoader(font, i, parseCFFCharstring, charString)
      );
    }
  }
}
var cff = { parse: parseCFFTable };
function parseFvarAxis(data, start, names) {
  var axis = {};
  var p = new parse.Parser(data, start);
  axis.tag = p.parseTag();
  axis.minValue = p.parseFixed();
  axis.defaultValue = p.parseFixed();
  axis.maxValue = p.parseFixed();
  p.skip("uShort", 1);
  axis.name = names[p.parseUShort()] || {};
  return axis;
}
function parseFvarInstance(data, start, axes, names) {
  var inst = {};
  var p = new parse.Parser(data, start);
  inst.name = names[p.parseUShort()] || {};
  p.skip("uShort", 1);
  inst.coordinates = {};
  for (var i = 0; i < axes.length; ++i) {
    inst.coordinates[axes[i].tag] = p.parseFixed();
  }
  return inst;
}
function parseFvarTable(data, start, names) {
  var p = new parse.Parser(data, start);
  var tableVersion = p.parseULong();
  check.argument(
    tableVersion === 65536,
    "Unsupported fvar table version."
  );
  var offsetToData = p.parseOffset16();
  p.skip("uShort", 1);
  var axisCount = p.parseUShort();
  var axisSize = p.parseUShort();
  var instanceCount = p.parseUShort();
  var instanceSize = p.parseUShort();
  var axes = [];
  for (var i = 0; i < axisCount; i++) {
    axes.push(
      parseFvarAxis(data, start + offsetToData + i * axisSize, names)
    );
  }
  var instances = [];
  var instanceStart = start + offsetToData + axisCount * axisSize;
  for (var j = 0; j < instanceCount; j++) {
    instances.push(
      parseFvarInstance(
        data,
        instanceStart + j * instanceSize,
        axes,
        names
      )
    );
  }
  return { axes, instances };
}
var fvar = { parse: parseFvarTable };
var attachList = function() {
  return {
    coverage: this.parsePointer(Parser.coverage),
    attachPoints: this.parseList(Parser.pointer(Parser.uShortList))
  };
};
var caretValue = function() {
  var format = this.parseUShort();
  check.argument(
    format === 1 || format === 2 || format === 3,
    "Unsupported CaretValue table version."
  );
  if (format === 1) {
    return { coordinate: this.parseShort() };
  } else if (format === 2) {
    return { pointindex: this.parseShort() };
  } else if (format === 3) {
    return { coordinate: this.parseShort() };
  }
};
var ligGlyph = function() {
  return this.parseList(Parser.pointer(caretValue));
};
var ligCaretList = function() {
  return {
    coverage: this.parsePointer(Parser.coverage),
    ligGlyphs: this.parseList(Parser.pointer(ligGlyph))
  };
};
var markGlyphSets = function() {
  this.parseUShort();
  return this.parseList(Parser.pointer(Parser.coverage));
};
function parseGDEFTable(data, start) {
  start = start || 0;
  var p = new Parser(data, start);
  var tableVersion = p.parseVersion(1);
  check.argument(
    tableVersion === 1 || tableVersion === 1.2 || tableVersion === 1.3,
    "Unsupported GDEF table version."
  );
  var gdef2 = {
    version: tableVersion,
    classDef: p.parsePointer(Parser.classDef),
    attachList: p.parsePointer(attachList),
    ligCaretList: p.parsePointer(ligCaretList),
    markAttachClassDef: p.parsePointer(Parser.classDef)
  };
  if (tableVersion >= 1.2) {
    gdef2.markGlyphSets = p.parsePointer(markGlyphSets);
  }
  return gdef2;
}
var gdef = { parse: parseGDEFTable };
var subtableParsers = new Array(10);
subtableParsers[1] = function parseLookup1() {
  var start = this.offset + this.relativeOffset;
  var posformat = this.parseUShort();
  if (posformat === 1) {
    return {
      posFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      value: this.parseValueRecord()
    };
  } else if (posformat === 2) {
    return {
      posFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      values: this.parseValueRecordList()
    };
  }
  check.assert(
    false,
    "0x" + start.toString(16) + ": GPOS lookup type 1 format must be 1 or 2."
  );
};
subtableParsers[2] = function parseLookup2() {
  var start = this.offset + this.relativeOffset;
  var posFormat = this.parseUShort();
  check.assert(
    posFormat === 1 || posFormat === 2,
    "0x" + start.toString(16) + ": GPOS lookup type 2 format must be 1 or 2."
  );
  var coverage = this.parsePointer(Parser.coverage);
  var valueFormat1 = this.parseUShort();
  var valueFormat2 = this.parseUShort();
  if (posFormat === 1) {
    return {
      posFormat,
      coverage,
      valueFormat1,
      valueFormat2,
      pairSets: this.parseList(
        Parser.pointer(
          Parser.list(function() {
            return {
              // pairValueRecord
              secondGlyph: this.parseUShort(),
              value1: this.parseValueRecord(valueFormat1),
              value2: this.parseValueRecord(valueFormat2)
            };
          })
        )
      )
    };
  } else if (posFormat === 2) {
    var classDef1 = this.parsePointer(Parser.classDef);
    var classDef2 = this.parsePointer(Parser.classDef);
    var class1Count = this.parseUShort();
    var class2Count = this.parseUShort();
    return {
      // Class Pair Adjustment
      posFormat,
      coverage,
      valueFormat1,
      valueFormat2,
      classDef1,
      classDef2,
      class1Count,
      class2Count,
      classRecords: this.parseList(
        class1Count,
        Parser.list(class2Count, function() {
          return {
            value1: this.parseValueRecord(valueFormat1),
            value2: this.parseValueRecord(valueFormat2)
          };
        })
      )
    };
  }
};
subtableParsers[3] = function parseLookup3() {
  return { error: "GPOS Lookup 3 not supported" };
};
subtableParsers[4] = function parseLookup4() {
  return { error: "GPOS Lookup 4 not supported" };
};
subtableParsers[5] = function parseLookup5() {
  return { error: "GPOS Lookup 5 not supported" };
};
subtableParsers[6] = function parseLookup6() {
  return { error: "GPOS Lookup 6 not supported" };
};
subtableParsers[7] = function parseLookup7() {
  return { error: "GPOS Lookup 7 not supported" };
};
subtableParsers[8] = function parseLookup8() {
  return { error: "GPOS Lookup 8 not supported" };
};
subtableParsers[9] = function parseLookup9() {
  return { error: "GPOS Lookup 9 not supported" };
};
function parseGposTable(data, start) {
  start = start || 0;
  var p = new Parser(data, start);
  var tableVersion = p.parseVersion(1);
  check.argument(
    tableVersion === 1 || tableVersion === 1.1,
    "Unsupported GPOS table version " + tableVersion
  );
  if (tableVersion === 1) {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(subtableParsers)
    };
  } else {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(subtableParsers),
      variations: p.parseFeatureVariationsList()
    };
  }
}
var gpos = { parse: parseGposTable };
var subtableParsers$1 = new Array(9);
subtableParsers$1[1] = function parseLookup12() {
  var start = this.offset + this.relativeOffset;
  var substFormat = this.parseUShort();
  if (substFormat === 1) {
    return {
      substFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      deltaGlyphId: this.parseUShort()
    };
  } else if (substFormat === 2) {
    return {
      substFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      substitute: this.parseOffset16List()
    };
  }
  check.assert(
    false,
    "0x" + start.toString(16) + ": lookup type 1 format must be 1 or 2."
  );
};
subtableParsers$1[2] = function parseLookup22() {
  var substFormat = this.parseUShort();
  check.argument(
    substFormat === 1,
    "GSUB Multiple Substitution Subtable identifier-format must be 1"
  );
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    sequences: this.parseListOfLists()
  };
};
subtableParsers$1[3] = function parseLookup32() {
  var substFormat = this.parseUShort();
  check.argument(
    substFormat === 1,
    "GSUB Alternate Substitution Subtable identifier-format must be 1"
  );
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    alternateSets: this.parseListOfLists()
  };
};
subtableParsers$1[4] = function parseLookup42() {
  var substFormat = this.parseUShort();
  check.argument(
    substFormat === 1,
    "GSUB ligature table identifier-format must be 1"
  );
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    ligatureSets: this.parseListOfLists(function() {
      return {
        ligGlyph: this.parseUShort(),
        components: this.parseUShortList(this.parseUShort() - 1)
      };
    })
  };
};
var lookupRecordDesc = {
  sequenceIndex: Parser.uShort,
  lookupListIndex: Parser.uShort
};
subtableParsers$1[5] = function parseLookup52() {
  var start = this.offset + this.relativeOffset;
  var substFormat = this.parseUShort();
  if (substFormat === 1) {
    return {
      substFormat,
      coverage: this.parsePointer(Parser.coverage),
      ruleSets: this.parseListOfLists(function() {
        var glyphCount2 = this.parseUShort();
        var substCount2 = this.parseUShort();
        return {
          input: this.parseUShortList(glyphCount2 - 1),
          lookupRecords: this.parseRecordList(
            substCount2,
            lookupRecordDesc
          )
        };
      })
    };
  } else if (substFormat === 2) {
    return {
      substFormat,
      coverage: this.parsePointer(Parser.coverage),
      classDef: this.parsePointer(Parser.classDef),
      classSets: this.parseListOfLists(function() {
        var glyphCount2 = this.parseUShort();
        var substCount2 = this.parseUShort();
        return {
          classes: this.parseUShortList(glyphCount2 - 1),
          lookupRecords: this.parseRecordList(
            substCount2,
            lookupRecordDesc
          )
        };
      })
    };
  } else if (substFormat === 3) {
    var glyphCount = this.parseUShort();
    var substCount = this.parseUShort();
    return {
      substFormat,
      coverages: this.parseList(
        glyphCount,
        Parser.pointer(Parser.coverage)
      ),
      lookupRecords: this.parseRecordList(substCount, lookupRecordDesc)
    };
  }
  check.assert(
    false,
    "0x" + start.toString(16) + ": lookup type 5 format must be 1, 2 or 3."
  );
};
subtableParsers$1[6] = function parseLookup62() {
  var start = this.offset + this.relativeOffset;
  var substFormat = this.parseUShort();
  if (substFormat === 1) {
    return {
      substFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      chainRuleSets: this.parseListOfLists(function() {
        return {
          backtrack: this.parseUShortList(),
          input: this.parseUShortList(this.parseShort() - 1),
          lookahead: this.parseUShortList(),
          lookupRecords: this.parseRecordList(lookupRecordDesc)
        };
      })
    };
  } else if (substFormat === 2) {
    return {
      substFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      backtrackClassDef: this.parsePointer(Parser.classDef),
      inputClassDef: this.parsePointer(Parser.classDef),
      lookaheadClassDef: this.parsePointer(Parser.classDef),
      chainClassSet: this.parseListOfLists(function() {
        return {
          backtrack: this.parseUShortList(),
          input: this.parseUShortList(this.parseShort() - 1),
          lookahead: this.parseUShortList(),
          lookupRecords: this.parseRecordList(lookupRecordDesc)
        };
      })
    };
  } else if (substFormat === 3) {
    return {
      substFormat: 3,
      backtrackCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      inputCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      lookaheadCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      lookupRecords: this.parseRecordList(lookupRecordDesc)
    };
  }
  check.assert(
    false,
    "0x" + start.toString(16) + ": lookup type 6 format must be 1, 2 or 3."
  );
};
subtableParsers$1[7] = function parseLookup72() {
  var substFormat = this.parseUShort();
  check.argument(
    substFormat === 1,
    "GSUB Extension Substitution subtable identifier-format must be 1"
  );
  var extensionLookupType = this.parseUShort();
  var extensionParser = new Parser(
    this.data,
    this.offset + this.parseULong()
  );
  return {
    substFormat: 1,
    lookupType: extensionLookupType,
    extension: subtableParsers$1[extensionLookupType].call(extensionParser)
  };
};
subtableParsers$1[8] = function parseLookup82() {
  var substFormat = this.parseUShort();
  check.argument(
    substFormat === 1,
    "GSUB Reverse Chaining Contextual Single Substitution Subtable identifier-format must be 1"
  );
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    backtrackCoverage: this.parseList(Parser.pointer(Parser.coverage)),
    lookaheadCoverage: this.parseList(Parser.pointer(Parser.coverage)),
    substitutes: this.parseUShortList()
  };
};
function parseGsubTable(data, start) {
  start = start || 0;
  var p = new Parser(data, start);
  var tableVersion = p.parseVersion(1);
  check.argument(
    tableVersion === 1 || tableVersion === 1.1,
    "Unsupported GSUB table version."
  );
  if (tableVersion === 1) {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(subtableParsers$1)
    };
  } else {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(subtableParsers$1),
      variations: p.parseFeatureVariationsList()
    };
  }
}
var gsub = { parse: parseGsubTable };
function parseHeadTable(data, start) {
  var head2 = {};
  var p = new parse.Parser(data, start);
  head2.version = p.parseVersion();
  head2.fontRevision = Math.round(p.parseFixed() * 1e3) / 1e3;
  head2.checkSumAdjustment = p.parseULong();
  head2.magicNumber = p.parseULong();
  check.argument(
    head2.magicNumber === 1594834165,
    "Font header has wrong magic number."
  );
  head2.flags = p.parseUShort();
  head2.unitsPerEm = p.parseUShort();
  head2.created = p.parseLongDateTime();
  head2.modified = p.parseLongDateTime();
  head2.xMin = p.parseShort();
  head2.yMin = p.parseShort();
  head2.xMax = p.parseShort();
  head2.yMax = p.parseShort();
  head2.macStyle = p.parseUShort();
  head2.lowestRecPPEM = p.parseUShort();
  head2.fontDirectionHint = p.parseShort();
  head2.indexToLocFormat = p.parseShort();
  head2.glyphDataFormat = p.parseShort();
  return head2;
}
var head = { parse: parseHeadTable };
function parseHheaTable(data, start) {
  var hhea2 = {};
  var p = new parse.Parser(data, start);
  hhea2.version = p.parseVersion();
  hhea2.ascender = p.parseShort();
  hhea2.descender = p.parseShort();
  hhea2.lineGap = p.parseShort();
  hhea2.advanceWidthMax = p.parseUShort();
  hhea2.minLeftSideBearing = p.parseShort();
  hhea2.minRightSideBearing = p.parseShort();
  hhea2.xMaxExtent = p.parseShort();
  hhea2.caretSlopeRise = p.parseShort();
  hhea2.caretSlopeRun = p.parseShort();
  hhea2.caretOffset = p.parseShort();
  p.relativeOffset += 8;
  hhea2.metricDataFormat = p.parseShort();
  hhea2.numberOfHMetrics = p.parseUShort();
  return hhea2;
}
var hhea = { parse: parseHheaTable };
function parseHmtxTableAll(data, start, numMetrics, numGlyphs, glyphs) {
  var advanceWidth;
  var leftSideBearing;
  var p = new parse.Parser(data, start);
  for (var i = 0; i < numGlyphs; i += 1) {
    if (i < numMetrics) {
      advanceWidth = p.parseUShort();
      leftSideBearing = p.parseShort();
    }
    var glyph = glyphs.get(i);
    glyph.advanceWidth = advanceWidth;
    glyph.leftSideBearing = leftSideBearing;
  }
}
function parseHmtxTableOnLowMemory(font, data, start, numMetrics, numGlyphs) {
  font._hmtxTableData = {};
  var advanceWidth;
  var leftSideBearing;
  var p = new parse.Parser(data, start);
  for (var i = 0; i < numGlyphs; i += 1) {
    if (i < numMetrics) {
      advanceWidth = p.parseUShort();
      leftSideBearing = p.parseShort();
    }
    font._hmtxTableData[i] = {
      advanceWidth,
      leftSideBearing
    };
  }
}
function parseHmtxTable(font, data, start, numMetrics, numGlyphs, glyphs, opt) {
  if (opt.lowMemory) {
    parseHmtxTableOnLowMemory(font, data, start, numMetrics, numGlyphs);
  } else {
    parseHmtxTableAll(data, start, numMetrics, numGlyphs, glyphs);
  }
}
var hmtx = { parse: parseHmtxTable };
function parseWindowsKernTable(p) {
  var pairs = {};
  p.skip("uShort");
  var subtableVersion = p.parseUShort();
  check.argument(subtableVersion === 0, "Unsupported kern sub-table version.");
  p.skip("uShort", 2);
  var nPairs = p.parseUShort();
  p.skip("uShort", 3);
  for (var i = 0; i < nPairs; i += 1) {
    var leftIndex = p.parseUShort();
    var rightIndex = p.parseUShort();
    var value = p.parseShort();
    pairs[leftIndex + "," + rightIndex] = value;
  }
  return pairs;
}
function parseMacKernTable(p) {
  var pairs = {};
  p.skip("uShort");
  var nTables = p.parseULong();
  if (nTables > 1) {
    console.warn("Only the first kern subtable is supported.");
  }
  p.skip("uLong");
  var coverage = p.parseUShort();
  var subtableVersion = coverage & 255;
  p.skip("uShort");
  if (subtableVersion === 0) {
    var nPairs = p.parseUShort();
    p.skip("uShort", 3);
    for (var i = 0; i < nPairs; i += 1) {
      var leftIndex = p.parseUShort();
      var rightIndex = p.parseUShort();
      var value = p.parseShort();
      pairs[leftIndex + "," + rightIndex] = value;
    }
  }
  return pairs;
}
function parseKernTable(data, start) {
  var p = new parse.Parser(data, start);
  var tableVersion = p.parseUShort();
  if (tableVersion === 0) {
    return parseWindowsKernTable(p);
  } else if (tableVersion === 1) {
    return parseMacKernTable(p);
  } else {
    throw new Error("Unsupported kern table version (" + tableVersion + ").");
  }
}
var kern = { parse: parseKernTable };
function parseLtagTable(data, start) {
  var p = new parse.Parser(data, start);
  var tableVersion = p.parseULong();
  check.argument(tableVersion === 1, "Unsupported ltag table version.");
  p.skip("uLong", 1);
  var numTags = p.parseULong();
  var tags = [];
  for (var i = 0; i < numTags; i++) {
    var tag = "";
    var offset = start + p.parseUShort();
    var length = p.parseUShort();
    for (var j = offset; j < offset + length; ++j) {
      tag += String.fromCharCode(data.getInt8(j));
    }
    tags.push(tag);
  }
  return tags;
}
var ltag = { parse: parseLtagTable };
function parseLocaTable(data, start, numGlyphs, shortVersion) {
  var p = new parse.Parser(data, start);
  var parseFn = shortVersion ? p.parseUShort : p.parseULong;
  var glyphOffsets = [];
  for (var i = 0; i < numGlyphs + 1; i += 1) {
    var glyphOffset = parseFn.call(p);
    if (shortVersion) {
      glyphOffset *= 2;
    }
    glyphOffsets.push(glyphOffset);
  }
  return glyphOffsets;
}
var loca = { parse: parseLocaTable };
function parseMaxpTable(data, start) {
  var maxp2 = {};
  var p = new parse.Parser(data, start);
  maxp2.version = p.parseVersion();
  maxp2.numGlyphs = p.parseUShort();
  if (maxp2.version === 1) {
    maxp2.maxPoints = p.parseUShort();
    maxp2.maxContours = p.parseUShort();
    maxp2.maxCompositePoints = p.parseUShort();
    maxp2.maxCompositeContours = p.parseUShort();
    maxp2.maxZones = p.parseUShort();
    maxp2.maxTwilightPoints = p.parseUShort();
    maxp2.maxStorage = p.parseUShort();
    maxp2.maxFunctionDefs = p.parseUShort();
    maxp2.maxInstructionDefs = p.parseUShort();
    maxp2.maxStackElements = p.parseUShort();
    maxp2.maxSizeOfInstructions = p.parseUShort();
    maxp2.maxComponentElements = p.parseUShort();
    maxp2.maxComponentDepth = p.parseUShort();
  }
  return maxp2;
}
var maxp = { parse: parseMaxpTable };
function parseOS2Table(data, start) {
  var os22 = {};
  var p = new parse.Parser(data, start);
  os22.version = p.parseUShort();
  os22.xAvgCharWidth = p.parseShort();
  os22.usWeightClass = p.parseUShort();
  os22.usWidthClass = p.parseUShort();
  os22.fsType = p.parseUShort();
  os22.ySubscriptXSize = p.parseShort();
  os22.ySubscriptYSize = p.parseShort();
  os22.ySubscriptXOffset = p.parseShort();
  os22.ySubscriptYOffset = p.parseShort();
  os22.ySuperscriptXSize = p.parseShort();
  os22.ySuperscriptYSize = p.parseShort();
  os22.ySuperscriptXOffset = p.parseShort();
  os22.ySuperscriptYOffset = p.parseShort();
  os22.yStrikeoutSize = p.parseShort();
  os22.yStrikeoutPosition = p.parseShort();
  os22.sFamilyClass = p.parseShort();
  os22.panose = [];
  for (var i = 0; i < 10; i++) {
    os22.panose[i] = p.parseByte();
  }
  os22.ulUnicodeRange1 = p.parseULong();
  os22.ulUnicodeRange2 = p.parseULong();
  os22.ulUnicodeRange3 = p.parseULong();
  os22.ulUnicodeRange4 = p.parseULong();
  os22.achVendID = String.fromCharCode(
    p.parseByte(),
    p.parseByte(),
    p.parseByte(),
    p.parseByte()
  );
  os22.fsSelection = p.parseUShort();
  os22.usFirstCharIndex = p.parseUShort();
  os22.usLastCharIndex = p.parseUShort();
  os22.sTypoAscender = p.parseShort();
  os22.sTypoDescender = p.parseShort();
  os22.sTypoLineGap = p.parseShort();
  os22.usWinAscent = p.parseUShort();
  os22.usWinDescent = p.parseUShort();
  if (os22.version >= 1) {
    os22.ulCodePageRange1 = p.parseULong();
    os22.ulCodePageRange2 = p.parseULong();
  }
  if (os22.version >= 2) {
    os22.sxHeight = p.parseShort();
    os22.sCapHeight = p.parseShort();
    os22.usDefaultChar = p.parseUShort();
    os22.usBreakChar = p.parseUShort();
    os22.usMaxContent = p.parseUShort();
  }
  return os22;
}
var os2 = { parse: parseOS2Table };
function parsePostTable(data, start) {
  var post2 = {};
  var p = new parse.Parser(data, start);
  post2.version = p.parseVersion();
  post2.italicAngle = p.parseFixed();
  post2.underlinePosition = p.parseShort();
  post2.underlineThickness = p.parseShort();
  post2.isFixedPitch = p.parseULong();
  post2.minMemType42 = p.parseULong();
  post2.maxMemType42 = p.parseULong();
  post2.minMemType1 = p.parseULong();
  post2.maxMemType1 = p.parseULong();
  post2.names = [];
  switch (post2.version) {
    case 1:
      break;
    case 2:
      post2.numberOfGlyphs = p.parseUShort();
      post2.glyphNameIndex = new Array(post2.numberOfGlyphs);
      for (var i = 0; i < post2.numberOfGlyphs; i++) {
        post2.glyphNameIndex[i] = p.parseUShort();
      }
      break;
    case 2.5:
      post2.numberOfGlyphs = p.parseUShort();
      post2.offset = new Array(post2.numberOfGlyphs);
      for (var i$1 = 0; i$1 < post2.numberOfGlyphs; i$1++) {
        post2.offset[i$1] = p.parseChar();
      }
      break;
  }
  return post2;
}
var post = { parse: parsePostTable };
var decode = {};
decode.UTF8 = function(data, offset, numBytes) {
  var codePoints = [];
  var numChars = numBytes;
  for (var j = 0; j < numChars; j++, offset += 1) {
    codePoints[j] = data.getUint8(offset);
  }
  return String.fromCharCode.apply(null, codePoints);
};
decode.UTF16 = function(data, offset, numBytes) {
  var codePoints = [];
  var numChars = numBytes / 2;
  for (var j = 0; j < numChars; j++, offset += 2) {
    codePoints[j] = data.getUint16(offset);
  }
  return String.fromCharCode.apply(null, codePoints);
};
var eightBitMacEncodings = {
  "x-mac-croatian": (
    // Python: 'mac_croatian'
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\u2020\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\u0160\u2122\xB4\xA8\u2260\u017D\xD8\u221E\xB1\u2264\u2265\u2206\xB5\u2202\u2211\u220F\u0161\u222B\xAA\xBA\u03A9\u017E\xF8\xBF\xA1\xAC\u221A\u0192\u2248\u0106\xAB\u010C\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u0110\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\uF8FF\xA9\u2044\u20AC\u2039\u203A\xC6\xBB\u2013\xB7\u201A\u201E\u2030\xC2\u0107\xC1\u010D\xC8\xCD\xCE\xCF\xCC\xD3\xD4\u0111\xD2\xDA\xDB\xD9\u0131\u02C6\u02DC\xAF\u03C0\xCB\u02DA\xB8\xCA\xE6\u02C7"
  ),
  "x-mac-cyrillic": (
    // Python: 'mac_cyrillic'
    "\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041A\u041B\u041C\u041D\u041E\u041F\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042A\u042B\u042C\u042D\u042E\u042F\u2020\xB0\u0490\xA3\xA7\u2022\xB6\u0406\xAE\xA9\u2122\u0402\u0452\u2260\u0403\u0453\u221E\xB1\u2264\u2265\u0456\xB5\u0491\u0408\u0404\u0454\u0407\u0457\u0409\u0459\u040A\u045A\u0458\u0405\xAC\u221A\u0192\u2248\u2206\xAB\xBB\u2026\xA0\u040B\u045B\u040C\u045C\u0455\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u201E\u040E\u045E\u040F\u045F\u2116\u0401\u0451\u044F\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043A\u043B\u043C\u043D\u043E\u043F\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044A\u044B\u044C\u044D\u044E"
  ),
  "x-mac-gaelic": (
    // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/GAELIC.TXT
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\u2020\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\xB4\xA8\u2260\xC6\xD8\u1E02\xB1\u2264\u2265\u1E03\u010A\u010B\u1E0A\u1E0B\u1E1E\u1E1F\u0120\u0121\u1E40\xE6\xF8\u1E41\u1E56\u1E57\u027C\u0192\u017F\u1E60\xAB\xBB\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u2013\u2014\u201C\u201D\u2018\u2019\u1E61\u1E9B\xFF\u0178\u1E6A\u20AC\u2039\u203A\u0176\u0177\u1E6B\xB7\u1EF2\u1EF3\u204A\xC2\xCA\xC1\xCB\xC8\xCD\xCE\xCF\xCC\xD3\xD4\u2663\xD2\xDA\xDB\xD9\u0131\xDD\xFD\u0174\u0175\u1E84\u1E85\u1E80\u1E81\u1E82\u1E83"
  ),
  "x-mac-greek": (
    // Python: 'mac_greek'
    "\xC4\xB9\xB2\xC9\xB3\xD6\xDC\u0385\xE0\xE2\xE4\u0384\xA8\xE7\xE9\xE8\xEA\xEB\xA3\u2122\xEE\xEF\u2022\xBD\u2030\xF4\xF6\xA6\u20AC\xF9\xFB\xFC\u2020\u0393\u0394\u0398\u039B\u039E\u03A0\xDF\xAE\xA9\u03A3\u03AA\xA7\u2260\xB0\xB7\u0391\xB1\u2264\u2265\xA5\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u03A6\u03AB\u03A8\u03A9\u03AC\u039D\xAC\u039F\u03A1\u2248\u03A4\xAB\xBB\u2026\xA0\u03A5\u03A7\u0386\u0388\u0153\u2013\u2015\u201C\u201D\u2018\u2019\xF7\u0389\u038A\u038C\u038E\u03AD\u03AE\u03AF\u03CC\u038F\u03CD\u03B1\u03B2\u03C8\u03B4\u03B5\u03C6\u03B3\u03B7\u03B9\u03BE\u03BA\u03BB\u03BC\u03BD\u03BF\u03C0\u03CE\u03C1\u03C3\u03C4\u03B8\u03C9\u03C2\u03C7\u03C5\u03B6\u03CA\u03CB\u0390\u03B0\xAD"
  ),
  "x-mac-icelandic": (
    // Python: 'mac_iceland'
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\xDD\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\xB4\xA8\u2260\xC6\xD8\u221E\xB1\u2264\u2265\xA5\xB5\u2202\u2211\u220F\u03C0\u222B\xAA\xBA\u03A9\xE6\xF8\xBF\xA1\xAC\u221A\u0192\u2248\u2206\xAB\xBB\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\xFF\u0178\u2044\u20AC\xD0\xF0\xDE\xFE\xFD\xB7\u201A\u201E\u2030\xC2\xCA\xC1\xCB\xC8\xCD\xCE\xCF\xCC\xD3\xD4\uF8FF\xD2\xDA\xDB\xD9\u0131\u02C6\u02DC\xAF\u02D8\u02D9\u02DA\xB8\u02DD\u02DB\u02C7"
  ),
  "x-mac-inuit": (
    // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/INUIT.TXT
    "\u1403\u1404\u1405\u1406\u140A\u140B\u1431\u1432\u1433\u1434\u1438\u1439\u1449\u144E\u144F\u1450\u1451\u1455\u1456\u1466\u146D\u146E\u146F\u1470\u1472\u1473\u1483\u148B\u148C\u148D\u148E\u1490\u1491\xB0\u14A1\u14A5\u14A6\u2022\xB6\u14A7\xAE\xA9\u2122\u14A8\u14AA\u14AB\u14BB\u14C2\u14C3\u14C4\u14C5\u14C7\u14C8\u14D0\u14EF\u14F0\u14F1\u14F2\u14F4\u14F5\u1505\u14D5\u14D6\u14D7\u14D8\u14DA\u14DB\u14EA\u1528\u1529\u152A\u152B\u152D\u2026\xA0\u152E\u153E\u1555\u1556\u1557\u2013\u2014\u201C\u201D\u2018\u2019\u1558\u1559\u155A\u155D\u1546\u1547\u1548\u1549\u154B\u154C\u1550\u157F\u1580\u1581\u1582\u1583\u1584\u1585\u158F\u1590\u1591\u1592\u1593\u1594\u1595\u1671\u1672\u1673\u1674\u1675\u1676\u1596\u15A0\u15A1\u15A2\u15A3\u15A4\u15A5\u15A6\u157C\u0141\u0142"
  ),
  "x-mac-ce": (
    // Python: 'mac_latin2'
    "\xC4\u0100\u0101\xC9\u0104\xD6\xDC\xE1\u0105\u010C\xE4\u010D\u0106\u0107\xE9\u0179\u017A\u010E\xED\u010F\u0112\u0113\u0116\xF3\u0117\xF4\xF6\xF5\xFA\u011A\u011B\xFC\u2020\xB0\u0118\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\u0119\xA8\u2260\u0123\u012E\u012F\u012A\u2264\u2265\u012B\u0136\u2202\u2211\u0142\u013B\u013C\u013D\u013E\u0139\u013A\u0145\u0146\u0143\xAC\u221A\u0144\u0147\u2206\xAB\xBB\u2026\xA0\u0148\u0150\xD5\u0151\u014C\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\u014D\u0154\u0155\u0158\u2039\u203A\u0159\u0156\u0157\u0160\u201A\u201E\u0161\u015A\u015B\xC1\u0164\u0165\xCD\u017D\u017E\u016A\xD3\xD4\u016B\u016E\xDA\u016F\u0170\u0171\u0172\u0173\xDD\xFD\u0137\u017B\u0141\u017C\u0122\u02C7"
  ),
  macintosh: (
    // Python: 'mac_roman'
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\u2020\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\xB4\xA8\u2260\xC6\xD8\u221E\xB1\u2264\u2265\xA5\xB5\u2202\u2211\u220F\u03C0\u222B\xAA\xBA\u03A9\xE6\xF8\xBF\xA1\xAC\u221A\u0192\u2248\u2206\xAB\xBB\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\xFF\u0178\u2044\u20AC\u2039\u203A\uFB01\uFB02\u2021\xB7\u201A\u201E\u2030\xC2\xCA\xC1\xCB\xC8\xCD\xCE\xCF\xCC\xD3\xD4\uF8FF\xD2\xDA\xDB\xD9\u0131\u02C6\u02DC\xAF\u02D8\u02D9\u02DA\xB8\u02DD\u02DB\u02C7"
  ),
  "x-mac-romanian": (
    // Python: 'mac_romanian'
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\u2020\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\xB4\xA8\u2260\u0102\u0218\u221E\xB1\u2264\u2265\xA5\xB5\u2202\u2211\u220F\u03C0\u222B\xAA\xBA\u03A9\u0103\u0219\xBF\xA1\xAC\u221A\u0192\u2248\u2206\xAB\xBB\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\xFF\u0178\u2044\u20AC\u2039\u203A\u021A\u021B\u2021\xB7\u201A\u201E\u2030\xC2\xCA\xC1\xCB\xC8\xCD\xCE\xCF\xCC\xD3\xD4\uF8FF\xD2\xDA\xDB\xD9\u0131\u02C6\u02DC\xAF\u02D8\u02D9\u02DA\xB8\u02DD\u02DB\u02C7"
  ),
  "x-mac-turkish": (
    // Python: 'mac_turkish'
    "\xC4\xC5\xC7\xC9\xD1\xD6\xDC\xE1\xE0\xE2\xE4\xE3\xE5\xE7\xE9\xE8\xEA\xEB\xED\xEC\xEE\xEF\xF1\xF3\xF2\xF4\xF6\xF5\xFA\xF9\xFB\xFC\u2020\xB0\xA2\xA3\xA7\u2022\xB6\xDF\xAE\xA9\u2122\xB4\xA8\u2260\xC6\xD8\u221E\xB1\u2264\u2265\xA5\xB5\u2202\u2211\u220F\u03C0\u222B\xAA\xBA\u03A9\xE6\xF8\xBF\xA1\xAC\u221A\u0192\u2248\u2206\xAB\xBB\u2026\xA0\xC0\xC3\xD5\u0152\u0153\u2013\u2014\u201C\u201D\u2018\u2019\xF7\u25CA\xFF\u0178\u011E\u011F\u0130\u0131\u015E\u015F\u2021\xB7\u201A\u201E\u2030\xC2\xCA\xC1\xCB\xC8\xCD\xCE\xCF\xCC\xD3\xD4\uF8FF\xD2\xDA\xDB\xD9\uF8A0\u02C6\u02DC\xAF\u02D8\u02D9\u02DA\xB8\u02DD\u02DB\u02C7"
  )
};
decode.MACSTRING = function(dataView, offset, dataLength, encoding) {
  var table = eightBitMacEncodings[encoding];
  if (table === void 0) {
    return void 0;
  }
  var result = "";
  for (var i = 0; i < dataLength; i++) {
    var c2 = dataView.getUint8(offset + i);
    if (c2 <= 127) {
      result += String.fromCharCode(c2);
    } else {
      result += table[c2 & 127];
    }
  }
  return result;
};
function parseMetaTable(data, start) {
  var p = new parse.Parser(data, start);
  var tableVersion = p.parseULong();
  check.argument(tableVersion === 1, "Unsupported META table version.");
  p.parseULong();
  p.parseULong();
  var numDataMaps = p.parseULong();
  var tags = {};
  for (var i = 0; i < numDataMaps; i++) {
    var tag = p.parseTag();
    var dataOffset = p.parseULong();
    var dataLength = p.parseULong();
    var text = decode.UTF8(data, start + dataOffset, dataLength);
    tags[tag] = text;
  }
  return tags;
}
var meta = { parse: parseMetaTable };
function parseOpenTypeTableEntries(data, numTables) {
  var tableEntries = [];
  var p = 12;
  for (var i = 0; i < numTables; i += 1) {
    var tag = parse.getTag(data, p);
    var checksum = parse.getULong(data, p + 4);
    var offset = parse.getULong(data, p + 8);
    var length = parse.getULong(data, p + 12);
    tableEntries.push({
      tag,
      checksum,
      offset,
      length,
      compression: false
    });
    p += 16;
  }
  return tableEntries;
}
function parseWOFFTableEntries(data, numTables) {
  var tableEntries = [];
  var p = 44;
  for (var i = 0; i < numTables; i += 1) {
    var tag = parse.getTag(data, p);
    var offset = parse.getULong(data, p + 4);
    var compLength = parse.getULong(data, p + 8);
    var origLength = parse.getULong(data, p + 12);
    var compression = void 0;
    if (compLength < origLength) {
      compression = "WOFF";
    } else {
      compression = false;
    }
    tableEntries.push({
      tag,
      offset,
      compression,
      compressedLength: compLength,
      length: origLength
    });
    p += 20;
  }
  return tableEntries;
}
function uncompressTable(data, tableEntry) {
  if (tableEntry.compression === "WOFF") {
    var inBuffer = new Uint8Array(
      data.buffer,
      tableEntry.offset + 2,
      tableEntry.compressedLength - 2
    );
    var outBuffer = new Uint8Array(tableEntry.length);
    inflateSync(inBuffer, outBuffer);
    if (outBuffer.byteLength !== tableEntry.length) {
      throw new Error(
        "Decompression error: " + tableEntry.tag + " decompressed length doesn't match recorded length"
      );
    }
    var view = new DataView(outBuffer.buffer, 0);
    return { data: view, offset: 0 };
  } else {
    return { data, offset: tableEntry.offset };
  }
}
function parseBuffer(buffer, opt) {
  opt = opt === void 0 || opt === null ? {} : opt;
  var indexToLocFormat;
  var font = new Font({ empty: true });
  var data = new DataView(buffer, 0);
  var numTables;
  var tableEntries = [];
  var signature = parse.getTag(data, 0);
  if (signature === String.fromCharCode(0, 1, 0, 0) || signature === "true" || signature === "typ1") {
    font.outlinesFormat = "truetype";
    numTables = parse.getUShort(data, 4);
    tableEntries = parseOpenTypeTableEntries(data, numTables);
  } else if (signature === "OTTO") {
    font.outlinesFormat = "cff";
    numTables = parse.getUShort(data, 4);
    tableEntries = parseOpenTypeTableEntries(data, numTables);
  } else if (signature === "wOFF") {
    var flavor = parse.getTag(data, 4);
    if (flavor === String.fromCharCode(0, 1, 0, 0)) {
      font.outlinesFormat = "truetype";
    } else if (flavor === "OTTO") {
      font.outlinesFormat = "cff";
    } else {
      throw new Error("Unsupported OpenType flavor " + signature);
    }
    numTables = parse.getUShort(data, 12);
    tableEntries = parseWOFFTableEntries(data, numTables);
  } else {
    throw new Error("Unsupported OpenType signature " + signature);
  }
  var cffTableEntry;
  var fvarTableEntry;
  var glyfTableEntry;
  var gdefTableEntry;
  var gposTableEntry;
  var gsubTableEntry;
  var hmtxTableEntry;
  var kernTableEntry;
  var locaTableEntry;
  var metaTableEntry;
  var p;
  for (var i = 0; i < numTables; i += 1) {
    var tableEntry = tableEntries[i];
    var table = void 0;
    switch (tableEntry.tag) {
      case "cmap":
        table = uncompressTable(data, tableEntry);
        font.tables.cmap = cmap.parse(table.data, table.offset);
        font.encoding = new CmapEncoding(font.tables.cmap);
        break;
      case "cvt ":
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.cvt = p.parseShortList(tableEntry.length / 2);
        break;
      case "fvar":
        fvarTableEntry = tableEntry;
        break;
      case "fpgm":
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.fpgm = p.parseByteList(tableEntry.length);
        break;
      case "head":
        table = uncompressTable(data, tableEntry);
        font.tables.head = head.parse(table.data, table.offset);
        font.unitsPerEm = font.tables.head.unitsPerEm;
        indexToLocFormat = font.tables.head.indexToLocFormat;
        break;
      case "hhea":
        table = uncompressTable(data, tableEntry);
        font.tables.hhea = hhea.parse(table.data, table.offset);
        font.ascender = font.tables.hhea.ascender;
        font.descender = font.tables.hhea.descender;
        font.numberOfHMetrics = font.tables.hhea.numberOfHMetrics;
        break;
      case "hmtx":
        hmtxTableEntry = tableEntry;
        break;
      case "ltag":
        table = uncompressTable(data, tableEntry);
        ltagTable = ltag.parse(table.data, table.offset);
        break;
      case "maxp":
        table = uncompressTable(data, tableEntry);
        font.tables.maxp = maxp.parse(table.data, table.offset);
        font.numGlyphs = font.tables.maxp.numGlyphs;
        break;
      case "OS/2":
        table = uncompressTable(data, tableEntry);
        font.tables.os2 = os2.parse(table.data, table.offset);
        break;
      case "post":
        table = uncompressTable(data, tableEntry);
        font.tables.post = post.parse(table.data, table.offset);
        break;
      case "prep":
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.prep = p.parseByteList(tableEntry.length);
        break;
      case "glyf":
        glyfTableEntry = tableEntry;
        break;
      case "loca":
        locaTableEntry = tableEntry;
        break;
      case "CFF ":
        cffTableEntry = tableEntry;
        break;
      case "kern":
        kernTableEntry = tableEntry;
        break;
      case "GDEF":
        gdefTableEntry = tableEntry;
        break;
      case "GPOS":
        gposTableEntry = tableEntry;
        break;
      case "GSUB":
        gsubTableEntry = tableEntry;
        break;
      case "meta":
        metaTableEntry = tableEntry;
        break;
    }
  }
  if (glyfTableEntry && locaTableEntry) {
    var shortVersion = indexToLocFormat === 0;
    var locaTable = uncompressTable(data, locaTableEntry);
    var locaOffsets = loca.parse(
      locaTable.data,
      locaTable.offset,
      font.numGlyphs,
      shortVersion
    );
    var glyfTable = uncompressTable(data, glyfTableEntry);
    font.glyphs = glyf.parse(
      glyfTable.data,
      glyfTable.offset,
      locaOffsets,
      font,
      opt
    );
  } else if (cffTableEntry) {
    var cffTable = uncompressTable(data, cffTableEntry);
    cff.parse(cffTable.data, cffTable.offset, font, opt);
  } else {
    throw new Error("Font doesn't contain TrueType or CFF outlines.");
  }
  var hmtxTable = uncompressTable(data, hmtxTableEntry);
  hmtx.parse(
    font,
    hmtxTable.data,
    hmtxTable.offset,
    font.numberOfHMetrics,
    font.numGlyphs,
    font.glyphs,
    opt
  );
  addGlyphNames(font, opt);
  if (kernTableEntry) {
    var kernTable = uncompressTable(data, kernTableEntry);
    font.kerningPairs = kern.parse(kernTable.data, kernTable.offset);
  } else {
    font.kerningPairs = {};
  }
  if (gdefTableEntry) {
    var gdefTable = uncompressTable(data, gdefTableEntry);
    font.tables.gdef = gdef.parse(gdefTable.data, gdefTable.offset);
  }
  if (gposTableEntry) {
    var gposTable = uncompressTable(data, gposTableEntry);
    font.tables.gpos = gpos.parse(gposTable.data, gposTable.offset);
    font.position.init();
  }
  if (gsubTableEntry) {
    var gsubTable = uncompressTable(data, gsubTableEntry);
    font.tables.gsub = gsub.parse(gsubTable.data, gsubTable.offset);
  }
  if (fvarTableEntry) {
    var fvarTable = uncompressTable(data, fvarTableEntry);
    font.tables.fvar = fvar.parse(
      fvarTable.data,
      fvarTable.offset,
      font.names
    );
  }
  if (metaTableEntry) {
    var metaTable = uncompressTable(data, metaTableEntry);
    font.tables.meta = meta.parse(metaTable.data, metaTable.offset);
    font.metas = font.tables.meta;
  }
  return font;
}
function load() {
}
function loadSync() {
}
var opentype = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  Font,
  Glyph,
  Path,
  _parse: parse,
  parse: parseBuffer,
  load,
  loadSync
});
var opentype_module_default = opentype;

// node_modules/.pnpm/fflate@0.7.3/node_modules/fflate/esm/index.mjs

var u82 = Uint8Array;
var u162 = Uint16Array;
var u322 = Uint32Array;
var fleb2 = new u82([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb2 = new u82([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim2 = new u82([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb2 = function(eb, start) {
  var b = new u162(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new u322(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return [b, r];
};
var _a2 = freb2(fleb2, 2);
var fl2 = _a2[0];
var revfl2 = _a2[1];
fl2[28] = 258, revfl2[258] = 28;
var _b2 = freb2(fdeb2, 0);
var fd2 = _b2[0];
var revfd = _b2[1];
var rev2 = new u162(32768);
for (i = 0; i < 32768; ++i) {
  x2 = (i & 43690) >>> 1 | (i & 21845) << 1;
  x2 = (x2 & 52428) >>> 2 | (x2 & 13107) << 2;
  x2 = (x2 & 61680) >>> 4 | (x2 & 3855) << 4;
  rev2[i] = ((x2 & 65280) >>> 8 | (x2 & 255) << 8) >>> 1;
}
var x2;
var i;
var hMap2 = function(cd2, mb, r) {
  var s = cd2.length;
  var i = 0;
  var l2 = new u162(mb);
  for (; i < s; ++i) {
    if (cd2[i])
      ++l2[cd2[i] - 1];
  }
  var le = new u162(mb);
  for (i = 0; i < mb; ++i) {
    le[i] = le[i - 1] + l2[i - 1] << 1;
  }
  var co2;
  if (r) {
    co2 = new u162(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd2[i]) {
        var sv2 = i << 4 | cd2[i];
        var r_1 = mb - cd2[i];
        var v2 = le[cd2[i] - 1]++ << r_1;
        for (var m2 = v2 | (1 << r_1) - 1; v2 <= m2; ++v2) {
          co2[rev2[v2] >>> rvb] = sv2;
        }
      }
    }
  } else {
    co2 = new u162(s);
    for (i = 0; i < s; ++i) {
      if (cd2[i]) {
        co2[i] = rev2[le[cd2[i] - 1]++] >>> 15 - cd2[i];
      }
    }
  }
  return co2;
};
var flt2 = new u82(288);
for (i = 0; i < 144; ++i)
  flt2[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt2[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt2[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt2[i] = 8;
var i;
var fdt2 = new u82(32);
for (i = 0; i < 32; ++i)
  fdt2[i] = 5;
var i;
var flrm2 = /* @__PURE__ */ hMap2(flt2, 9, 1);
var fdrm2 = /* @__PURE__ */ hMap2(fdt2, 5, 1);
var max2 = function(a) {
  var m2 = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m2)
      m2 = a[i];
  }
  return m2;
};
var bits2 = function(d2, p, m2) {
  var o = p / 8 | 0;
  return (d2[o] | d2[o + 1] << 8) >> (p & 7) & m2;
};
var bits162 = function(d2, p) {
  var o = p / 8 | 0;
  return (d2[o] | d2[o + 1] << 8 | d2[o + 2] << 16) >> (p & 7);
};
var shft2 = function(p) {
  return (p + 7) / 8 | 0;
};
var slc2 = function(v2, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v2.length)
    e = v2.length;
  var n = new (v2.BYTES_PER_ELEMENT == 2 ? u162 : v2.BYTES_PER_ELEMENT == 4 ? u322 : u82)(e - s);
  n.set(v2.subarray(s, e));
  return n;
};
var ec2 = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err2 = function(ind, msg, nt) {
  var e = new Error(msg || ec2[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err2);
  if (!nt)
    throw e;
  return e;
};
var inflt2 = function(dat, buf, st) {
  var sl2 = dat.length;
  if (!sl2 || st && st.f && !st.l)
    return buf || new u82(0);
  var noBuf = !buf || st;
  var noSt = !st || st.i;
  if (!st)
    st = {};
  if (!buf)
    buf = new u82(sl2 * 3);
  var cbuf = function(l3) {
    var bl = buf.length;
    if (l3 > bl) {
      var nbuf = new u82(Math.max(bl * 2, l3));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl2 * 8;
  do {
    if (!lm) {
      final = bits2(dat, pos, 1);
      var type = bits2(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft2(pos) + 4, l2 = dat[s - 4] | dat[s - 3] << 8, t = s + l2;
        if (t > sl2) {
          if (noSt)
            err2(0);
          break;
        }
        if (noBuf)
          cbuf(bt + l2);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l2, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm2, dm = fdrm2, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits2(dat, pos, 31) + 257, hcLen = bits2(dat, pos + 10, 15) + 4;
        var tl2 = hLit + bits2(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u82(tl2);
        var clt = new u82(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim2[i]] = bits2(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max2(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap2(clt, clb, 1);
        for (var i = 0; i < tl2; ) {
          var r = clm[bits2(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >>> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c2 = 0, n = 0;
            if (s == 16)
              n = 3 + bits2(dat, pos, 3), pos += 2, c2 = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits2(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits2(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c2;
          }
        }
        var lt = ldt.subarray(0, hLit), dt2 = ldt.subarray(hLit);
        lbt = max2(lt);
        dbt = max2(dt2);
        lm = hMap2(lt, lbt, 1);
        dm = hMap2(dt2, dbt, 1);
      } else
        err2(1);
      if (pos > tbts) {
        if (noSt)
          err2(0);
        break;
      }
    }
    if (noBuf)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c2 = lm[bits162(dat, pos) & lms], sym = c2 >>> 4;
      pos += c2 & 15;
      if (pos > tbts) {
        if (noSt)
          err2(0);
        break;
      }
      if (!c2)
        err2(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb2[i];
          add = bits2(dat, pos, (1 << b) - 1) + fl2[i];
          pos += b;
        }
        var d2 = dm[bits162(dat, pos) & dms], dsym = d2 >>> 4;
        if (!d2)
          err2(3);
        pos += d2 & 15;
        var dt2 = fd2[dsym];
        if (dsym > 3) {
          var b = fdeb2[dsym];
          dt2 += bits162(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err2(0);
          break;
        }
        if (noBuf)
          cbuf(bt + 131072);
        var end = bt + add;
        for (; bt < end; bt += 4) {
          buf[bt] = buf[bt - dt2];
          buf[bt + 1] = buf[bt + 1 - dt2];
          buf[bt + 2] = buf[bt + 2 - dt2];
          buf[bt + 3] = buf[bt + 3 - dt2];
        }
        bt = end;
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt == buf.length ? buf : slc2(buf, 0, bt);
};
var et2 = /* @__PURE__ */ new u82(0);
function inflateSync2(data, out) {
  return inflt2(data, out);
}
var td2 = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds2 = 0;
try {
  td2.decode(et2, { stream: true });
  tds2 = 1;
} catch (e) {
}

// node_modules/.pnpm/satori@0.33.5/node_modules/satori/dist/standalone.js
var import_harfbuzzjs = __toESM(require_harfbuzzjs(), 1);
var ed = Object.create;
var zn = Object.defineProperty;
var td3 = Object.getOwnPropertyDescriptor;
var rd = Object.getOwnPropertyNames;
var nd = Object.getPrototypeOf;
var id = Object.prototype.hasOwnProperty;
var ar = (e, t) => () => (e && (t = e(e = 0)), t);
var q = (e, t) => () => (t || e((t = { exports: {} }).exports, t), t.exports);
var Gn = (e, t) => {
  for (var r in t)
    zn(e, r, { get: t[r], enumerable: true });
};
var ka = (e, t, r, n) => {
  if (t && typeof t == "object" || typeof t == "function")
    for (let i of rd(t))
      !id.call(e, i) && i !== r && zn(e, i, { get: () => t[i], enumerable: !(n = td3(t, i)) || n.enumerable });
  return e;
};
var od = (e, t, r) => (r = e != null ? ed(nd(e)) : {}, ka(t || !e || !e.__esModule ? zn(r, "default", { value: e, enumerable: true }) : r, e));
var jn = (e) => ka(zn({}, "__esModule", { value: true }), e);
var Gt;
var Va;
var Ha;
var Vr;
var Vi;
var jt;
var Tr;
var Sd;
var Yn;
var Hi;
var Er;
var kr;
var Yi;
var Ya;
var Xi;
var Ki;
var St;
var Qi;
var _d;
var Xa;
var Xn = ar(() => {
  Gt = function(e) {
    return e[e.Auto = 0] = "Auto", e[e.FlexStart = 1] = "FlexStart", e[e.Center = 2] = "Center", e[e.FlexEnd = 3] = "FlexEnd", e[e.Stretch = 4] = "Stretch", e[e.Baseline = 5] = "Baseline", e[e.SpaceBetween = 6] = "SpaceBetween", e[e.SpaceAround = 7] = "SpaceAround", e[e.SpaceEvenly = 8] = "SpaceEvenly", e;
  }({}), Va = function(e) {
    return e[e.BorderBox = 0] = "BorderBox", e[e.ContentBox = 1] = "ContentBox", e;
  }({}), Ha = function(e) {
    return e[e.Width = 0] = "Width", e[e.Height = 1] = "Height", e;
  }({}), Vr = function(e) {
    return e[e.Inherit = 0] = "Inherit", e[e.LTR = 1] = "LTR", e[e.RTL = 2] = "RTL", e;
  }({}), Vi = function(e) {
    return e[e.Flex = 0] = "Flex", e[e.None = 1] = "None", e[e.Contents = 2] = "Contents", e;
  }({}), jt = function(e) {
    return e[e.Left = 0] = "Left", e[e.Top = 1] = "Top", e[e.Right = 2] = "Right", e[e.Bottom = 3] = "Bottom", e[e.Start = 4] = "Start", e[e.End = 5] = "End", e[e.Horizontal = 6] = "Horizontal", e[e.Vertical = 7] = "Vertical", e[e.All = 8] = "All", e;
  }({}), Tr = function(e) {
    return e[e.None = 0] = "None", e[e.StretchFlexBasis = 1] = "StretchFlexBasis", e[e.AbsolutePositionWithoutInsetsExcludesPadding = 2] = "AbsolutePositionWithoutInsetsExcludesPadding", e[e.AbsolutePercentAgainstInnerSize = 4] = "AbsolutePercentAgainstInnerSize", e[e.All = 2147483647] = "All", e[e.Classic = 2147483646] = "Classic", e;
  }({}), Sd = function(e) {
    return e[e.WebFlexBasis = 0] = "WebFlexBasis", e;
  }({}), Yn = function(e) {
    return e[e.Column = 0] = "Column", e[e.ColumnReverse = 1] = "ColumnReverse", e[e.Row = 2] = "Row", e[e.RowReverse = 3] = "RowReverse", e;
  }({}), Hi = function(e) {
    return e[e.Column = 0] = "Column", e[e.Row = 1] = "Row", e[e.All = 2] = "All", e;
  }({}), Er = function(e) {
    return e[e.FlexStart = 0] = "FlexStart", e[e.Center = 1] = "Center", e[e.FlexEnd = 2] = "FlexEnd", e[e.SpaceBetween = 3] = "SpaceBetween", e[e.SpaceAround = 4] = "SpaceAround", e[e.SpaceEvenly = 5] = "SpaceEvenly", e;
  }({}), kr = function(e) {
    return e[e.Error = 0] = "Error", e[e.Warn = 1] = "Warn", e[e.Info = 2] = "Info", e[e.Debug = 3] = "Debug", e[e.Verbose = 4] = "Verbose", e[e.Fatal = 5] = "Fatal", e;
  }({}), Yi = function(e) {
    return e[e.Undefined = 0] = "Undefined", e[e.Exactly = 1] = "Exactly", e[e.AtMost = 2] = "AtMost", e;
  }({}), Ya = function(e) {
    return e[e.Default = 0] = "Default", e[e.Text = 1] = "Text", e;
  }({}), Xi = function(e) {
    return e[e.Visible = 0] = "Visible", e[e.Hidden = 1] = "Hidden", e[e.Scroll = 2] = "Scroll", e;
  }({}), Ki = function(e) {
    return e[e.Static = 0] = "Static", e[e.Relative = 1] = "Relative", e[e.Absolute = 2] = "Absolute", e;
  }({}), St = function(e) {
    return e[e.Undefined = 0] = "Undefined", e[e.Point = 1] = "Point", e[e.Percent = 2] = "Percent", e[e.Auto = 3] = "Auto", e;
  }({}), Qi = function(e) {
    return e[e.NoWrap = 0] = "NoWrap", e[e.Wrap = 1] = "Wrap", e[e.WrapReverse = 2] = "WrapReverse", e;
  }({}), _d = { ALIGN_AUTO: Gt.Auto, ALIGN_FLEX_START: Gt.FlexStart, ALIGN_CENTER: Gt.Center, ALIGN_FLEX_END: Gt.FlexEnd, ALIGN_STRETCH: Gt.Stretch, ALIGN_BASELINE: Gt.Baseline, ALIGN_SPACE_BETWEEN: Gt.SpaceBetween, ALIGN_SPACE_AROUND: Gt.SpaceAround, ALIGN_SPACE_EVENLY: Gt.SpaceEvenly, BOX_SIZING_BORDER_BOX: Va.BorderBox, BOX_SIZING_CONTENT_BOX: Va.ContentBox, DIMENSION_WIDTH: Ha.Width, DIMENSION_HEIGHT: Ha.Height, DIRECTION_INHERIT: Vr.Inherit, DIRECTION_LTR: Vr.LTR, DIRECTION_RTL: Vr.RTL, DISPLAY_FLEX: Vi.Flex, DISPLAY_NONE: Vi.None, DISPLAY_CONTENTS: Vi.Contents, EDGE_LEFT: jt.Left, EDGE_TOP: jt.Top, EDGE_RIGHT: jt.Right, EDGE_BOTTOM: jt.Bottom, EDGE_START: jt.Start, EDGE_END: jt.End, EDGE_HORIZONTAL: jt.Horizontal, EDGE_VERTICAL: jt.Vertical, EDGE_ALL: jt.All, ERRATA_NONE: Tr.None, ERRATA_STRETCH_FLEX_BASIS: Tr.StretchFlexBasis, ERRATA_ABSOLUTE_POSITION_WITHOUT_INSETS_EXCLUDES_PADDING: Tr.AbsolutePositionWithoutInsetsExcludesPadding, ERRATA_ABSOLUTE_PERCENT_AGAINST_INNER_SIZE: Tr.AbsolutePercentAgainstInnerSize, ERRATA_ALL: Tr.All, ERRATA_CLASSIC: Tr.Classic, EXPERIMENTAL_FEATURE_WEB_FLEX_BASIS: Sd.WebFlexBasis, FLEX_DIRECTION_COLUMN: Yn.Column, FLEX_DIRECTION_COLUMN_REVERSE: Yn.ColumnReverse, FLEX_DIRECTION_ROW: Yn.Row, FLEX_DIRECTION_ROW_REVERSE: Yn.RowReverse, GUTTER_COLUMN: Hi.Column, GUTTER_ROW: Hi.Row, GUTTER_ALL: Hi.All, JUSTIFY_FLEX_START: Er.FlexStart, JUSTIFY_CENTER: Er.Center, JUSTIFY_FLEX_END: Er.FlexEnd, JUSTIFY_SPACE_BETWEEN: Er.SpaceBetween, JUSTIFY_SPACE_AROUND: Er.SpaceAround, JUSTIFY_SPACE_EVENLY: Er.SpaceEvenly, LOG_LEVEL_ERROR: kr.Error, LOG_LEVEL_WARN: kr.Warn, LOG_LEVEL_INFO: kr.Info, LOG_LEVEL_DEBUG: kr.Debug, LOG_LEVEL_VERBOSE: kr.Verbose, LOG_LEVEL_FATAL: kr.Fatal, MEASURE_MODE_UNDEFINED: Yi.Undefined, MEASURE_MODE_EXACTLY: Yi.Exactly, MEASURE_MODE_AT_MOST: Yi.AtMost, NODE_TYPE_DEFAULT: Ya.Default, NODE_TYPE_TEXT: Ya.Text, OVERFLOW_VISIBLE: Xi.Visible, OVERFLOW_HIDDEN: Xi.Hidden, OVERFLOW_SCROLL: Xi.Scroll, POSITION_TYPE_STATIC: Ki.Static, POSITION_TYPE_RELATIVE: Ki.Relative, POSITION_TYPE_ABSOLUTE: Ki.Absolute, UNIT_UNDEFINED: St.Undefined, UNIT_POINT: St.Point, UNIT_PERCENT: St.Percent, UNIT_AUTO: St.Auto, WRAP_NO_WRAP: Qi.NoWrap, WRAP_WRAP: Qi.Wrap, WRAP_WRAP_REVERSE: Qi.WrapReverse }, Xa = _d;
});
function Ji(e) {
  function t(i, o, s) {
    let a = i[o];
    i[o] = function() {
      for (var u2 = arguments.length, l2 = new Array(u2), f = 0; f < u2; f++)
        l2[f] = arguments[f];
      return s.call(this, a, ...l2);
    };
  }
  for (let i of ["setPosition", "setMargin", "setFlexBasis", "setWidth", "setHeight", "setMinWidth", "setMinHeight", "setMaxWidth", "setMaxHeight", "setPadding", "setGap"]) {
    let o = { [St.Point]: e.Node.prototype[i], [St.Percent]: e.Node.prototype[`${i}Percent`], [St.Auto]: e.Node.prototype[`${i}Auto`] };
    t(e.Node.prototype, i, function(s) {
      for (var a = arguments.length, u2 = new Array(a > 1 ? a - 1 : 0), l2 = 1; l2 < a; l2++)
        u2[l2 - 1] = arguments[l2];
      let f = u2.pop(), c2, m2;
      if (f === "auto")
        c2 = St.Auto, m2 = void 0;
      else if (typeof f == "object")
        c2 = f.unit, m2 = f.valueOf();
      else if (c2 = typeof f == "string" && f.endsWith("%") ? St.Percent : St.Point, m2 = parseFloat(f), f !== void 0 && !Number.isNaN(f) && Number.isNaN(m2))
        throw new Error(`Invalid value ${f} for ${i}`);
      if (!o[c2])
        throw new Error(`Failed to execute "${i}": Unsupported unit '${f}'`);
      return m2 !== void 0 ? o[c2].call(this, ...u2, m2) : o[c2].call(this, ...u2);
    });
  }
  function r(i) {
    return e.MeasureCallback.implement({ measure: function() {
      let { width: o, height: s } = i(...arguments);
      return { width: o ?? NaN, height: s ?? NaN };
    } });
  }
  t(e.Node.prototype, "setMeasureFunc", function(i, o) {
    return o ? i.call(this, r(o)) : this.unsetMeasureFunc();
  });
  function n(i) {
    return e.DirtiedCallback.implement({ dirtied: i });
  }
  return t(e.Node.prototype, "setDirtiedFunc", function(i, o) {
    i.call(this, n(o));
  }), t(e.Config.prototype, "free", function() {
    e.Config.destroy(this);
  }), t(e.Node, "create", (i, o) => o ? e.Node.createWithConfig(o) : e.Node.createDefault()), t(e.Node.prototype, "free", function() {
    e.Node.destroy(this);
  }), t(e.Node.prototype, "freeRecursive", function() {
    for (let i = 0, o = this.getChildCount(); i < o; ++i)
      this.getChild(0).freeRecursive();
    this.free();
  }), t(e.Node.prototype, "calculateLayout", function(i) {
    let o = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : NaN, s = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : NaN, a = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : Vr.LTR;
    return i.call(this, o, s, a);
  }), { Config: e.Config, Node: e.Node, ...Xa };
}
var Ka = ar(() => {
  Xn();
  Xn();
});
var Ja = {};
Gn(Ja, { default: () => Td });
function Td(e) {
  e = e || {};
  var t;
  t || (t = typeof e < "u" ? e : {});
  var r, n;
  t.ready = new Promise(function(d2, p) {
    r = d2, n = p;
  });
  var i = Object.assign({}, t), o = "";
  typeof document < "u" && document.currentScript && (o = document.currentScript.src), Qa && (o = Qa), o.indexOf("blob:") !== 0 ? o = o.substr(0, o.replace(/[?#].*/, "").lastIndexOf("/") + 1) : o = "";
  var s = t.print || console.log.bind(console), a = t.printErr || console.warn.bind(console);
  Object.assign(t, i), i = null;
  var u2;
  t.wasmBinary && (u2 = t.wasmBinary);
  var l2 = t.noExitRuntime || true;
  typeof WebAssembly != "object" && Me("no native wasm support detected");
  var f, c2 = false;
  function m2(d2, p, b) {
    b = p + b;
    for (var v2 = ""; !(p >= b); ) {
      var S2 = d2[p++];
      if (!S2)
        break;
      if (S2 & 128) {
        var O = d2[p++] & 63;
        if ((S2 & 224) == 192)
          v2 += String.fromCharCode((S2 & 31) << 6 | O);
        else {
          var L = d2[p++] & 63;
          S2 = (S2 & 240) == 224 ? (S2 & 15) << 12 | O << 6 | L : (S2 & 7) << 18 | O << 12 | L << 6 | d2[p++] & 63, 65536 > S2 ? v2 += String.fromCharCode(S2) : (S2 -= 65536, v2 += String.fromCharCode(55296 | S2 >> 10, 56320 | S2 & 1023));
        }
      } else
        v2 += String.fromCharCode(S2);
    }
    return v2;
  }
  var h2, g2, y, x2, w2, P2, T, A, E;
  function _() {
    var d2 = f.buffer;
    h2 = d2, t.HEAP8 = g2 = new Int8Array(d2), t.HEAP16 = x2 = new Int16Array(d2), t.HEAP32 = P2 = new Int32Array(d2), t.HEAPU8 = y = new Uint8Array(d2), t.HEAPU16 = w2 = new Uint16Array(d2), t.HEAPU32 = T = new Uint32Array(d2), t.HEAPF32 = A = new Float32Array(d2), t.HEAPF64 = E = new Float64Array(d2);
  }
  var R2, C = [], z = [], G = [];
  function ie() {
    var d2 = t.preRun.shift();
    C.unshift(d2);
  }
  var te = 0, he = null, de = null;
  function Me(d2) {
    throw t.onAbort && t.onAbort(d2), d2 = "Aborted(" + d2 + ")", a(d2), c2 = true, d2 = new WebAssembly.RuntimeError(d2 + ". Build with -sASSERTIONS for more info."), n(d2), d2;
  }
  function Re(d2) {
    return d2.startsWith("data:application/octet-stream;base64,");
  }
  var Oe = "";
  if (!Re(Oe)) {
    var $e = Oe;
    Oe = t.locateFile ? t.locateFile($e, o) : o + $e;
  }
  function re() {
    var d2 = Oe;
    try {
      if (d2 == Oe && u2)
        return new Uint8Array(u2);
      if (Re(d2))
        try {
          var p = Jc(d2.slice(37)), b = new Uint8Array(p.length);
          for (d2 = 0; d2 < p.length; ++d2)
            b[d2] = p.charCodeAt(d2);
          var v2 = b;
        } catch {
          throw Error("Converting base64 string to bytes failed.");
        }
      else
        v2 = void 0;
      var S2 = v2;
      if (S2)
        return S2;
      throw "both async and sync fetching of the wasm failed";
    } catch (O) {
      Me(O);
    }
  }
  function me() {
    return u2 || typeof fetch != "function" ? Promise.resolve().then(function() {
      return re();
    }) : fetch(Oe, { credentials: "same-origin" }).then(function(d2) {
      if (!d2.ok)
        throw "failed to load wasm binary file at '" + Oe + "'";
      return d2.arrayBuffer();
    }).catch(function() {
      return re();
    });
  }
  function rt(d2) {
    for (; 0 < d2.length; )
      d2.shift()(t);
  }
  function qe(d2) {
    if (d2 === void 0)
      return "_unknown";
    d2 = d2.replace(/[^a-zA-Z0-9_]/g, "$");
    var p = d2.charCodeAt(0);
    return 48 <= p && 57 >= p ? "_" + d2 : d2;
  }
  function Ae(d2, p) {
    return d2 = qe(d2), function() {
      return p.apply(this, arguments);
    };
  }
  var ne = [{}, { value: void 0 }, { value: null }, { value: true }, { value: false }], Q = [];
  function we(d2) {
    var p = Error, b = Ae(d2, function(v2) {
      this.name = d2, this.message = v2, v2 = Error(v2).stack, v2 !== void 0 && (this.stack = this.toString() + `
` + v2.replace(/^Error(:[^\n]*)?\n/, ""));
    });
    return b.prototype = Object.create(p.prototype), b.prototype.constructor = b, b.prototype.toString = function() {
      return this.message === void 0 ? this.name : this.name + ": " + this.message;
    }, b;
  }
  var Z = void 0;
  function j(d2) {
    throw new Z(d2);
  }
  var Ee = (d2) => (d2 || j("Cannot use deleted val. handle = " + d2), ne[d2].value), Ie = (d2) => {
    switch (d2) {
      case void 0:
        return 1;
      case null:
        return 2;
      case true:
        return 3;
      case false:
        return 4;
      default:
        var p = Q.length ? Q.pop() : ne.length;
        return ne[p] = { ga: 1, value: d2 }, p;
    }
  }, Ce = void 0, Fe = void 0;
  function le(d2) {
    for (var p = ""; y[d2]; )
      p += Fe[y[d2++]];
    return p;
  }
  var Qe = [];
  function nt() {
    for (; Qe.length; ) {
      var d2 = Qe.pop();
      d2.M.$ = false, d2.delete();
    }
  }
  var Ne = void 0, be = {};
  function Ge(d2, p) {
    for (p === void 0 && j("ptr should not be undefined"); d2.R; )
      p = d2.ba(p), d2 = d2.R;
    return p;
  }
  var Tt = {};
  function Dr(d2) {
    d2 = Sa(d2);
    var p = le(d2);
    return Bt(d2), p;
  }
  function Wr(d2, p) {
    var b = Tt[d2];
    return b === void 0 && j(p + " has unknown type " + Dr(d2)), b;
  }
  function Ft() {
  }
  var $r = false;
  function Br(d2) {
    --d2.count.value, d2.count.value === 0 && (d2.T ? d2.U.W(d2.T) : d2.P.N.W(d2.O));
  }
  function or(d2, p, b) {
    return p === b ? d2 : b.R === void 0 ? null : (d2 = or(d2, p, b.R), d2 === null ? null : b.na(d2));
  }
  var Et = {};
  function kt(d2, p) {
    return p = Ge(d2, p), be[p];
  }
  var it = void 0;
  function Nt(d2) {
    throw new it(d2);
  }
  function je(d2, p) {
    return p.P && p.O || Nt("makeClassHandle requires ptr and ptrType"), !!p.U != !!p.T && Nt("Both smartPtrType and smartPtr must be specified"), p.count = { value: 1 }, ot(Object.create(d2, { M: { value: p } }));
  }
  function ot(d2) {
    return typeof FinalizationRegistry > "u" ? (ot = (p) => p, d2) : ($r = new FinalizationRegistry((p) => {
      Br(p.M);
    }), ot = (p) => {
      var b = p.M;
      return b.T && $r.register(p, { M: b }, p), p;
    }, Ft = (p) => {
      $r.unregister(p);
    }, ot(d2));
  }
  var Dt = {};
  function yr(d2) {
    for (; d2.length; ) {
      var p = d2.pop();
      d2.pop()(p);
    }
  }
  function Pt(d2) {
    return this.fromWireType(P2[d2 >> 2]);
  }
  var ze = {}, Ot = {};
  function Be(d2, p, b) {
    function v2(M) {
      M = b(M), M.length !== d2.length && Nt("Mismatched type converter count");
      for (var D = 0; D < d2.length; ++D)
        H(d2[D], M[D]);
    }
    d2.forEach(function(M) {
      Ot[M] = p;
    });
    var S2 = Array(p.length), O = [], L = 0;
    p.forEach((M, D) => {
      Tt.hasOwnProperty(M) ? S2[D] = Tt[M] : (O.push(M), ze.hasOwnProperty(M) || (ze[M] = []), ze[M].push(() => {
        S2[D] = Tt[M], ++L, L === O.length && v2(S2);
      }));
    }), O.length === 0 && v2(S2);
  }
  function vr(d2) {
    switch (d2) {
      case 1:
        return 0;
      case 2:
        return 1;
      case 4:
        return 2;
      case 8:
        return 3;
      default:
        throw new TypeError("Unknown type size: " + d2);
    }
  }
  function H(d2, p, b = {}) {
    if (!("argPackAdvance" in p))
      throw new TypeError("registerType registeredInstance requires argPackAdvance");
    var v2 = p.name;
    if (d2 || j('type "' + v2 + '" must have a positive integer typeid pointer'), Tt.hasOwnProperty(d2)) {
      if (b.ua)
        return;
      j("Cannot register type '" + v2 + "' twice");
    }
    Tt[d2] = p, delete Ot[d2], ze.hasOwnProperty(d2) && (p = ze[d2], delete ze[d2], p.forEach((S2) => S2()));
  }
  function K2(d2) {
    j(d2.M.P.N.name + " instance already deleted");
  }
  function ee() {
  }
  function J(d2, p, b) {
    if (d2[p].S === void 0) {
      var v2 = d2[p];
      d2[p] = function() {
        return d2[p].S.hasOwnProperty(arguments.length) || j("Function '" + b + "' called with an invalid number of arguments (" + arguments.length + ") - expects one of (" + d2[p].S + ")!"), d2[p].S[arguments.length].apply(this, arguments);
      }, d2[p].S = [], d2[p].S[v2.Z] = v2;
    }
  }
  function ke(d2, p) {
    t.hasOwnProperty(d2) ? (j("Cannot register public name '" + d2 + "' twice"), J(t, d2, d2), t.hasOwnProperty(void 0) && j("Cannot register multiple overloads of a function with the same number of arguments (undefined)!"), t[d2].S[void 0] = p) : t[d2] = p;
  }
  function fe(d2, p, b, v2, S2, O, L, M) {
    this.name = d2, this.constructor = p, this.X = b, this.W = v2, this.R = S2, this.pa = O, this.ba = L, this.na = M, this.ja = [];
  }
  function ye(d2, p, b) {
    for (; p !== b; )
      p.ba || j("Expected null or instance of " + b.name + ", got an instance of " + p.name), d2 = p.ba(d2), p = p.R;
    return d2;
  }
  function ce(d2, p) {
    return p === null ? (this.ea && j("null is not a valid " + this.name), 0) : (p.M || j('Cannot pass "' + Pe(p) + '" as a ' + this.name), p.M.O || j("Cannot pass deleted object as a pointer of type " + this.name), ye(p.M.O, p.M.P.N, this.N));
  }
  function oe(d2, p) {
    if (p === null) {
      if (this.ea && j("null is not a valid " + this.name), this.da) {
        var b = this.fa();
        return d2 !== null && d2.push(this.W, b), b;
      }
      return 0;
    }
    if (p.M || j('Cannot pass "' + Pe(p) + '" as a ' + this.name), p.M.O || j("Cannot pass deleted object as a pointer of type " + this.name), !this.ca && p.M.P.ca && j("Cannot convert argument of type " + (p.M.U ? p.M.U.name : p.M.P.name) + " to parameter type " + this.name), b = ye(p.M.O, p.M.P.N, this.N), this.da)
      switch (p.M.T === void 0 && j("Passing raw pointer to smart pointer is illegal"), this.Ba) {
        case 0:
          p.M.U === this ? b = p.M.T : j("Cannot convert argument of type " + (p.M.U ? p.M.U.name : p.M.P.name) + " to parameter type " + this.name);
          break;
        case 1:
          b = p.M.T;
          break;
        case 2:
          if (p.M.U === this)
            b = p.M.T;
          else {
            var v2 = p.clone();
            b = this.xa(b, Ie(function() {
              v2.delete();
            })), d2 !== null && d2.push(this.W, b);
          }
          break;
        default:
          j("Unsupporting sharing policy");
      }
    return b;
  }
  function ut(d2, p) {
    return p === null ? (this.ea && j("null is not a valid " + this.name), 0) : (p.M || j('Cannot pass "' + Pe(p) + '" as a ' + this.name), p.M.O || j("Cannot pass deleted object as a pointer of type " + this.name), p.M.P.ca && j("Cannot convert argument of type " + p.M.P.name + " to parameter type " + this.name), ye(p.M.O, p.M.P.N, this.N));
  }
  function Y(d2, p, b, v2) {
    this.name = d2, this.N = p, this.ea = b, this.ca = v2, this.da = false, this.W = this.xa = this.fa = this.ka = this.Ba = this.wa = void 0, p.R !== void 0 ? this.toWireType = oe : (this.toWireType = v2 ? ce : ut, this.V = null);
  }
  function Rt(d2, p) {
    t.hasOwnProperty(d2) || Nt("Replacing nonexistant public symbol"), t[d2] = p, t[d2].Z = void 0;
  }
  function Ve(d2, p) {
    var b = [];
    return function() {
      if (b.length = 0, Object.assign(b, arguments), d2.includes("j")) {
        var v2 = t["dynCall_" + d2];
        v2 = b && b.length ? v2.apply(null, [p].concat(b)) : v2.call(null, p);
      } else
        v2 = R2.get(p).apply(null, b);
      return v2;
    };
  }
  function He(d2, p) {
    d2 = le(d2);
    var b = d2.includes("j") ? Ve(d2, p) : R2.get(p);
    return typeof b != "function" && j("unknown function pointer with signature " + d2 + ": " + p), b;
  }
  var st = void 0;
  function Wt(d2, p) {
    function b(O) {
      S2[O] || Tt[O] || (Ot[O] ? Ot[O].forEach(b) : (v2.push(O), S2[O] = true));
    }
    var v2 = [], S2 = {};
    throw p.forEach(b), new st(d2 + ": " + v2.map(Dr).join([", "]));
  }
  function Ye(d2, p, b, v2, S2) {
    var O = p.length;
    2 > O && j("argTypes array size mismatch! Must at least get return value and 'this' types!");
    var L = p[1] !== null && b !== null, M = false;
    for (b = 1; b < p.length; ++b)
      if (p[b] !== null && p[b].V === void 0) {
        M = true;
        break;
      }
    var D = p[0].name !== "void", N = O - 2, $ = Array(N), V = [], se = [];
    return function() {
      if (arguments.length !== N && j("function " + d2 + " called with " + arguments.length + " arguments, expected " + N + " args!"), se.length = 0, V.length = L ? 2 : 1, V[0] = S2, L) {
        var Le = p[1].toWireType(se, this);
        V[1] = Le;
      }
      for (var pe = 0; pe < N; ++pe)
        $[pe] = p[pe + 2].toWireType(se, arguments[pe]), V.push($[pe]);
      if (pe = v2.apply(null, V), M)
        yr(se);
      else
        for (var at = L ? 1 : 2; at < p.length; at++) {
          var xt = at === 1 ? Le : $[at - 2];
          p[at].V !== null && p[at].V(xt);
        }
      return Le = D ? p[0].fromWireType(pe) : void 0, Le;
    };
  }
  function $t(d2, p) {
    for (var b = [], v2 = 0; v2 < d2; v2++)
      b.push(T[p + 4 * v2 >> 2]);
    return b;
  }
  function Se(d2) {
    4 < d2 && --ne[d2].ga === 0 && (ne[d2] = void 0, Q.push(d2));
  }
  function Pe(d2) {
    if (d2 === null)
      return "null";
    var p = typeof d2;
    return p === "object" || p === "array" || p === "function" ? d2.toString() : "" + d2;
  }
  function lt(d2, p) {
    switch (p) {
      case 2:
        return function(b) {
          return this.fromWireType(A[b >> 2]);
        };
      case 3:
        return function(b) {
          return this.fromWireType(E[b >> 3]);
        };
      default:
        throw new TypeError("Unknown float type: " + d2);
    }
  }
  function Je(d2, p, b) {
    switch (p) {
      case 0:
        return b ? function(v2) {
          return g2[v2];
        } : function(v2) {
          return y[v2];
        };
      case 1:
        return b ? function(v2) {
          return x2[v2 >> 1];
        } : function(v2) {
          return w2[v2 >> 1];
        };
      case 2:
        return b ? function(v2) {
          return P2[v2 >> 2];
        } : function(v2) {
          return T[v2 >> 2];
        };
      default:
        throw new TypeError("Unknown integer type: " + d2);
    }
  }
  function ft(d2, p) {
    for (var b = "", v2 = 0; !(v2 >= p / 2); ++v2) {
      var S2 = x2[d2 + 2 * v2 >> 1];
      if (S2 == 0)
        break;
      b += String.fromCharCode(S2);
    }
    return b;
  }
  function vt(d2, p, b) {
    if (b === void 0 && (b = 2147483647), 2 > b)
      return 0;
    b -= 2;
    var v2 = p;
    b = b < 2 * d2.length ? b / 2 : d2.length;
    for (var S2 = 0; S2 < b; ++S2)
      x2[p >> 1] = d2.charCodeAt(S2), p += 2;
    return x2[p >> 1] = 0, p - v2;
  }
  function Xe(d2) {
    return 2 * d2.length;
  }
  function ct(d2, p) {
    for (var b = 0, v2 = ""; !(b >= p / 4); ) {
      var S2 = P2[d2 + 4 * b >> 2];
      if (S2 == 0)
        break;
      ++b, 65536 <= S2 ? (S2 -= 65536, v2 += String.fromCharCode(55296 | S2 >> 10, 56320 | S2 & 1023)) : v2 += String.fromCharCode(S2);
    }
    return v2;
  }
  function Ur(d2, p, b) {
    if (b === void 0 && (b = 2147483647), 4 > b)
      return 0;
    var v2 = p;
    b = v2 + b - 4;
    for (var S2 = 0; S2 < d2.length; ++S2) {
      var O = d2.charCodeAt(S2);
      if (55296 <= O && 57343 >= O) {
        var L = d2.charCodeAt(++S2);
        O = 65536 + ((O & 1023) << 10) | L & 1023;
      }
      if (P2[p >> 2] = O, p += 4, p + 4 > b)
        break;
    }
    return P2[p >> 2] = 0, p - v2;
  }
  function xr(d2) {
    for (var p = 0, b = 0; b < d2.length; ++b) {
      var v2 = d2.charCodeAt(b);
      55296 <= v2 && 57343 >= v2 && ++b, p += 4;
    }
    return p;
  }
  var Bn = {};
  function qr(d2) {
    var p = Bn[d2];
    return p === void 0 ? le(d2) : p;
  }
  var sr = [];
  function Xc(d2) {
    var p = sr.length;
    return sr.push(d2), p;
  }
  function Kc(d2, p) {
    for (var b = Array(d2), v2 = 0; v2 < d2; ++v2)
      b[v2] = Wr(T[p + 4 * v2 >> 2], "parameter " + v2);
    return b;
  }
  var xa = [], Qc = [null, [], []];
  Z = t.BindingError = we("BindingError"), t.count_emval_handles = function() {
    for (var d2 = 0, p = 5; p < ne.length; ++p)
      ne[p] !== void 0 && ++d2;
    return d2;
  }, t.get_first_emval = function() {
    for (var d2 = 5; d2 < ne.length; ++d2)
      if (ne[d2] !== void 0)
        return ne[d2];
    return null;
  }, Ce = t.PureVirtualError = we("PureVirtualError");
  for (var wa = Array(256), Un = 0; 256 > Un; ++Un)
    wa[Un] = String.fromCharCode(Un);
  Fe = wa, t.getInheritedInstanceCount = function() {
    return Object.keys(be).length;
  }, t.getLiveInheritedInstances = function() {
    var d2 = [], p;
    for (p in be)
      be.hasOwnProperty(p) && d2.push(be[p]);
    return d2;
  }, t.flushPendingDeletes = nt, t.setDelayFunction = function(d2) {
    Ne = d2, Qe.length && Ne && Ne(nt);
  }, it = t.InternalError = we("InternalError"), ee.prototype.isAliasOf = function(d2) {
    if (!(this instanceof ee && d2 instanceof ee))
      return false;
    var p = this.M.P.N, b = this.M.O, v2 = d2.M.P.N;
    for (d2 = d2.M.O; p.R; )
      b = p.ba(b), p = p.R;
    for (; v2.R; )
      d2 = v2.ba(d2), v2 = v2.R;
    return p === v2 && b === d2;
  }, ee.prototype.clone = function() {
    if (this.M.O || K2(this), this.M.aa)
      return this.M.count.value += 1, this;
    var d2 = ot, p = Object, b = p.create, v2 = Object.getPrototypeOf(this), S2 = this.M;
    return d2 = d2(b.call(p, v2, { M: { value: { count: S2.count, $: S2.$, aa: S2.aa, O: S2.O, P: S2.P, T: S2.T, U: S2.U } } })), d2.M.count.value += 1, d2.M.$ = false, d2;
  }, ee.prototype.delete = function() {
    this.M.O || K2(this), this.M.$ && !this.M.aa && j("Object already scheduled for deletion"), Ft(this), Br(this.M), this.M.aa || (this.M.T = void 0, this.M.O = void 0);
  }, ee.prototype.isDeleted = function() {
    return !this.M.O;
  }, ee.prototype.deleteLater = function() {
    return this.M.O || K2(this), this.M.$ && !this.M.aa && j("Object already scheduled for deletion"), Qe.push(this), Qe.length === 1 && Ne && Ne(nt), this.M.$ = true, this;
  }, Y.prototype.qa = function(d2) {
    return this.ka && (d2 = this.ka(d2)), d2;
  }, Y.prototype.ha = function(d2) {
    this.W && this.W(d2);
  }, Y.prototype.argPackAdvance = 8, Y.prototype.readValueFromPointer = Pt, Y.prototype.deleteObject = function(d2) {
    d2 !== null && d2.delete();
  }, Y.prototype.fromWireType = function(d2) {
    function p() {
      return this.da ? je(this.N.X, { P: this.wa, O: b, U: this, T: d2 }) : je(this.N.X, { P: this, O: d2 });
    }
    var b = this.qa(d2);
    if (!b)
      return this.ha(d2), null;
    var v2 = kt(this.N, b);
    if (v2 !== void 0)
      return v2.M.count.value === 0 ? (v2.M.O = b, v2.M.T = d2, v2.clone()) : (v2 = v2.clone(), this.ha(d2), v2);
    if (v2 = this.N.pa(b), v2 = Et[v2], !v2)
      return p.call(this);
    v2 = this.ca ? v2.la : v2.pointerType;
    var S2 = or(b, this.N, v2.N);
    return S2 === null ? p.call(this) : this.da ? je(v2.N.X, { P: v2, O: S2, U: this, T: d2 }) : je(v2.N.X, { P: v2, O: S2 });
  }, st = t.UnboundTypeError = we("UnboundTypeError");
  var Jc = typeof atob == "function" ? atob : function(d2) {
    var p = "", b = 0;
    d2 = d2.replace(/[^A-Za-z0-9\+\/=]/g, "");
    do {
      var v2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(d2.charAt(b++)), S2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(d2.charAt(b++)), O = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(d2.charAt(b++)), L = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".indexOf(d2.charAt(b++));
      v2 = v2 << 2 | S2 >> 4, S2 = (S2 & 15) << 4 | O >> 2;
      var M = (O & 3) << 6 | L;
      p += String.fromCharCode(v2), O !== 64 && (p += String.fromCharCode(S2)), L !== 64 && (p += String.fromCharCode(M));
    } while (b < d2.length);
    return p;
  }, Zc = { l: function(d2, p, b, v2) {
    Me("Assertion failed: " + (d2 ? m2(y, d2) : "") + ", at: " + [p ? p ? m2(y, p) : "" : "unknown filename", b, v2 ? v2 ? m2(y, v2) : "" : "unknown function"]);
  }, q: function(d2, p, b) {
    d2 = le(d2), p = Wr(p, "wrapper"), b = Ee(b);
    var v2 = [].slice, S2 = p.N, O = S2.X, L = S2.R.X, M = S2.R.constructor;
    d2 = Ae(d2, function() {
      S2.R.ja.forEach(function(N) {
        if (this[N] === L[N])
          throw new Ce("Pure virtual function " + N + " must be implemented in JavaScript");
      }.bind(this)), Object.defineProperty(this, "__parent", { value: O }), this.__construct.apply(this, v2.call(arguments));
    }), O.__construct = function() {
      this === O && j("Pass correct 'this' to __construct");
      var N = M.implement.apply(void 0, [this].concat(v2.call(arguments)));
      Ft(N);
      var $ = N.M;
      N.notifyOnDestruction(), $.aa = true, Object.defineProperties(this, { M: { value: $ } }), ot(this), N = $.O, N = Ge(S2, N), be.hasOwnProperty(N) ? j("Tried to register registered instance: " + N) : be[N] = this;
    }, O.__destruct = function() {
      this === O && j("Pass correct 'this' to __destruct"), Ft(this);
      var N = this.M.O;
      N = Ge(S2, N), be.hasOwnProperty(N) ? delete be[N] : j("Tried to unregister unregistered instance: " + N);
    }, d2.prototype = Object.create(O);
    for (var D in b)
      d2.prototype[D] = b[D];
    return Ie(d2);
  }, j: function(d2) {
    var p = Dt[d2];
    delete Dt[d2];
    var b = p.fa, v2 = p.W, S2 = p.ia, O = S2.map((L) => L.ta).concat(S2.map((L) => L.za));
    Be([d2], O, (L) => {
      var M = {};
      return S2.forEach((D, N) => {
        var $ = L[N], V = D.ra, se = D.sa, Le = L[N + S2.length], pe = D.ya, at = D.Aa;
        M[D.oa] = { read: (xt) => $.fromWireType(V(se, xt)), write: (xt, zr) => {
          var Ut = [];
          pe(at, xt, Le.toWireType(Ut, zr)), yr(Ut);
        } };
      }), [{ name: p.name, fromWireType: function(D) {
        var N = {}, $;
        for ($ in M)
          N[$] = M[$].read(D);
        return v2(D), N;
      }, toWireType: function(D, N) {
        for (var $ in M)
          if (!($ in N))
            throw new TypeError('Missing field:  "' + $ + '"');
        var V = b();
        for ($ in M)
          M[$].write(V, N[$]);
        return D !== null && D.push(v2, V), V;
      }, argPackAdvance: 8, readValueFromPointer: Pt, V: v2 }];
    });
  }, v: function() {
  }, B: function(d2, p, b, v2, S2) {
    var O = vr(b);
    p = le(p), H(d2, { name: p, fromWireType: function(L) {
      return !!L;
    }, toWireType: function(L, M) {
      return M ? v2 : S2;
    }, argPackAdvance: 8, readValueFromPointer: function(L) {
      if (b === 1)
        var M = g2;
      else if (b === 2)
        M = x2;
      else if (b === 4)
        M = P2;
      else
        throw new TypeError("Unknown boolean type size: " + p);
      return this.fromWireType(M[L >> O]);
    }, V: null });
  }, f: function(d2, p, b, v2, S2, O, L, M, D, N, $, V, se) {
    $ = le($), O = He(S2, O), M && (M = He(L, M)), N && (N = He(D, N)), se = He(V, se);
    var Le = qe($);
    ke(Le, function() {
      Wt("Cannot construct " + $ + " due to unbound types", [v2]);
    }), Be([d2, p, b], v2 ? [v2] : [], function(pe) {
      if (pe = pe[0], v2)
        var at = pe.N, xt = at.X;
      else
        xt = ee.prototype;
      pe = Ae(Le, function() {
        if (Object.getPrototypeOf(this) !== zr)
          throw new Z("Use 'new' to construct " + $);
        if (Ut.Y === void 0)
          throw new Z($ + " has no accessible constructor");
        var Ea = Ut.Y[arguments.length];
        if (Ea === void 0)
          throw new Z("Tried to invoke ctor of " + $ + " with invalid number of parameters (" + arguments.length + ") - expected (" + Object.keys(Ut.Y).toString() + ") parameters instead!");
        return Ea.apply(this, arguments);
      });
      var zr = Object.create(xt, { constructor: { value: pe } });
      pe.prototype = zr;
      var Ut = new fe($, pe, zr, se, at, O, M, N);
      at = new Y($, Ut, true, false), xt = new Y($ + "*", Ut, false, false);
      var Ta = new Y($ + " const*", Ut, false, true);
      return Et[d2] = { pointerType: xt, la: Ta }, Rt(Le, pe), [at, xt, Ta];
    });
  }, d: function(d2, p, b, v2, S2, O, L) {
    var M = $t(b, v2);
    p = le(p), O = He(S2, O), Be([], [d2], function(D) {
      function N() {
        Wt("Cannot call " + $ + " due to unbound types", M);
      }
      D = D[0];
      var $ = D.name + "." + p;
      p.startsWith("@@") && (p = Symbol[p.substring(2)]);
      var V = D.N.constructor;
      return V[p] === void 0 ? (N.Z = b - 1, V[p] = N) : (J(V, p, $), V[p].S[b - 1] = N), Be([], M, function(se) {
        return se = Ye($, [se[0], null].concat(se.slice(1)), null, O, L), V[p].S === void 0 ? (se.Z = b - 1, V[p] = se) : V[p].S[b - 1] = se, [];
      }), [];
    });
  }, p: function(d2, p, b, v2, S2, O) {
    0 < p || Me();
    var L = $t(p, b);
    S2 = He(v2, S2), Be([], [d2], function(M) {
      M = M[0];
      var D = "constructor " + M.name;
      if (M.N.Y === void 0 && (M.N.Y = []), M.N.Y[p - 1] !== void 0)
        throw new Z("Cannot register multiple constructors with identical number of parameters (" + (p - 1) + ") for class '" + M.name + "'! Overload resolution is currently only performed using the parameter count, not actual type info!");
      return M.N.Y[p - 1] = () => {
        Wt("Cannot construct " + M.name + " due to unbound types", L);
      }, Be([], L, function(N) {
        return N.splice(1, 0, null), M.N.Y[p - 1] = Ye(D, N, null, S2, O), [];
      }), [];
    });
  }, a: function(d2, p, b, v2, S2, O, L, M) {
    var D = $t(b, v2);
    p = le(p), O = He(S2, O), Be([], [d2], function(N) {
      function $() {
        Wt("Cannot call " + V + " due to unbound types", D);
      }
      N = N[0];
      var V = N.name + "." + p;
      p.startsWith("@@") && (p = Symbol[p.substring(2)]), M && N.N.ja.push(p);
      var se = N.N.X, Le = se[p];
      return Le === void 0 || Le.S === void 0 && Le.className !== N.name && Le.Z === b - 2 ? ($.Z = b - 2, $.className = N.name, se[p] = $) : (J(se, p, V), se[p].S[b - 2] = $), Be([], D, function(pe) {
        return pe = Ye(V, pe, N, O, L), se[p].S === void 0 ? (pe.Z = b - 2, se[p] = pe) : se[p].S[b - 2] = pe, [];
      }), [];
    });
  }, A: function(d2, p) {
    p = le(p), H(d2, { name: p, fromWireType: function(b) {
      var v2 = Ee(b);
      return Se(b), v2;
    }, toWireType: function(b, v2) {
      return Ie(v2);
    }, argPackAdvance: 8, readValueFromPointer: Pt, V: null });
  }, n: function(d2, p, b) {
    b = vr(b), p = le(p), H(d2, { name: p, fromWireType: function(v2) {
      return v2;
    }, toWireType: function(v2, S2) {
      return S2;
    }, argPackAdvance: 8, readValueFromPointer: lt(p, b), V: null });
  }, e: function(d2, p, b, v2, S2) {
    p = le(p), S2 === -1 && (S2 = 4294967295), S2 = vr(b);
    var O = (M) => M;
    if (v2 === 0) {
      var L = 32 - 8 * b;
      O = (M) => M << L >>> L;
    }
    b = p.includes("unsigned") ? function(M, D) {
      return D >>> 0;
    } : function(M, D) {
      return D;
    }, H(d2, { name: p, fromWireType: O, toWireType: b, argPackAdvance: 8, readValueFromPointer: Je(p, S2, v2 !== 0), V: null });
  }, b: function(d2, p, b) {
    function v2(O) {
      O >>= 2;
      var L = T;
      return new S2(h2, L[O + 1], L[O]);
    }
    var S2 = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][p];
    b = le(b), H(d2, { name: b, fromWireType: v2, argPackAdvance: 8, readValueFromPointer: v2 }, { ua: true });
  }, o: function(d2, p) {
    p = le(p);
    var b = p === "std::string";
    H(d2, { name: p, fromWireType: function(v2) {
      var S2 = T[v2 >> 2], O = v2 + 4;
      if (b)
        for (var L = O, M = 0; M <= S2; ++M) {
          var D = O + M;
          if (M == S2 || y[D] == 0) {
            if (L = L ? m2(y, L, D - L) : "", N === void 0)
              var N = L;
            else
              N += String.fromCharCode(0), N += L;
            L = D + 1;
          }
        }
      else {
        for (N = Array(S2), M = 0; M < S2; ++M)
          N[M] = String.fromCharCode(y[O + M]);
        N = N.join("");
      }
      return Bt(v2), N;
    }, toWireType: function(v2, S2) {
      S2 instanceof ArrayBuffer && (S2 = new Uint8Array(S2));
      var O, L = typeof S2 == "string";
      if (L || S2 instanceof Uint8Array || S2 instanceof Uint8ClampedArray || S2 instanceof Int8Array || j("Cannot pass non-string to std::string"), b && L) {
        var M = 0;
        for (O = 0; O < S2.length; ++O) {
          var D = S2.charCodeAt(O);
          127 >= D ? M++ : 2047 >= D ? M += 2 : 55296 <= D && 57343 >= D ? (M += 4, ++O) : M += 3;
        }
        O = M;
      } else
        O = S2.length;
      if (M = Bi(4 + O + 1), D = M + 4, T[M >> 2] = O, b && L) {
        if (L = D, D = O + 1, O = y, 0 < D) {
          D = L + D - 1;
          for (var N = 0; N < S2.length; ++N) {
            var $ = S2.charCodeAt(N);
            if (55296 <= $ && 57343 >= $) {
              var V = S2.charCodeAt(++N);
              $ = 65536 + (($ & 1023) << 10) | V & 1023;
            }
            if (127 >= $) {
              if (L >= D)
                break;
              O[L++] = $;
            } else {
              if (2047 >= $) {
                if (L + 1 >= D)
                  break;
                O[L++] = 192 | $ >> 6;
              } else {
                if (65535 >= $) {
                  if (L + 2 >= D)
                    break;
                  O[L++] = 224 | $ >> 12;
                } else {
                  if (L + 3 >= D)
                    break;
                  O[L++] = 240 | $ >> 18, O[L++] = 128 | $ >> 12 & 63;
                }
                O[L++] = 128 | $ >> 6 & 63;
              }
              O[L++] = 128 | $ & 63;
            }
          }
          O[L] = 0;
        }
      } else if (L)
        for (L = 0; L < O; ++L)
          N = S2.charCodeAt(L), 255 < N && (Bt(D), j("String has UTF-16 code units that do not fit in 8 bits")), y[D + L] = N;
      else
        for (L = 0; L < O; ++L)
          y[D + L] = S2[L];
      return v2 !== null && v2.push(Bt, M), M;
    }, argPackAdvance: 8, readValueFromPointer: Pt, V: function(v2) {
      Bt(v2);
    } });
  }, i: function(d2, p, b) {
    if (b = le(b), p === 2)
      var v2 = ft, S2 = vt, O = Xe, L = () => w2, M = 1;
    else
      p === 4 && (v2 = ct, S2 = Ur, O = xr, L = () => T, M = 2);
    H(d2, { name: b, fromWireType: function(D) {
      for (var N = T[D >> 2], $ = L(), V, se = D + 4, Le = 0; Le <= N; ++Le) {
        var pe = D + 4 + Le * p;
        (Le == N || $[pe >> M] == 0) && (se = v2(se, pe - se), V === void 0 ? V = se : (V += String.fromCharCode(0), V += se), se = pe + p);
      }
      return Bt(D), V;
    }, toWireType: function(D, N) {
      typeof N != "string" && j("Cannot pass non-string to C++ string type " + b);
      var $ = O(N), V = Bi(4 + $ + p);
      return T[V >> 2] = $ >> M, S2(N, V + 4, $ + p), D !== null && D.push(Bt, V), V;
    }, argPackAdvance: 8, readValueFromPointer: Pt, V: function(D) {
      Bt(D);
    } });
  }, k: function(d2, p, b, v2, S2, O) {
    Dt[d2] = { name: le(p), fa: He(b, v2), W: He(S2, O), ia: [] };
  }, h: function(d2, p, b, v2, S2, O, L, M, D, N) {
    Dt[d2].ia.push({ oa: le(p), ta: b, ra: He(v2, S2), sa: O, za: L, ya: He(M, D), Aa: N });
  }, C: function(d2, p) {
    p = le(p), H(d2, { va: true, name: p, argPackAdvance: 0, fromWireType: function() {
    }, toWireType: function() {
    } });
  }, s: function(d2, p, b, v2, S2) {
    d2 = sr[d2], p = Ee(p), b = qr(b);
    var O = [];
    return T[v2 >> 2] = Ie(O), d2(p, b, O, S2);
  }, t: function(d2, p, b, v2) {
    d2 = sr[d2], p = Ee(p), b = qr(b), d2(p, b, null, v2);
  }, g: Se, m: function(d2, p) {
    var b = Kc(d2, p), v2 = b[0];
    p = v2.name + "_$" + b.slice(1).map(function(L) {
      return L.name;
    }).join("_") + "$";
    var S2 = xa[p];
    if (S2 !== void 0)
      return S2;
    var O = Array(d2 - 1);
    return S2 = Xc((L, M, D, N) => {
      for (var $ = 0, V = 0; V < d2 - 1; ++V)
        O[V] = b[V + 1].readValueFromPointer(N + $), $ += b[V + 1].argPackAdvance;
      for (L = L[M].apply(L, O), V = 0; V < d2 - 1; ++V)
        b[V + 1].ma && b[V + 1].ma(O[V]);
      if (!v2.va)
        return v2.toWireType(D, L);
    }), xa[p] = S2;
  }, D: function(d2) {
    4 < d2 && (ne[d2].ga += 1);
  }, r: function(d2) {
    var p = Ee(d2);
    yr(p), Se(d2);
  }, c: function() {
    Me("");
  }, x: function(d2, p, b) {
    y.copyWithin(d2, p, p + b);
  }, w: function(d2) {
    var p = y.length;
    if (d2 >>>= 0, 2147483648 < d2)
      return false;
    for (var b = 1; 4 >= b; b *= 2) {
      var v2 = p * (1 + 0.2 / b);
      v2 = Math.min(v2, d2 + 100663296);
      var S2 = Math;
      v2 = Math.max(d2, v2), S2 = S2.min.call(S2, 2147483648, v2 + (65536 - v2 % 65536) % 65536);
      e: {
        try {
          f.grow(S2 - h2.byteLength + 65535 >>> 16), _();
          var O = 1;
          break e;
        } catch {
        }
        O = void 0;
      }
      if (O)
        return true;
    }
    return false;
  }, z: function() {
    return 52;
  }, u: function() {
    return 70;
  }, y: function(d2, p, b, v2) {
    for (var S2 = 0, O = 0; O < b; O++) {
      var L = T[p >> 2], M = T[p + 4 >> 2];
      p += 8;
      for (var D = 0; D < M; D++) {
        var N = y[L + D], $ = Qc[d2];
        N === 0 || N === 10 ? ((d2 === 1 ? s : a)(m2($, 0)), $.length = 0) : $.push(N);
      }
      S2 += M;
    }
    return T[v2 >> 2] = S2, 0;
  } };
  (function() {
    function d2(S2) {
      t.asm = S2.exports, f = t.asm.E, _(), R2 = t.asm.J, z.unshift(t.asm.F), te--, t.monitorRunDependencies && t.monitorRunDependencies(te), te == 0 && (he !== null && (clearInterval(he), he = null), de && (S2 = de, de = null, S2()));
    }
    function p(S2) {
      d2(S2.instance);
    }
    function b(S2) {
      return me().then(function(O) {
        return O instanceof WebAssembly.Instance ? O : WebAssembly.instantiate(O, v2);
      }).then(function(O) {
        return O;
      }).then(S2, function(O) {
        a("failed to asynchronously prepare wasm: " + O), Me(O);
      });
    }
    var v2 = { a: Zc };
    if (te++, t.monitorRunDependencies && t.monitorRunDependencies(te), t.instantiateWasm)
      try {
        return t.instantiateWasm(v2, d2);
      } catch (S2) {
        a("Module.instantiateWasm callback failed with error: " + S2), n(S2);
      }
    return function() {
      return u2 || typeof WebAssembly.instantiateStreaming != "function" || Re(Oe) || typeof fetch != "function" ? b(p) : fetch(Oe, { credentials: "same-origin" }).then(function(S2) {
        return WebAssembly.instantiateStreaming(S2, v2).then(p, function(O) {
          return a("wasm streaming compile failed: " + O), a("falling back to ArrayBuffer instantiation"), b(p);
        });
      });
    }().catch(n), {};
  })(), t.___wasm_call_ctors = function() {
    return (t.___wasm_call_ctors = t.asm.F).apply(null, arguments);
  };
  var Sa = t.___getTypeName = function() {
    return (Sa = t.___getTypeName = t.asm.G).apply(null, arguments);
  };
  t.__embind_initialize_bindings = function() {
    return (t.__embind_initialize_bindings = t.asm.H).apply(null, arguments);
  };
  var Bi = t._malloc = function() {
    return (Bi = t._malloc = t.asm.I).apply(null, arguments);
  }, Bt = t._free = function() {
    return (Bt = t._free = t.asm.K).apply(null, arguments);
  };
  t.dynCall_jiji = function() {
    return (t.dynCall_jiji = t.asm.L).apply(null, arguments);
  };
  var qn;
  de = function d2() {
    qn || _a3(), qn || (de = d2);
  };
  function _a3() {
    function d2() {
      if (!qn && (qn = true, t.calledRun = true, !c2)) {
        if (rt(z), r(t), t.onRuntimeInitialized && t.onRuntimeInitialized(), t.postRun)
          for (typeof t.postRun == "function" && (t.postRun = [t.postRun]); t.postRun.length; ) {
            var p = t.postRun.shift();
            G.unshift(p);
          }
        rt(G);
      }
    }
    if (!(0 < te)) {
      if (t.preRun)
        for (typeof t.preRun == "function" && (t.preRun = [t.preRun]); t.preRun.length; )
          ie();
      rt(C), 0 < te || (t.setStatus ? (t.setStatus("Running..."), setTimeout(function() {
        setTimeout(function() {
          t.setStatus("");
        }, 1), d2();
      }, 1)) : d2());
    }
  }
  if (t.preInit)
    for (typeof t.preInit == "function" && (t.preInit = [t.preInit]); 0 < t.preInit.length; )
      t.preInit.pop()();
  return _a3(), e.ready;
}
var Qa;
var Za = ar(() => {
  Qa = "";
});
async function eu(e) {
  let { default: t } = await Promise.resolve().then(() => (Za(), Ja));
  return Ji(await t(e));
}
var tu = ar(() => {
  Ka();
  Xn();
});
var eo = {};
Gn(eo, { getYoga: () => Rd, init: () => Od });
async function Pd(e, t) {
  let r;
  if (typeof e == "string" || typeof Request == "function" && e instanceof Request || typeof URL == "function" && e instanceof URL ? r = await fetch(e) : r = await e, typeof Response == "function" && r instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming == "function")
      try {
        return await WebAssembly.instantiateStreaming(r, t);
      } catch (o) {
        r.headers.get("Content-Type") !== "application/wasm" && console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", o);
      }
    let i = await r.arrayBuffer();
    return await WebAssembly.instantiate(i, t);
  }
  let n = await WebAssembly.instantiate("buffer" in r ? r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) : r, t);
  return n instanceof WebAssembly.Instance ? { instance: n, module: r } : n;
}
function Od(e) {
  Ed({ instantiateWasm(t, r) {
    return Pd(e, t).then(({ instance: n }) => {
      r(n);
    }).catch(Zi), {};
  } }).then(ru).catch(Zi);
}
function Rd() {
  return kd;
}
var Ed;
var ru;
var Zi;
var kd;
var to = ar(() => {
  tu();
  Ed = eu, kd = new Promise((e, t) => {
    ru = e, Zi = t;
  });
});
var Lo = q((Co) => {
  "use strict";
  Object.defineProperty(Co, "__esModule", { value: true });
  Object.defineProperty(Co, "default", { enumerable: true, get: () => fh });
  function fh(e) {
    if (e = `${e}`, e === "0")
      return "0";
    if (/^[+-]?(\d+|\d*\.\d+)(e[+-]?\d+)?(%|\w+)?$/.test(e))
      return e.replace(/^[+-]?/, (t) => t === "-" ? "" : "-");
    if (e.includes("var(") || e.includes("calc("))
      return `calc(${e} * -1)`;
  }
});
var cl = q((Mo) => {
  "use strict";
  Object.defineProperty(Mo, "__esModule", { value: true });
  Object.defineProperty(Mo, "default", { enumerable: true, get: () => ch });
  var ch = ["preflight", "container", "accessibility", "pointerEvents", "visibility", "position", "inset", "isolation", "zIndex", "order", "gridColumn", "gridColumnStart", "gridColumnEnd", "gridRow", "gridRowStart", "gridRowEnd", "float", "clear", "margin", "boxSizing", "display", "aspectRatio", "height", "maxHeight", "minHeight", "width", "minWidth", "maxWidth", "flex", "flexShrink", "flexGrow", "flexBasis", "tableLayout", "borderCollapse", "borderSpacing", "transformOrigin", "translate", "rotate", "skew", "scale", "transform", "animation", "cursor", "touchAction", "userSelect", "resize", "scrollSnapType", "scrollSnapAlign", "scrollSnapStop", "scrollMargin", "scrollPadding", "listStylePosition", "listStyleType", "appearance", "columns", "breakBefore", "breakInside", "breakAfter", "gridAutoColumns", "gridAutoFlow", "gridAutoRows", "gridTemplateColumns", "gridTemplateRows", "flexDirection", "flexWrap", "placeContent", "placeItems", "alignContent", "alignItems", "justifyContent", "justifyItems", "gap", "space", "divideWidth", "divideStyle", "divideColor", "divideOpacity", "placeSelf", "alignSelf", "justifySelf", "overflow", "overscrollBehavior", "scrollBehavior", "textOverflow", "whitespace", "wordBreak", "borderRadius", "borderWidth", "borderStyle", "borderColor", "borderOpacity", "backgroundColor", "backgroundOpacity", "backgroundImage", "gradientColorStops", "boxDecorationBreak", "backgroundSize", "backgroundAttachment", "backgroundClip", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "fill", "stroke", "strokeWidth", "objectFit", "objectPosition", "padding", "textAlign", "textIndent", "verticalAlign", "fontFamily", "fontSize", "fontWeight", "textTransform", "fontStyle", "fontVariantNumeric", "lineHeight", "letterSpacing", "textColor", "textOpacity", "textDecoration", "textDecorationColor", "textDecorationStyle", "textDecorationThickness", "textUnderlineOffset", "fontSmoothing", "placeholderColor", "placeholderOpacity", "caretColor", "accentColor", "opacity", "backgroundBlendMode", "mixBlendMode", "boxShadow", "boxShadowColor", "outlineStyle", "outlineWidth", "outlineOffset", "outlineColor", "ringWidth", "ringColor", "ringOpacity", "ringOffsetWidth", "ringOffsetColor", "blur", "brightness", "contrast", "dropShadow", "grayscale", "hueRotate", "invert", "saturate", "sepia", "filter", "backdropBlur", "backdropBrightness", "backdropContrast", "backdropGrayscale", "backdropHueRotate", "backdropInvert", "backdropOpacity", "backdropSaturate", "backdropSepia", "backdropFilter", "transitionProperty", "transitionDelay", "transitionDuration", "transitionTimingFunction", "willChange", "content"];
});
var dl = q((Fo) => {
  "use strict";
  Object.defineProperty(Fo, "__esModule", { value: true });
  Object.defineProperty(Fo, "default", { enumerable: true, get: () => dh });
  function dh(e, t) {
    return e === void 0 ? t : Array.isArray(e) ? e : [...new Set(t.filter((n) => e !== false && e[n] !== false).concat(Object.keys(e).filter((n) => e[n] !== false)))];
  }
});
var No = q((Nw, pl) => {
  pl.exports = { content: [], presets: [], darkMode: "media", theme: { screens: { sm: "640px", md: "768px", lg: "1024px", xl: "1280px", "2xl": "1536px" }, colors: ({ colors: e }) => ({ inherit: e.inherit, current: e.current, transparent: e.transparent, black: e.black, white: e.white, slate: e.slate, gray: e.gray, zinc: e.zinc, neutral: e.neutral, stone: e.stone, red: e.red, orange: e.orange, amber: e.amber, yellow: e.yellow, lime: e.lime, green: e.green, emerald: e.emerald, teal: e.teal, cyan: e.cyan, sky: e.sky, blue: e.blue, indigo: e.indigo, violet: e.violet, purple: e.purple, fuchsia: e.fuchsia, pink: e.pink, rose: e.rose }), columns: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", "3xs": "16rem", "2xs": "18rem", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem" }, spacing: { px: "1px", 0: "0px", 0.5: "0.125rem", 1: "0.25rem", 1.5: "0.375rem", 2: "0.5rem", 2.5: "0.625rem", 3: "0.75rem", 3.5: "0.875rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 7: "1.75rem", 8: "2rem", 9: "2.25rem", 10: "2.5rem", 11: "2.75rem", 12: "3rem", 14: "3.5rem", 16: "4rem", 20: "5rem", 24: "6rem", 28: "7rem", 32: "8rem", 36: "9rem", 40: "10rem", 44: "11rem", 48: "12rem", 52: "13rem", 56: "14rem", 60: "15rem", 64: "16rem", 72: "18rem", 80: "20rem", 96: "24rem" }, animation: { none: "none", spin: "spin 1s linear infinite", ping: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite", pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite", bounce: "bounce 1s infinite" }, aspectRatio: { auto: "auto", square: "1 / 1", video: "16 / 9" }, backdropBlur: ({ theme: e }) => e("blur"), backdropBrightness: ({ theme: e }) => e("brightness"), backdropContrast: ({ theme: e }) => e("contrast"), backdropGrayscale: ({ theme: e }) => e("grayscale"), backdropHueRotate: ({ theme: e }) => e("hueRotate"), backdropInvert: ({ theme: e }) => e("invert"), backdropOpacity: ({ theme: e }) => e("opacity"), backdropSaturate: ({ theme: e }) => e("saturate"), backdropSepia: ({ theme: e }) => e("sepia"), backgroundColor: ({ theme: e }) => e("colors"), backgroundImage: { none: "none", "gradient-to-t": "linear-gradient(to top, var(--tw-gradient-stops))", "gradient-to-tr": "linear-gradient(to top right, var(--tw-gradient-stops))", "gradient-to-r": "linear-gradient(to right, var(--tw-gradient-stops))", "gradient-to-br": "linear-gradient(to bottom right, var(--tw-gradient-stops))", "gradient-to-b": "linear-gradient(to bottom, var(--tw-gradient-stops))", "gradient-to-bl": "linear-gradient(to bottom left, var(--tw-gradient-stops))", "gradient-to-l": "linear-gradient(to left, var(--tw-gradient-stops))", "gradient-to-tl": "linear-gradient(to top left, var(--tw-gradient-stops))" }, backgroundOpacity: ({ theme: e }) => e("opacity"), backgroundPosition: { bottom: "bottom", center: "center", left: "left", "left-bottom": "left bottom", "left-top": "left top", right: "right", "right-bottom": "right bottom", "right-top": "right top", top: "top" }, backgroundSize: { auto: "auto", cover: "cover", contain: "contain" }, blur: { 0: "0", none: "0", sm: "4px", DEFAULT: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "40px", "3xl": "64px" }, brightness: { 0: "0", 50: ".5", 75: ".75", 90: ".9", 95: ".95", 100: "1", 105: "1.05", 110: "1.1", 125: "1.25", 150: "1.5", 200: "2" }, borderColor: ({ theme: e }) => ({ ...e("colors"), DEFAULT: e("colors.gray.200", "currentColor") }), borderOpacity: ({ theme: e }) => e("opacity"), borderRadius: { none: "0px", sm: "0.125rem", DEFAULT: "0.25rem", md: "0.375rem", lg: "0.5rem", xl: "0.75rem", "2xl": "1rem", "3xl": "1.5rem", full: "9999px" }, borderSpacing: ({ theme: e }) => ({ ...e("spacing") }), borderWidth: { DEFAULT: "1px", 0: "0px", 2: "2px", 4: "4px", 8: "8px" }, boxShadow: { sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)", DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)", md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)", lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)", xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)", "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)", inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)", none: "none" }, boxShadowColor: ({ theme: e }) => e("colors"), caretColor: ({ theme: e }) => e("colors"), accentColor: ({ theme: e }) => ({ ...e("colors"), auto: "auto" }), contrast: { 0: "0", 50: ".5", 75: ".75", 100: "1", 125: "1.25", 150: "1.5", 200: "2" }, container: {}, content: { none: "none" }, cursor: { auto: "auto", default: "default", pointer: "pointer", wait: "wait", text: "text", move: "move", help: "help", "not-allowed": "not-allowed", none: "none", "context-menu": "context-menu", progress: "progress", cell: "cell", crosshair: "crosshair", "vertical-text": "vertical-text", alias: "alias", copy: "copy", "no-drop": "no-drop", grab: "grab", grabbing: "grabbing", "all-scroll": "all-scroll", "col-resize": "col-resize", "row-resize": "row-resize", "n-resize": "n-resize", "e-resize": "e-resize", "s-resize": "s-resize", "w-resize": "w-resize", "ne-resize": "ne-resize", "nw-resize": "nw-resize", "se-resize": "se-resize", "sw-resize": "sw-resize", "ew-resize": "ew-resize", "ns-resize": "ns-resize", "nesw-resize": "nesw-resize", "nwse-resize": "nwse-resize", "zoom-in": "zoom-in", "zoom-out": "zoom-out" }, divideColor: ({ theme: e }) => e("borderColor"), divideOpacity: ({ theme: e }) => e("borderOpacity"), divideWidth: ({ theme: e }) => e("borderWidth"), dropShadow: { sm: "0 1px 1px rgb(0 0 0 / 0.05)", DEFAULT: ["0 1px 2px rgb(0 0 0 / 0.1)", "0 1px 1px rgb(0 0 0 / 0.06)"], md: ["0 4px 3px rgb(0 0 0 / 0.07)", "0 2px 2px rgb(0 0 0 / 0.06)"], lg: ["0 10px 8px rgb(0 0 0 / 0.04)", "0 4px 3px rgb(0 0 0 / 0.1)"], xl: ["0 20px 13px rgb(0 0 0 / 0.03)", "0 8px 5px rgb(0 0 0 / 0.08)"], "2xl": "0 25px 25px rgb(0 0 0 / 0.15)", none: "0 0 #0000" }, fill: ({ theme: e }) => e("colors"), grayscale: { 0: "0", DEFAULT: "100%" }, hueRotate: { 0: "0deg", 15: "15deg", 30: "30deg", 60: "60deg", 90: "90deg", 180: "180deg" }, invert: { 0: "0", DEFAULT: "100%" }, flex: { 1: "1 1 0%", auto: "1 1 auto", initial: "0 1 auto", none: "none" }, flexBasis: ({ theme: e }) => ({ auto: "auto", ...e("spacing"), "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%", "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%", "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%", "10/12": "83.333333%", "11/12": "91.666667%", full: "100%" }), flexGrow: { 0: "0", DEFAULT: "1" }, flexShrink: { 0: "0", DEFAULT: "1" }, fontFamily: { sans: ["ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", '"Noto Sans"', "sans-serif", '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'], serif: ["ui-serif", "Georgia", "Cambria", '"Times New Roman"', "Times", "serif"], mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", '"Liberation Mono"', '"Courier New"', "monospace"] }, fontSize: { xs: ["0.75rem", { lineHeight: "1rem" }], sm: ["0.875rem", { lineHeight: "1.25rem" }], base: ["1rem", { lineHeight: "1.5rem" }], lg: ["1.125rem", { lineHeight: "1.75rem" }], xl: ["1.25rem", { lineHeight: "1.75rem" }], "2xl": ["1.5rem", { lineHeight: "2rem" }], "3xl": ["1.875rem", { lineHeight: "2.25rem" }], "4xl": ["2.25rem", { lineHeight: "2.5rem" }], "5xl": ["3rem", { lineHeight: "1" }], "6xl": ["3.75rem", { lineHeight: "1" }], "7xl": ["4.5rem", { lineHeight: "1" }], "8xl": ["6rem", { lineHeight: "1" }], "9xl": ["8rem", { lineHeight: "1" }] }, fontWeight: { thin: "100", extralight: "200", light: "300", normal: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900" }, gap: ({ theme: e }) => e("spacing"), gradientColorStops: ({ theme: e }) => e("colors"), gridAutoColumns: { auto: "auto", min: "min-content", max: "max-content", fr: "minmax(0, 1fr)" }, gridAutoRows: { auto: "auto", min: "min-content", max: "max-content", fr: "minmax(0, 1fr)" }, gridColumn: { auto: "auto", "span-1": "span 1 / span 1", "span-2": "span 2 / span 2", "span-3": "span 3 / span 3", "span-4": "span 4 / span 4", "span-5": "span 5 / span 5", "span-6": "span 6 / span 6", "span-7": "span 7 / span 7", "span-8": "span 8 / span 8", "span-9": "span 9 / span 9", "span-10": "span 10 / span 10", "span-11": "span 11 / span 11", "span-12": "span 12 / span 12", "span-full": "1 / -1" }, gridColumnEnd: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13" }, gridColumnStart: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12", 13: "13" }, gridRow: { auto: "auto", "span-1": "span 1 / span 1", "span-2": "span 2 / span 2", "span-3": "span 3 / span 3", "span-4": "span 4 / span 4", "span-5": "span 5 / span 5", "span-6": "span 6 / span 6", "span-full": "1 / -1" }, gridRowStart: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7" }, gridRowEnd: { auto: "auto", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7" }, gridTemplateColumns: { none: "none", 1: "repeat(1, minmax(0, 1fr))", 2: "repeat(2, minmax(0, 1fr))", 3: "repeat(3, minmax(0, 1fr))", 4: "repeat(4, minmax(0, 1fr))", 5: "repeat(5, minmax(0, 1fr))", 6: "repeat(6, minmax(0, 1fr))", 7: "repeat(7, minmax(0, 1fr))", 8: "repeat(8, minmax(0, 1fr))", 9: "repeat(9, minmax(0, 1fr))", 10: "repeat(10, minmax(0, 1fr))", 11: "repeat(11, minmax(0, 1fr))", 12: "repeat(12, minmax(0, 1fr))" }, gridTemplateRows: { none: "none", 1: "repeat(1, minmax(0, 1fr))", 2: "repeat(2, minmax(0, 1fr))", 3: "repeat(3, minmax(0, 1fr))", 4: "repeat(4, minmax(0, 1fr))", 5: "repeat(5, minmax(0, 1fr))", 6: "repeat(6, minmax(0, 1fr))" }, height: ({ theme: e }) => ({ auto: "auto", ...e("spacing"), "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", full: "100%", screen: "100vh", min: "min-content", max: "max-content", fit: "fit-content" }), inset: ({ theme: e }) => ({ auto: "auto", ...e("spacing"), "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", full: "100%" }), keyframes: { spin: { to: { transform: "rotate(360deg)" } }, ping: { "75%, 100%": { transform: "scale(2)", opacity: "0" } }, pulse: { "50%": { opacity: ".5" } }, bounce: { "0%, 100%": { transform: "translateY(-25%)", animationTimingFunction: "cubic-bezier(0.8,0,1,1)" }, "50%": { transform: "none", animationTimingFunction: "cubic-bezier(0,0,0.2,1)" } } }, letterSpacing: { tighter: "-0.05em", tight: "-0.025em", normal: "0em", wide: "0.025em", wider: "0.05em", widest: "0.1em" }, lineHeight: { none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2", 3: ".75rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 7: "1.75rem", 8: "2rem", 9: "2.25rem", 10: "2.5rem" }, listStyleType: { none: "none", disc: "disc", decimal: "decimal" }, margin: ({ theme: e }) => ({ auto: "auto", ...e("spacing") }), maxHeight: ({ theme: e }) => ({ ...e("spacing"), full: "100%", screen: "100vh", min: "min-content", max: "max-content", fit: "fit-content" }), maxWidth: ({ theme: e, breakpoints: t }) => ({ none: "none", 0: "0rem", xs: "20rem", sm: "24rem", md: "28rem", lg: "32rem", xl: "36rem", "2xl": "42rem", "3xl": "48rem", "4xl": "56rem", "5xl": "64rem", "6xl": "72rem", "7xl": "80rem", full: "100%", min: "min-content", max: "max-content", fit: "fit-content", prose: "65ch", ...t(e("screens")) }), minHeight: { 0: "0px", full: "100%", screen: "100vh", min: "min-content", max: "max-content", fit: "fit-content" }, minWidth: { 0: "0px", full: "100%", min: "min-content", max: "max-content", fit: "fit-content" }, objectPosition: { bottom: "bottom", center: "center", left: "left", "left-bottom": "left bottom", "left-top": "left top", right: "right", "right-bottom": "right bottom", "right-top": "right top", top: "top" }, opacity: { 0: "0", 5: "0.05", 10: "0.1", 20: "0.2", 25: "0.25", 30: "0.3", 40: "0.4", 50: "0.5", 60: "0.6", 70: "0.7", 75: "0.75", 80: "0.8", 90: "0.9", 95: "0.95", 100: "1" }, order: { first: "-9999", last: "9999", none: "0", 1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "11", 12: "12" }, padding: ({ theme: e }) => e("spacing"), placeholderColor: ({ theme: e }) => e("colors"), placeholderOpacity: ({ theme: e }) => e("opacity"), outlineColor: ({ theme: e }) => e("colors"), outlineOffset: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, outlineWidth: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, ringColor: ({ theme: e }) => ({ DEFAULT: e("colors.blue.500", "#3b82f6"), ...e("colors") }), ringOffsetColor: ({ theme: e }) => e("colors"), ringOffsetWidth: { 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, ringOpacity: ({ theme: e }) => ({ DEFAULT: "0.5", ...e("opacity") }), ringWidth: { DEFAULT: "3px", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, rotate: { 0: "0deg", 1: "1deg", 2: "2deg", 3: "3deg", 6: "6deg", 12: "12deg", 45: "45deg", 90: "90deg", 180: "180deg" }, saturate: { 0: "0", 50: ".5", 100: "1", 150: "1.5", 200: "2" }, scale: { 0: "0", 50: ".5", 75: ".75", 90: ".9", 95: ".95", 100: "1", 105: "1.05", 110: "1.1", 125: "1.25", 150: "1.5" }, scrollMargin: ({ theme: e }) => ({ ...e("spacing") }), scrollPadding: ({ theme: e }) => e("spacing"), sepia: { 0: "0", DEFAULT: "100%" }, skew: { 0: "0deg", 1: "1deg", 2: "2deg", 3: "3deg", 6: "6deg", 12: "12deg" }, space: ({ theme: e }) => ({ ...e("spacing") }), stroke: ({ theme: e }) => e("colors"), strokeWidth: { 0: "0", 1: "1", 2: "2" }, textColor: ({ theme: e }) => e("colors"), textDecorationColor: ({ theme: e }) => e("colors"), textDecorationThickness: { auto: "auto", "from-font": "from-font", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, textUnderlineOffset: { auto: "auto", 0: "0px", 1: "1px", 2: "2px", 4: "4px", 8: "8px" }, textIndent: ({ theme: e }) => ({ ...e("spacing") }), textOpacity: ({ theme: e }) => e("opacity"), transformOrigin: { center: "center", top: "top", "top-right": "top right", right: "right", "bottom-right": "bottom right", bottom: "bottom", "bottom-left": "bottom left", left: "left", "top-left": "top left" }, transitionDelay: { 75: "75ms", 100: "100ms", 150: "150ms", 200: "200ms", 300: "300ms", 500: "500ms", 700: "700ms", 1e3: "1000ms" }, transitionDuration: { DEFAULT: "150ms", 75: "75ms", 100: "100ms", 150: "150ms", 200: "200ms", 300: "300ms", 500: "500ms", 700: "700ms", 1e3: "1000ms" }, transitionProperty: { none: "none", all: "all", DEFAULT: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter", colors: "color, background-color, border-color, text-decoration-color, fill, stroke", opacity: "opacity", shadow: "box-shadow", transform: "transform" }, transitionTimingFunction: { DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)", linear: "linear", in: "cubic-bezier(0.4, 0, 1, 1)", out: "cubic-bezier(0, 0, 0.2, 1)", "in-out": "cubic-bezier(0.4, 0, 0.2, 1)" }, translate: ({ theme: e }) => ({ ...e("spacing"), "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", full: "100%" }), width: ({ theme: e }) => ({ auto: "auto", ...e("spacing"), "1/2": "50%", "1/3": "33.333333%", "2/3": "66.666667%", "1/4": "25%", "2/4": "50%", "3/4": "75%", "1/5": "20%", "2/5": "40%", "3/5": "60%", "4/5": "80%", "1/6": "16.666667%", "2/6": "33.333333%", "3/6": "50%", "4/6": "66.666667%", "5/6": "83.333333%", "1/12": "8.333333%", "2/12": "16.666667%", "3/12": "25%", "4/12": "33.333333%", "5/12": "41.666667%", "6/12": "50%", "7/12": "58.333333%", "8/12": "66.666667%", "9/12": "75%", "10/12": "83.333333%", "11/12": "91.666667%", full: "100%", screen: "100vw", min: "min-content", max: "max-content", fit: "fit-content" }), willChange: { auto: "auto", scroll: "scroll-position", contents: "contents", transform: "transform" }, zIndex: { auto: "auto", 0: "0", 10: "10", 20: "20", 30: "30", 40: "40", 50: "50" } }, variantOrder: ["first", "last", "odd", "even", "visited", "checked", "empty", "read-only", "group-hover", "group-focus", "focus-within", "hover", "focus", "focus-visible", "active", "disabled"], plugins: [] };
});
var xi = {};
Gn(xi, { default: () => ph });
var ph;
var wi = ar(() => {
  ph = { info(e, t) {
    console.info(...Array.isArray(e) ? [e] : [t, e]);
  }, warn(e, t) {
    console.warn(...Array.isArray(e) ? [e] : [t, e]);
  }, risk(e, t) {
    console.error(...Array.isArray(e) ? [e] : [t, e]);
  } };
});
var hl = q((Do) => {
  "use strict";
  Object.defineProperty(Do, "__esModule", { value: true });
  Object.defineProperty(Do, "default", { enumerable: true, get: () => gh });
  var hh = mh((wi(), jn(xi)));
  function mh(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function nn({ version: e, from: t, to: r }) {
    hh.default.warn(`${t}-color-renamed`, [`As of Tailwind CSS ${e}, \`${t}\` has been renamed to \`${r}\`.`, "Update your configuration file to silence this warning."]);
  }
  var gh = { inherit: "inherit", current: "currentColor", transparent: "transparent", black: "#000", white: "#fff", slate: { 50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0", 300: "#cbd5e1", 400: "#94a3b8", 500: "#64748b", 600: "#475569", 700: "#334155", 800: "#1e293b", 900: "#0f172a" }, gray: { 50: "#f9fafb", 100: "#f3f4f6", 200: "#e5e7eb", 300: "#d1d5db", 400: "#9ca3af", 500: "#6b7280", 600: "#4b5563", 700: "#374151", 800: "#1f2937", 900: "#111827" }, zinc: { 50: "#fafafa", 100: "#f4f4f5", 200: "#e4e4e7", 300: "#d4d4d8", 400: "#a1a1aa", 500: "#71717a", 600: "#52525b", 700: "#3f3f46", 800: "#27272a", 900: "#18181b" }, neutral: { 50: "#fafafa", 100: "#f5f5f5", 200: "#e5e5e5", 300: "#d4d4d4", 400: "#a3a3a3", 500: "#737373", 600: "#525252", 700: "#404040", 800: "#262626", 900: "#171717" }, stone: { 50: "#fafaf9", 100: "#f5f5f4", 200: "#e7e5e4", 300: "#d6d3d1", 400: "#a8a29e", 500: "#78716c", 600: "#57534e", 700: "#44403c", 800: "#292524", 900: "#1c1917" }, red: { 50: "#fef2f2", 100: "#fee2e2", 200: "#fecaca", 300: "#fca5a5", 400: "#f87171", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c", 800: "#991b1b", 900: "#7f1d1d" }, orange: { 50: "#fff7ed", 100: "#ffedd5", 200: "#fed7aa", 300: "#fdba74", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 700: "#c2410c", 800: "#9a3412", 900: "#7c2d12" }, amber: { 50: "#fffbeb", 100: "#fef3c7", 200: "#fde68a", 300: "#fcd34d", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 700: "#b45309", 800: "#92400e", 900: "#78350f" }, yellow: { 50: "#fefce8", 100: "#fef9c3", 200: "#fef08a", 300: "#fde047", 400: "#facc15", 500: "#eab308", 600: "#ca8a04", 700: "#a16207", 800: "#854d0e", 900: "#713f12" }, lime: { 50: "#f7fee7", 100: "#ecfccb", 200: "#d9f99d", 300: "#bef264", 400: "#a3e635", 500: "#84cc16", 600: "#65a30d", 700: "#4d7c0f", 800: "#3f6212", 900: "#365314" }, green: { 50: "#f0fdf4", 100: "#dcfce7", 200: "#bbf7d0", 300: "#86efac", 400: "#4ade80", 500: "#22c55e", 600: "#16a34a", 700: "#15803d", 800: "#166534", 900: "#14532d" }, emerald: { 50: "#ecfdf5", 100: "#d1fae5", 200: "#a7f3d0", 300: "#6ee7b7", 400: "#34d399", 500: "#10b981", 600: "#059669", 700: "#047857", 800: "#065f46", 900: "#064e3b" }, teal: { 50: "#f0fdfa", 100: "#ccfbf1", 200: "#99f6e4", 300: "#5eead4", 400: "#2dd4bf", 500: "#14b8a6", 600: "#0d9488", 700: "#0f766e", 800: "#115e59", 900: "#134e4a" }, cyan: { 50: "#ecfeff", 100: "#cffafe", 200: "#a5f3fc", 300: "#67e8f9", 400: "#22d3ee", 500: "#06b6d4", 600: "#0891b2", 700: "#0e7490", 800: "#155e75", 900: "#164e63" }, sky: { 50: "#f0f9ff", 100: "#e0f2fe", 200: "#bae6fd", 300: "#7dd3fc", 400: "#38bdf8", 500: "#0ea5e9", 600: "#0284c7", 700: "#0369a1", 800: "#075985", 900: "#0c4a6e" }, blue: { 50: "#eff6ff", 100: "#dbeafe", 200: "#bfdbfe", 300: "#93c5fd", 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb", 700: "#1d4ed8", 800: "#1e40af", 900: "#1e3a8a" }, indigo: { 50: "#eef2ff", 100: "#e0e7ff", 200: "#c7d2fe", 300: "#a5b4fc", 400: "#818cf8", 500: "#6366f1", 600: "#4f46e5", 700: "#4338ca", 800: "#3730a3", 900: "#312e81" }, violet: { 50: "#f5f3ff", 100: "#ede9fe", 200: "#ddd6fe", 300: "#c4b5fd", 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9", 800: "#5b21b6", 900: "#4c1d95" }, purple: { 50: "#faf5ff", 100: "#f3e8ff", 200: "#e9d5ff", 300: "#d8b4fe", 400: "#c084fc", 500: "#a855f7", 600: "#9333ea", 700: "#7e22ce", 800: "#6b21a8", 900: "#581c87" }, fuchsia: { 50: "#fdf4ff", 100: "#fae8ff", 200: "#f5d0fe", 300: "#f0abfc", 400: "#e879f9", 500: "#d946ef", 600: "#c026d3", 700: "#a21caf", 800: "#86198f", 900: "#701a75" }, pink: { 50: "#fdf2f8", 100: "#fce7f3", 200: "#fbcfe8", 300: "#f9a8d4", 400: "#f472b6", 500: "#ec4899", 600: "#db2777", 700: "#be185d", 800: "#9d174d", 900: "#831843" }, rose: { 50: "#fff1f2", 100: "#ffe4e6", 200: "#fecdd3", 300: "#fda4af", 400: "#fb7185", 500: "#f43f5e", 600: "#e11d48", 700: "#be123c", 800: "#9f1239", 900: "#881337" }, get lightBlue() {
    return nn({ version: "v2.2", from: "lightBlue", to: "sky" }), this.sky;
  }, get warmGray() {
    return nn({ version: "v3.0", from: "warmGray", to: "stone" }), this.stone;
  }, get trueGray() {
    return nn({ version: "v3.0", from: "trueGray", to: "neutral" }), this.neutral;
  }, get coolGray() {
    return nn({ version: "v3.0", from: "coolGray", to: "gray" }), this.gray;
  }, get blueGray() {
    return nn({ version: "v3.0", from: "blueGray", to: "slate" }), this.slate;
  } };
});
var ml = q((Wo) => {
  "use strict";
  Object.defineProperty(Wo, "__esModule", { value: true });
  Object.defineProperty(Wo, "defaults", { enumerable: true, get: () => bh });
  function bh(e, ...t) {
    for (let i of t) {
      for (let o in i) {
        var r;
        !(e == null || (r = e.hasOwnProperty) === null || r === void 0) && r.call(e, o) || (e[o] = i[o]);
      }
      for (let o of Object.getOwnPropertySymbols(i)) {
        var n;
        !(e == null || (n = e.hasOwnProperty) === null || n === void 0) && n.call(e, o) || (e[o] = i[o]);
      }
    }
    return e;
  }
});
var gl = q(($o) => {
  "use strict";
  Object.defineProperty($o, "__esModule", { value: true });
  Object.defineProperty($o, "toPath", { enumerable: true, get: () => yh });
  function yh(e) {
    if (Array.isArray(e))
      return e;
    let t = e.split("[").length - 1, r = e.split("]").length - 1;
    if (t !== r)
      throw new Error(`Path is invalid. Has unbalanced brackets: ${e}`);
    return e.split(/\.(?![^\[]*\])|[\[\]]/g).filter(Boolean);
  }
});
var yl = q((Bo) => {
  "use strict";
  Object.defineProperty(Bo, "__esModule", { value: true });
  Object.defineProperty(Bo, "normalizeConfig", { enumerable: true, get: () => xh });
  var on = vh((wi(), jn(xi)));
  function bl(e) {
    if (typeof WeakMap != "function")
      return null;
    var t = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap();
    return (bl = function(n) {
      return n ? r : t;
    })(e);
  }
  function vh(e, t) {
    if (!t && e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var r = bl(t);
    if (r && r.has(e))
      return r.get(e);
    var n = {}, i = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var o in e)
      if (o !== "default" && Object.prototype.hasOwnProperty.call(e, o)) {
        var s = i ? Object.getOwnPropertyDescriptor(e, o) : null;
        s && (s.get || s.set) ? Object.defineProperty(n, o, s) : n[o] = e[o];
      }
    return n.default = e, r && r.set(e, n), n;
  }
  function xh(e) {
    if ((() => {
      if (e.purge || !e.content || !Array.isArray(e.content) && !(typeof e.content == "object" && e.content !== null))
        return false;
      if (Array.isArray(e.content))
        return e.content.every((n) => typeof n == "string" ? true : !(typeof (n == null ? void 0 : n.raw) != "string" || n != null && n.extension && typeof (n == null ? void 0 : n.extension) != "string"));
      if (typeof e.content == "object" && e.content !== null) {
        if (Object.keys(e.content).some((n) => !["files", "extract", "transform"].includes(n)))
          return false;
        if (Array.isArray(e.content.files)) {
          if (!e.content.files.every((n) => typeof n == "string" ? true : !(typeof (n == null ? void 0 : n.raw) != "string" || n != null && n.extension && typeof (n == null ? void 0 : n.extension) != "string")))
            return false;
          if (typeof e.content.extract == "object") {
            for (let n of Object.values(e.content.extract))
              if (typeof n != "function")
                return false;
          } else if (!(e.content.extract === void 0 || typeof e.content.extract == "function"))
            return false;
          if (typeof e.content.transform == "object") {
            for (let n of Object.values(e.content.transform))
              if (typeof n != "function")
                return false;
          } else if (!(e.content.transform === void 0 || typeof e.content.transform == "function"))
            return false;
        }
        return true;
      }
      return false;
    })() || on.default.warn("purge-deprecation", ["The `purge`/`content` options have changed in Tailwind CSS v3.0.", "Update your configuration file to eliminate this warning.", "https://tailwindcss.com/docs/upgrade-guide#configure-content-sources"]), e.safelist = (() => {
      var n;
      let { content: i, purge: o, safelist: s } = e;
      return Array.isArray(s) ? s : Array.isArray(i == null ? void 0 : i.safelist) ? i.safelist : Array.isArray(o == null ? void 0 : o.safelist) ? o.safelist : Array.isArray(o == null || (n = o.options) === null || n === void 0 ? void 0 : n.safelist) ? o.options.safelist : [];
    })(), typeof e.prefix == "function")
      on.default.warn("prefix-function", ["As of Tailwind CSS v3.0, `prefix` cannot be a function.", "Update `prefix` in your configuration to be a string to eliminate this warning.", "https://tailwindcss.com/docs/upgrade-guide#prefix-cannot-be-a-function"]), e.prefix = "";
    else {
      var r;
      e.prefix = (r = e.prefix) !== null && r !== void 0 ? r : "";
    }
    e.content = { files: (() => {
      let { content: n, purge: i } = e;
      return Array.isArray(i) ? i : Array.isArray(i == null ? void 0 : i.content) ? i.content : Array.isArray(n) ? n : Array.isArray(n == null ? void 0 : n.content) ? n.content : Array.isArray(n == null ? void 0 : n.files) ? n.files : [];
    })(), extract: (() => {
      let n = (() => {
        var s, a, u2, l2, f, c2, m2, h2, g2, y;
        return !((s = e.purge) === null || s === void 0) && s.extract ? e.purge.extract : !((a = e.content) === null || a === void 0) && a.extract ? e.content.extract : !((u2 = e.purge) === null || u2 === void 0 || (l2 = u2.extract) === null || l2 === void 0) && l2.DEFAULT ? e.purge.extract.DEFAULT : !((f = e.content) === null || f === void 0 || (c2 = f.extract) === null || c2 === void 0) && c2.DEFAULT ? e.content.extract.DEFAULT : !((m2 = e.purge) === null || m2 === void 0 || (h2 = m2.options) === null || h2 === void 0) && h2.extractors ? e.purge.options.extractors : !((g2 = e.content) === null || g2 === void 0 || (y = g2.options) === null || y === void 0) && y.extractors ? e.content.options.extractors : {};
      })(), i = {}, o = (() => {
        var s, a, u2, l2;
        if (!((s = e.purge) === null || s === void 0 || (a = s.options) === null || a === void 0) && a.defaultExtractor)
          return e.purge.options.defaultExtractor;
        if (!((u2 = e.content) === null || u2 === void 0 || (l2 = u2.options) === null || l2 === void 0) && l2.defaultExtractor)
          return e.content.options.defaultExtractor;
      })();
      if (o !== void 0 && (i.DEFAULT = o), typeof n == "function")
        i.DEFAULT = n;
      else if (Array.isArray(n))
        for (let { extensions: s, extractor: a } of n ?? [])
          for (let u2 of s)
            i[u2] = a;
      else
        typeof n == "object" && n !== null && Object.assign(i, n);
      return i;
    })(), transform: (() => {
      let n = (() => {
        var o, s, a, u2, l2, f;
        return !((o = e.purge) === null || o === void 0) && o.transform ? e.purge.transform : !((s = e.content) === null || s === void 0) && s.transform ? e.content.transform : !((a = e.purge) === null || a === void 0 || (u2 = a.transform) === null || u2 === void 0) && u2.DEFAULT ? e.purge.transform.DEFAULT : !((l2 = e.content) === null || l2 === void 0 || (f = l2.transform) === null || f === void 0) && f.DEFAULT ? e.content.transform.DEFAULT : {};
      })(), i = {};
      return typeof n == "function" && (i.DEFAULT = n), typeof n == "object" && n !== null && Object.assign(i, n), i;
    })() };
    for (let n of e.content.files)
      if (typeof n == "string" && /{([^,]*?)}/g.test(n)) {
        on.default.warn("invalid-glob-braces", [`The glob pattern ${(0, on.dim)(n)} in your Tailwind CSS configuration is invalid.`, `Update it to ${(0, on.dim)(n.replace(/{([^,]*?)}/g, "$1"))} to silence this warning.`]);
        break;
      }
    return e;
  }
});
var vl = q((Uo) => {
  "use strict";
  Object.defineProperty(Uo, "__esModule", { value: true });
  Object.defineProperty(Uo, "default", { enumerable: true, get: () => wh });
  function wh(e) {
    if (Object.prototype.toString.call(e) !== "[object Object]")
      return false;
    let t = Object.getPrototypeOf(e);
    return t === null || t === Object.prototype;
  }
});
var xl = q((zo) => {
  "use strict";
  Object.defineProperty(zo, "__esModule", { value: true });
  Object.defineProperty(zo, "cloneDeep", { enumerable: true, get: () => qo });
  function qo(e) {
    return Array.isArray(e) ? e.map((t) => qo(t)) : typeof e == "object" && e !== null ? Object.fromEntries(Object.entries(e).map(([t, r]) => [t, qo(r)])) : e;
  }
});
var Go = q((Si, wl) => {
  "use strict";
  Si.__esModule = true;
  Si.default = Th;
  function Sh(e) {
    for (var t = e.toLowerCase(), r = "", n = false, i = 0; i < 6 && t[i] !== void 0; i++) {
      var o = t.charCodeAt(i), s = o >= 97 && o <= 102 || o >= 48 && o <= 57;
      if (n = o === 32, !s)
        break;
      r += t[i];
    }
    if (r.length !== 0) {
      var a = parseInt(r, 16), u2 = a >= 55296 && a <= 57343;
      return u2 || a === 0 || a > 1114111 ? ["\uFFFD", r.length + (n ? 1 : 0)] : [String.fromCodePoint(a), r.length + (n ? 1 : 0)];
    }
  }
  var _h = /\\/;
  function Th(e) {
    var t = _h.test(e);
    if (!t)
      return e;
    for (var r = "", n = 0; n < e.length; n++) {
      if (e[n] === "\\") {
        var i = Sh(e.slice(n + 1, n + 7));
        if (i !== void 0) {
          r += i[0], n += i[1];
          continue;
        }
        if (e[n + 1] === "\\") {
          r += "\\", n++;
          continue;
        }
        e.length === n + 1 && (r += e[n]);
        continue;
      }
      r += e[n];
    }
    return r;
  }
  wl.exports = Si.default;
});
var _l = q((_i, Sl) => {
  "use strict";
  _i.__esModule = true;
  _i.default = Eh;
  function Eh(e) {
    for (var t = arguments.length, r = new Array(t > 1 ? t - 1 : 0), n = 1; n < t; n++)
      r[n - 1] = arguments[n];
    for (; r.length > 0; ) {
      var i = r.shift();
      if (!e[i])
        return;
      e = e[i];
    }
    return e;
  }
  Sl.exports = _i.default;
});
var El = q((Ti, Tl) => {
  "use strict";
  Ti.__esModule = true;
  Ti.default = kh;
  function kh(e) {
    for (var t = arguments.length, r = new Array(t > 1 ? t - 1 : 0), n = 1; n < t; n++)
      r[n - 1] = arguments[n];
    for (; r.length > 0; ) {
      var i = r.shift();
      e[i] || (e[i] = {}), e = e[i];
    }
  }
  Tl.exports = Ti.default;
});
var Pl = q((Ei, kl) => {
  "use strict";
  Ei.__esModule = true;
  Ei.default = Ph;
  function Ph(e) {
    for (var t = "", r = e.indexOf("/*"), n = 0; r >= 0; ) {
      t = t + e.slice(n, r);
      var i = e.indexOf("*/", r + 2);
      if (i < 0)
        return t;
      n = i + 2, r = e.indexOf("/*", n);
    }
    return t = t + e.slice(n), t;
  }
  kl.exports = Ei.default;
});
var sn = q((Ct) => {
  "use strict";
  Ct.__esModule = true;
  Ct.stripComments = Ct.ensureObject = Ct.getProp = Ct.unesc = void 0;
  var Oh = ki(Go());
  Ct.unesc = Oh.default;
  var Rh = ki(_l());
  Ct.getProp = Rh.default;
  var Ah = ki(El());
  Ct.ensureObject = Ah.default;
  var Ih = ki(Pl());
  Ct.stripComments = Ih.default;
  function ki(e) {
    return e && e.__esModule ? e : { default: e };
  }
});
var Ht = q((an, Al) => {
  "use strict";
  an.__esModule = true;
  an.default = void 0;
  var Ol = sn();
  function Rl(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function Ch(e, t, r) {
    return t && Rl(e.prototype, t), r && Rl(e, r), e;
  }
  var Lh = function e(t, r) {
    if (typeof t != "object" || t === null)
      return t;
    var n = new t.constructor();
    for (var i in t)
      if (t.hasOwnProperty(i)) {
        var o = t[i], s = typeof o;
        i === "parent" && s === "object" ? r && (n[i] = r) : o instanceof Array ? n[i] = o.map(function(a) {
          return e(a, n);
        }) : n[i] = e(o, n);
      }
    return n;
  }, Mh = function() {
    function e(r) {
      r === void 0 && (r = {}), Object.assign(this, r), this.spaces = this.spaces || {}, this.spaces.before = this.spaces.before || "", this.spaces.after = this.spaces.after || "";
    }
    var t = e.prototype;
    return t.remove = function() {
      return this.parent && this.parent.removeChild(this), this.parent = void 0, this;
    }, t.replaceWith = function() {
      if (this.parent) {
        for (var n in arguments)
          this.parent.insertBefore(this, arguments[n]);
        this.remove();
      }
      return this;
    }, t.next = function() {
      return this.parent.at(this.parent.index(this) + 1);
    }, t.prev = function() {
      return this.parent.at(this.parent.index(this) - 1);
    }, t.clone = function(n) {
      n === void 0 && (n = {});
      var i = Lh(this);
      for (var o in n)
        i[o] = n[o];
      return i;
    }, t.appendToPropertyAndEscape = function(n, i, o) {
      this.raws || (this.raws = {});
      var s = this[n], a = this.raws[n];
      this[n] = s + i, a || o !== i ? this.raws[n] = (a || s) + o : delete this.raws[n];
    }, t.setPropertyAndEscape = function(n, i, o) {
      this.raws || (this.raws = {}), this[n] = i, this.raws[n] = o;
    }, t.setPropertyWithoutEscape = function(n, i) {
      this[n] = i, this.raws && delete this.raws[n];
    }, t.isAtPosition = function(n, i) {
      if (this.source && this.source.start && this.source.end)
        return !(this.source.start.line > n || this.source.end.line < n || this.source.start.line === n && this.source.start.column > i || this.source.end.line === n && this.source.end.column < i);
    }, t.stringifyProperty = function(n) {
      return this.raws && this.raws[n] || this[n];
    }, t.valueToString = function() {
      return String(this.stringifyProperty("value"));
    }, t.toString = function() {
      return [this.rawSpaceBefore, this.valueToString(), this.rawSpaceAfter].join("");
    }, Ch(e, [{ key: "rawSpaceBefore", get: function() {
      var n = this.raws && this.raws.spaces && this.raws.spaces.before;
      return n === void 0 && (n = this.spaces && this.spaces.before), n || "";
    }, set: function(n) {
      (0, Ol.ensureObject)(this, "raws", "spaces"), this.raws.spaces.before = n;
    } }, { key: "rawSpaceAfter", get: function() {
      var n = this.raws && this.raws.spaces && this.raws.spaces.after;
      return n === void 0 && (n = this.spaces.after), n || "";
    }, set: function(n) {
      (0, Ol.ensureObject)(this, "raws", "spaces"), this.raws.spaces.after = n;
    } }]), e;
  }();
  an.default = Mh;
  Al.exports = an.default;
});
var Ue = q((ve) => {
  "use strict";
  ve.__esModule = true;
  ve.UNIVERSAL = ve.ATTRIBUTE = ve.CLASS = ve.COMBINATOR = ve.COMMENT = ve.ID = ve.NESTING = ve.PSEUDO = ve.ROOT = ve.SELECTOR = ve.STRING = ve.TAG = void 0;
  var Fh = "tag";
  ve.TAG = Fh;
  var Nh = "string";
  ve.STRING = Nh;
  var Dh = "selector";
  ve.SELECTOR = Dh;
  var Wh = "root";
  ve.ROOT = Wh;
  var $h = "pseudo";
  ve.PSEUDO = $h;
  var Bh = "nesting";
  ve.NESTING = Bh;
  var Uh = "id";
  ve.ID = Uh;
  var qh = "comment";
  ve.COMMENT = qh;
  var zh = "combinator";
  ve.COMBINATOR = zh;
  var Gh = "class";
  ve.CLASS = Gh;
  var jh = "attribute";
  ve.ATTRIBUTE = jh;
  var Vh = "universal";
  ve.UNIVERSAL = Vh;
});
var Pi = q((un, Ml) => {
  "use strict";
  un.__esModule = true;
  un.default = void 0;
  var Hh = Xh(Ht()), Yt = Yh(Ue());
  function Ll() {
    if (typeof WeakMap != "function")
      return null;
    var e = /* @__PURE__ */ new WeakMap();
    return Ll = function() {
      return e;
    }, e;
  }
  function Yh(e) {
    if (e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var t = Ll();
    if (t && t.has(e))
      return t.get(e);
    var r = {}, n = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var i in e)
      if (Object.prototype.hasOwnProperty.call(e, i)) {
        var o = n ? Object.getOwnPropertyDescriptor(e, i) : null;
        o && (o.get || o.set) ? Object.defineProperty(r, i, o) : r[i] = e[i];
      }
    return r.default = e, t && t.set(e, r), r;
  }
  function Xh(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Kh(e, t) {
    var r;
    if (typeof Symbol > "u" || e[Symbol.iterator] == null) {
      if (Array.isArray(e) || (r = Qh(e)) || t && e && typeof e.length == "number") {
        r && (e = r);
        var n = 0;
        return function() {
          return n >= e.length ? { done: true } : { done: false, value: e[n++] };
        };
      }
      throw new TypeError(`Invalid attempt to iterate non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
    }
    return r = e[Symbol.iterator](), r.next.bind(r);
  }
  function Qh(e, t) {
    if (e) {
      if (typeof e == "string")
        return Il(e, t);
      var r = Object.prototype.toString.call(e).slice(8, -1);
      if (r === "Object" && e.constructor && (r = e.constructor.name), r === "Map" || r === "Set")
        return Array.from(e);
      if (r === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(r))
        return Il(e, t);
    }
  }
  function Il(e, t) {
    (t == null || t > e.length) && (t = e.length);
    for (var r = 0, n = new Array(t); r < t; r++)
      n[r] = e[r];
    return n;
  }
  function Cl(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function Jh(e, t, r) {
    return t && Cl(e.prototype, t), r && Cl(e, r), e;
  }
  function Zh(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, jo(e, t);
  }
  function jo(e, t) {
    return jo = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, jo(e, t);
  }
  var em = function(e) {
    Zh(t, e);
    function t(n) {
      var i;
      return i = e.call(this, n) || this, i.nodes || (i.nodes = []), i;
    }
    var r = t.prototype;
    return r.append = function(i) {
      return i.parent = this, this.nodes.push(i), this;
    }, r.prepend = function(i) {
      return i.parent = this, this.nodes.unshift(i), this;
    }, r.at = function(i) {
      return this.nodes[i];
    }, r.index = function(i) {
      return typeof i == "number" ? i : this.nodes.indexOf(i);
    }, r.removeChild = function(i) {
      i = this.index(i), this.at(i).parent = void 0, this.nodes.splice(i, 1);
      var o;
      for (var s in this.indexes)
        o = this.indexes[s], o >= i && (this.indexes[s] = o - 1);
      return this;
    }, r.removeAll = function() {
      for (var i = Kh(this.nodes), o; !(o = i()).done; ) {
        var s = o.value;
        s.parent = void 0;
      }
      return this.nodes = [], this;
    }, r.empty = function() {
      return this.removeAll();
    }, r.insertAfter = function(i, o) {
      o.parent = this;
      var s = this.index(i);
      this.nodes.splice(s + 1, 0, o), o.parent = this;
      var a;
      for (var u2 in this.indexes)
        a = this.indexes[u2], s <= a && (this.indexes[u2] = a + 1);
      return this;
    }, r.insertBefore = function(i, o) {
      o.parent = this;
      var s = this.index(i);
      this.nodes.splice(s, 0, o), o.parent = this;
      var a;
      for (var u2 in this.indexes)
        a = this.indexes[u2], a <= s && (this.indexes[u2] = a + 1);
      return this;
    }, r._findChildAtPosition = function(i, o) {
      var s = void 0;
      return this.each(function(a) {
        if (a.atPosition) {
          var u2 = a.atPosition(i, o);
          if (u2)
            return s = u2, false;
        } else if (a.isAtPosition(i, o))
          return s = a, false;
      }), s;
    }, r.atPosition = function(i, o) {
      if (this.isAtPosition(i, o))
        return this._findChildAtPosition(i, o) || this;
    }, r._inferEndPosition = function() {
      this.last && this.last.source && this.last.source.end && (this.source = this.source || {}, this.source.end = this.source.end || {}, Object.assign(this.source.end, this.last.source.end));
    }, r.each = function(i) {
      this.lastEach || (this.lastEach = 0), this.indexes || (this.indexes = {}), this.lastEach++;
      var o = this.lastEach;
      if (this.indexes[o] = 0, !!this.length) {
        for (var s, a; this.indexes[o] < this.length && (s = this.indexes[o], a = i(this.at(s), s), a !== false); )
          this.indexes[o] += 1;
        if (delete this.indexes[o], a === false)
          return false;
      }
    }, r.walk = function(i) {
      return this.each(function(o, s) {
        var a = i(o, s);
        if (a !== false && o.length && (a = o.walk(i)), a === false)
          return false;
      });
    }, r.walkAttributes = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.ATTRIBUTE)
          return i.call(o, s);
      });
    }, r.walkClasses = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.CLASS)
          return i.call(o, s);
      });
    }, r.walkCombinators = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.COMBINATOR)
          return i.call(o, s);
      });
    }, r.walkComments = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.COMMENT)
          return i.call(o, s);
      });
    }, r.walkIds = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.ID)
          return i.call(o, s);
      });
    }, r.walkNesting = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.NESTING)
          return i.call(o, s);
      });
    }, r.walkPseudos = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.PSEUDO)
          return i.call(o, s);
      });
    }, r.walkTags = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.TAG)
          return i.call(o, s);
      });
    }, r.walkUniversals = function(i) {
      var o = this;
      return this.walk(function(s) {
        if (s.type === Yt.UNIVERSAL)
          return i.call(o, s);
      });
    }, r.split = function(i) {
      var o = this, s = [];
      return this.reduce(function(a, u2, l2) {
        var f = i.call(o, u2);
        return s.push(u2), f ? (a.push(s), s = []) : l2 === o.length - 1 && a.push(s), a;
      }, []);
    }, r.map = function(i) {
      return this.nodes.map(i);
    }, r.reduce = function(i, o) {
      return this.nodes.reduce(i, o);
    }, r.every = function(i) {
      return this.nodes.every(i);
    }, r.some = function(i) {
      return this.nodes.some(i);
    }, r.filter = function(i) {
      return this.nodes.filter(i);
    }, r.sort = function(i) {
      return this.nodes.sort(i);
    }, r.toString = function() {
      return this.map(String).join("");
    }, Jh(t, [{ key: "first", get: function() {
      return this.at(0);
    } }, { key: "last", get: function() {
      return this.at(this.length - 1);
    } }, { key: "length", get: function() {
      return this.nodes.length;
    } }]), t;
  }(Hh.default);
  un.default = em;
  Ml.exports = un.default;
});
var Ho = q((ln, Nl) => {
  "use strict";
  ln.__esModule = true;
  ln.default = void 0;
  var tm = nm(Pi()), rm = Ue();
  function nm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Fl(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function im(e, t, r) {
    return t && Fl(e.prototype, t), r && Fl(e, r), e;
  }
  function om(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, Vo(e, t);
  }
  function Vo(e, t) {
    return Vo = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, Vo(e, t);
  }
  var sm = function(e) {
    om(t, e);
    function t(n) {
      var i;
      return i = e.call(this, n) || this, i.type = rm.ROOT, i;
    }
    var r = t.prototype;
    return r.toString = function() {
      var i = this.reduce(function(o, s) {
        return o.push(String(s)), o;
      }, []).join(",");
      return this.trailingComma ? i + "," : i;
    }, r.error = function(i, o) {
      return this._error ? this._error(i, o) : new Error(i);
    }, im(t, [{ key: "errorGenerator", set: function(i) {
      this._error = i;
    } }]), t;
  }(tm.default);
  ln.default = sm;
  Nl.exports = ln.default;
});
var Xo = q((fn, Dl) => {
  "use strict";
  fn.__esModule = true;
  fn.default = void 0;
  var am = lm(Pi()), um = Ue();
  function lm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function fm(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, Yo(e, t);
  }
  function Yo(e, t) {
    return Yo = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, Yo(e, t);
  }
  var cm = function(e) {
    fm(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = um.SELECTOR, n;
    }
    return t;
  }(am.default);
  fn.default = cm;
  Dl.exports = fn.default;
});
var Oi = q((jw, Wl) => {
  "use strict";
  var dm = {}, pm = dm.hasOwnProperty, hm = function(t, r) {
    if (!t)
      return r;
    var n = {};
    for (var i in r)
      n[i] = pm.call(t, i) ? t[i] : r[i];
    return n;
  }, mm = /[ -,\.\/:-@\[-\^`\{-~]/, gm = /[ -,\.\/:-@\[\]\^`\{-~]/, bm = /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g, Ko = function e(t, r) {
    r = hm(r, e.options), r.quotes != "single" && r.quotes != "double" && (r.quotes = "single");
    for (var n = r.quotes == "double" ? '"' : "'", i = r.isIdentifier, o = t.charAt(0), s = "", a = 0, u2 = t.length; a < u2; ) {
      var l2 = t.charAt(a++), f = l2.charCodeAt(), c2 = void 0;
      if (f < 32 || f > 126) {
        if (f >= 55296 && f <= 56319 && a < u2) {
          var m2 = t.charCodeAt(a++);
          (m2 & 64512) == 56320 ? f = ((f & 1023) << 10) + (m2 & 1023) + 65536 : a--;
        }
        c2 = "\\" + f.toString(16).toUpperCase() + " ";
      } else
        r.escapeEverything ? mm.test(l2) ? c2 = "\\" + l2 : c2 = "\\" + f.toString(16).toUpperCase() + " " : /[\t\n\f\r\x0B]/.test(l2) ? c2 = "\\" + f.toString(16).toUpperCase() + " " : l2 == "\\" || !i && (l2 == '"' && n == l2 || l2 == "'" && n == l2) || i && gm.test(l2) ? c2 = "\\" + l2 : c2 = l2;
      s += c2;
    }
    return i && (/^-[-\d]/.test(s) ? s = "\\-" + s.slice(1) : /\d/.test(o) && (s = "\\3" + o + " " + s.slice(1))), s = s.replace(bm, function(h2, g2, y) {
      return g2 && g2.length % 2 ? h2 : (g2 || "") + y;
    }), !i && r.wrap ? n + s + n : s;
  };
  Ko.options = { escapeEverything: false, isIdentifier: false, quotes: "single", wrap: false };
  Ko.version = "3.0.0";
  Wl.exports = Ko;
});
var Jo = q((cn, Ul) => {
  "use strict";
  cn.__esModule = true;
  cn.default = void 0;
  var ym = Bl(Oi()), vm = sn(), xm = Bl(Ht()), wm = Ue();
  function Bl(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function $l(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function Sm(e, t, r) {
    return t && $l(e.prototype, t), r && $l(e, r), e;
  }
  function _m(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, Qo(e, t);
  }
  function Qo(e, t) {
    return Qo = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, Qo(e, t);
  }
  var Tm = function(e) {
    _m(t, e);
    function t(n) {
      var i;
      return i = e.call(this, n) || this, i.type = wm.CLASS, i._constructed = true, i;
    }
    var r = t.prototype;
    return r.valueToString = function() {
      return "." + e.prototype.valueToString.call(this);
    }, Sm(t, [{ key: "value", get: function() {
      return this._value;
    }, set: function(i) {
      if (this._constructed) {
        var o = (0, ym.default)(i, { isIdentifier: true });
        o !== i ? ((0, vm.ensureObject)(this, "raws"), this.raws.value = o) : this.raws && delete this.raws.value;
      }
      this._value = i;
    } }]), t;
  }(xm.default);
  cn.default = Tm;
  Ul.exports = cn.default;
});
var es = q((dn, ql) => {
  "use strict";
  dn.__esModule = true;
  dn.default = void 0;
  var Em = Pm(Ht()), km = Ue();
  function Pm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Om(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, Zo(e, t);
  }
  function Zo(e, t) {
    return Zo = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, Zo(e, t);
  }
  var Rm = function(e) {
    Om(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = km.COMMENT, n;
    }
    return t;
  }(Em.default);
  dn.default = Rm;
  ql.exports = dn.default;
});
var rs = q((pn, zl) => {
  "use strict";
  pn.__esModule = true;
  pn.default = void 0;
  var Am = Cm(Ht()), Im = Ue();
  function Cm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Lm(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, ts(e, t);
  }
  function ts(e, t) {
    return ts = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, ts(e, t);
  }
  var Mm = function(e) {
    Lm(t, e);
    function t(n) {
      var i;
      return i = e.call(this, n) || this, i.type = Im.ID, i;
    }
    var r = t.prototype;
    return r.valueToString = function() {
      return "#" + e.prototype.valueToString.call(this);
    }, t;
  }(Am.default);
  pn.default = Mm;
  zl.exports = pn.default;
});
var Ri = q((hn, Vl) => {
  "use strict";
  hn.__esModule = true;
  hn.default = void 0;
  var Fm = jl(Oi()), Nm = sn(), Dm = jl(Ht());
  function jl(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Gl(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function Wm(e, t, r) {
    return t && Gl(e.prototype, t), r && Gl(e, r), e;
  }
  function $m(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, ns(e, t);
  }
  function ns(e, t) {
    return ns = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, ns(e, t);
  }
  var Bm = function(e) {
    $m(t, e);
    function t() {
      return e.apply(this, arguments) || this;
    }
    var r = t.prototype;
    return r.qualifiedName = function(i) {
      return this.namespace ? this.namespaceString + "|" + i : i;
    }, r.valueToString = function() {
      return this.qualifiedName(e.prototype.valueToString.call(this));
    }, Wm(t, [{ key: "namespace", get: function() {
      return this._namespace;
    }, set: function(i) {
      if (i === true || i === "*" || i === "&") {
        this._namespace = i, this.raws && delete this.raws.namespace;
        return;
      }
      var o = (0, Fm.default)(i, { isIdentifier: true });
      this._namespace = i, o !== i ? ((0, Nm.ensureObject)(this, "raws"), this.raws.namespace = o) : this.raws && delete this.raws.namespace;
    } }, { key: "ns", get: function() {
      return this._namespace;
    }, set: function(i) {
      this.namespace = i;
    } }, { key: "namespaceString", get: function() {
      if (this.namespace) {
        var i = this.stringifyProperty("namespace");
        return i === true ? "" : i;
      } else
        return "";
    } }]), t;
  }(Dm.default);
  hn.default = Bm;
  Vl.exports = hn.default;
});
var os = q((mn, Hl) => {
  "use strict";
  mn.__esModule = true;
  mn.default = void 0;
  var Um = zm(Ri()), qm = Ue();
  function zm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Gm(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, is(e, t);
  }
  function is(e, t) {
    return is = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, is(e, t);
  }
  var jm = function(e) {
    Gm(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = qm.TAG, n;
    }
    return t;
  }(Um.default);
  mn.default = jm;
  Hl.exports = mn.default;
});
var as = q((gn, Yl) => {
  "use strict";
  gn.__esModule = true;
  gn.default = void 0;
  var Vm = Ym(Ht()), Hm = Ue();
  function Ym(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Xm(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, ss(e, t);
  }
  function ss(e, t) {
    return ss = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, ss(e, t);
  }
  var Km = function(e) {
    Xm(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = Hm.STRING, n;
    }
    return t;
  }(Vm.default);
  gn.default = Km;
  Yl.exports = gn.default;
});
var ls = q((bn, Xl) => {
  "use strict";
  bn.__esModule = true;
  bn.default = void 0;
  var Qm = Zm(Pi()), Jm = Ue();
  function Zm(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function e0(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, us(e, t);
  }
  function us(e, t) {
    return us = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, us(e, t);
  }
  var t0 = function(e) {
    e0(t, e);
    function t(n) {
      var i;
      return i = e.call(this, n) || this, i.type = Jm.PSEUDO, i;
    }
    var r = t.prototype;
    return r.toString = function() {
      var i = this.length ? "(" + this.map(String).join(",") + ")" : "";
      return [this.rawSpaceBefore, this.stringifyProperty("value"), i, this.rawSpaceAfter].join("");
    }, t;
  }(Qm.default);
  bn.default = t0;
  Xl.exports = bn.default;
});
var Ql = q((Vw, Kl) => {
  Kl.exports = function(t, r) {
    return function(...n) {
      return console.warn(r), t(...n);
    };
  };
});
var ms = q((xn) => {
  "use strict";
  xn.__esModule = true;
  xn.unescapeValue = hs;
  xn.default = void 0;
  var yn = ps(Oi()), r0 = ps(Go()), n0 = ps(Ri()), i0 = Ue(), fs;
  function ps(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Jl(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function o0(e, t, r) {
    return t && Jl(e.prototype, t), r && Jl(e, r), e;
  }
  function s0(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, ds(e, t);
  }
  function ds(e, t) {
    return ds = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, ds(e, t);
  }
  var vn = Ql(), a0 = /^('|")([^]*)\1$/, u0 = vn(function() {
  }, "Assigning an attribute a value containing characters that might need to be escaped is deprecated. Call attribute.setValue() instead."), l0 = vn(function() {
  }, "Assigning attr.quoted is deprecated and has no effect. Assign to attr.quoteMark instead."), f0 = vn(function() {
  }, "Constructing an Attribute selector with a value without specifying quoteMark is deprecated. Note: The value should be unescaped now.");
  function hs(e) {
    var t = false, r = null, n = e, i = n.match(a0);
    return i && (r = i[1], n = i[2]), n = (0, r0.default)(n), n !== e && (t = true), { deprecatedUsage: t, unescaped: n, quoteMark: r };
  }
  function c0(e) {
    if (e.quoteMark !== void 0 || e.value === void 0)
      return e;
    f0();
    var t = hs(e.value), r = t.quoteMark, n = t.unescaped;
    return e.raws || (e.raws = {}), e.raws.value === void 0 && (e.raws.value = e.value), e.value = n, e.quoteMark = r, e;
  }
  var Ai = function(e) {
    s0(t, e);
    function t(n) {
      var i;
      return n === void 0 && (n = {}), i = e.call(this, c0(n)) || this, i.type = i0.ATTRIBUTE, i.raws = i.raws || {}, Object.defineProperty(i.raws, "unquoted", { get: vn(function() {
        return i.value;
      }, "attr.raws.unquoted is deprecated. Call attr.value instead."), set: vn(function() {
        return i.value;
      }, "Setting attr.raws.unquoted is deprecated and has no effect. attr.value is unescaped by default now.") }), i._constructed = true, i;
    }
    var r = t.prototype;
    return r.getQuotedValue = function(i) {
      i === void 0 && (i = {});
      var o = this._determineQuoteMark(i), s = cs[o], a = (0, yn.default)(this._value, s);
      return a;
    }, r._determineQuoteMark = function(i) {
      return i.smart ? this.smartQuoteMark(i) : this.preferredQuoteMark(i);
    }, r.setValue = function(i, o) {
      o === void 0 && (o = {}), this._value = i, this._quoteMark = this._determineQuoteMark(o), this._syncRawValue();
    }, r.smartQuoteMark = function(i) {
      var o = this.value, s = o.replace(/[^']/g, "").length, a = o.replace(/[^"]/g, "").length;
      if (s + a === 0) {
        var u2 = (0, yn.default)(o, { isIdentifier: true });
        if (u2 === o)
          return t.NO_QUOTE;
        var l2 = this.preferredQuoteMark(i);
        if (l2 === t.NO_QUOTE) {
          var f = this.quoteMark || i.quoteMark || t.DOUBLE_QUOTE, c2 = cs[f], m2 = (0, yn.default)(o, c2);
          if (m2.length < u2.length)
            return f;
        }
        return l2;
      } else
        return a === s ? this.preferredQuoteMark(i) : a < s ? t.DOUBLE_QUOTE : t.SINGLE_QUOTE;
    }, r.preferredQuoteMark = function(i) {
      var o = i.preferCurrentQuoteMark ? this.quoteMark : i.quoteMark;
      return o === void 0 && (o = i.preferCurrentQuoteMark ? i.quoteMark : this.quoteMark), o === void 0 && (o = t.DOUBLE_QUOTE), o;
    }, r._syncRawValue = function() {
      var i = (0, yn.default)(this._value, cs[this.quoteMark]);
      i === this._value ? this.raws && delete this.raws.value : this.raws.value = i;
    }, r._handleEscapes = function(i, o) {
      if (this._constructed) {
        var s = (0, yn.default)(o, { isIdentifier: true });
        s !== o ? this.raws[i] = s : delete this.raws[i];
      }
    }, r._spacesFor = function(i) {
      var o = { before: "", after: "" }, s = this.spaces[i] || {}, a = this.raws.spaces && this.raws.spaces[i] || {};
      return Object.assign(o, s, a);
    }, r._stringFor = function(i, o, s) {
      o === void 0 && (o = i), s === void 0 && (s = Zl);
      var a = this._spacesFor(o);
      return s(this.stringifyProperty(i), a);
    }, r.offsetOf = function(i) {
      var o = 1, s = this._spacesFor("attribute");
      if (o += s.before.length, i === "namespace" || i === "ns")
        return this.namespace ? o : -1;
      if (i === "attributeNS" || (o += this.namespaceString.length, this.namespace && (o += 1), i === "attribute"))
        return o;
      o += this.stringifyProperty("attribute").length, o += s.after.length;
      var a = this._spacesFor("operator");
      o += a.before.length;
      var u2 = this.stringifyProperty("operator");
      if (i === "operator")
        return u2 ? o : -1;
      o += u2.length, o += a.after.length;
      var l2 = this._spacesFor("value");
      o += l2.before.length;
      var f = this.stringifyProperty("value");
      if (i === "value")
        return f ? o : -1;
      o += f.length, o += l2.after.length;
      var c2 = this._spacesFor("insensitive");
      return o += c2.before.length, i === "insensitive" && this.insensitive ? o : -1;
    }, r.toString = function() {
      var i = this, o = [this.rawSpaceBefore, "["];
      return o.push(this._stringFor("qualifiedAttribute", "attribute")), this.operator && (this.value || this.value === "") && (o.push(this._stringFor("operator")), o.push(this._stringFor("value")), o.push(this._stringFor("insensitiveFlag", "insensitive", function(s, a) {
        return s.length > 0 && !i.quoted && a.before.length === 0 && !(i.spaces.value && i.spaces.value.after) && (a.before = " "), Zl(s, a);
      }))), o.push("]"), o.push(this.rawSpaceAfter), o.join("");
    }, o0(t, [{ key: "quoted", get: function() {
      var i = this.quoteMark;
      return i === "'" || i === '"';
    }, set: function(i) {
      l0();
    } }, { key: "quoteMark", get: function() {
      return this._quoteMark;
    }, set: function(i) {
      if (!this._constructed) {
        this._quoteMark = i;
        return;
      }
      this._quoteMark !== i && (this._quoteMark = i, this._syncRawValue());
    } }, { key: "qualifiedAttribute", get: function() {
      return this.qualifiedName(this.raws.attribute || this.attribute);
    } }, { key: "insensitiveFlag", get: function() {
      return this.insensitive ? "i" : "";
    } }, { key: "value", get: function() {
      return this._value;
    }, set: function(i) {
      if (this._constructed) {
        var o = hs(i), s = o.deprecatedUsage, a = o.unescaped, u2 = o.quoteMark;
        if (s && u0(), a === this._value && u2 === this._quoteMark)
          return;
        this._value = a, this._quoteMark = u2, this._syncRawValue();
      } else
        this._value = i;
    } }, { key: "attribute", get: function() {
      return this._attribute;
    }, set: function(i) {
      this._handleEscapes("attribute", i), this._attribute = i;
    } }]), t;
  }(n0.default);
  xn.default = Ai;
  Ai.NO_QUOTE = null;
  Ai.SINGLE_QUOTE = "'";
  Ai.DOUBLE_QUOTE = '"';
  var cs = (fs = { "'": { quotes: "single", wrap: true }, '"': { quotes: "double", wrap: true } }, fs[null] = { isIdentifier: true }, fs);
  function Zl(e, t) {
    return "" + t.before + e + t.after;
  }
});
var bs = q((wn, ef) => {
  "use strict";
  wn.__esModule = true;
  wn.default = void 0;
  var d0 = h0(Ri()), p0 = Ue();
  function h0(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function m0(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, gs(e, t);
  }
  function gs(e, t) {
    return gs = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, gs(e, t);
  }
  var g0 = function(e) {
    m0(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = p0.UNIVERSAL, n.value = "*", n;
    }
    return t;
  }(d0.default);
  wn.default = g0;
  ef.exports = wn.default;
});
var vs = q((Sn, tf) => {
  "use strict";
  Sn.__esModule = true;
  Sn.default = void 0;
  var b0 = v0(Ht()), y0 = Ue();
  function v0(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function x0(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, ys(e, t);
  }
  function ys(e, t) {
    return ys = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, ys(e, t);
  }
  var w0 = function(e) {
    x0(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = y0.COMBINATOR, n;
    }
    return t;
  }(b0.default);
  Sn.default = w0;
  tf.exports = Sn.default;
});
var ws = q((_n, rf) => {
  "use strict";
  _n.__esModule = true;
  _n.default = void 0;
  var S0 = T0(Ht()), _0 = Ue();
  function T0(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function E0(e, t) {
    e.prototype = Object.create(t.prototype), e.prototype.constructor = e, xs(e, t);
  }
  function xs(e, t) {
    return xs = Object.setPrototypeOf || function(n, i) {
      return n.__proto__ = i, n;
    }, xs(e, t);
  }
  var k0 = function(e) {
    E0(t, e);
    function t(r) {
      var n;
      return n = e.call(this, r) || this, n.type = _0.NESTING, n.value = "&", n;
    }
    return t;
  }(S0.default);
  _n.default = k0;
  rf.exports = _n.default;
});
var of = q((Ii, nf) => {
  "use strict";
  Ii.__esModule = true;
  Ii.default = P0;
  function P0(e) {
    return e.sort(function(t, r) {
      return t - r;
    });
  }
  nf.exports = Ii.default;
});
var Ss = q((U) => {
  "use strict";
  U.__esModule = true;
  U.combinator = U.word = U.comment = U.str = U.tab = U.newline = U.feed = U.cr = U.backslash = U.bang = U.slash = U.doubleQuote = U.singleQuote = U.space = U.greaterThan = U.pipe = U.equals = U.plus = U.caret = U.tilde = U.dollar = U.closeSquare = U.openSquare = U.closeParenthesis = U.openParenthesis = U.semicolon = U.colon = U.comma = U.at = U.asterisk = U.ampersand = void 0;
  var O0 = 38;
  U.ampersand = O0;
  var R0 = 42;
  U.asterisk = R0;
  var A0 = 64;
  U.at = A0;
  var I0 = 44;
  U.comma = I0;
  var C0 = 58;
  U.colon = C0;
  var L0 = 59;
  U.semicolon = L0;
  var M0 = 40;
  U.openParenthesis = M0;
  var F0 = 41;
  U.closeParenthesis = F0;
  var N0 = 91;
  U.openSquare = N0;
  var D0 = 93;
  U.closeSquare = D0;
  var W0 = 36;
  U.dollar = W0;
  var $0 = 126;
  U.tilde = $0;
  var B0 = 94;
  U.caret = B0;
  var U0 = 43;
  U.plus = U0;
  var q0 = 61;
  U.equals = q0;
  var z0 = 124;
  U.pipe = z0;
  var G0 = 62;
  U.greaterThan = G0;
  var j0 = 32;
  U.space = j0;
  var sf = 39;
  U.singleQuote = sf;
  var V0 = 34;
  U.doubleQuote = V0;
  var H0 = 47;
  U.slash = H0;
  var Y0 = 33;
  U.bang = Y0;
  var X0 = 92;
  U.backslash = X0;
  var K0 = 13;
  U.cr = K0;
  var Q0 = 12;
  U.feed = Q0;
  var J0 = 10;
  U.newline = J0;
  var Z0 = 9;
  U.tab = Z0;
  var eg = sf;
  U.str = eg;
  var tg = -1;
  U.comment = tg;
  var rg = -2;
  U.word = rg;
  var ng = -3;
  U.combinator = ng;
});
var lf = q((Tn) => {
  "use strict";
  Tn.__esModule = true;
  Tn.default = fg;
  Tn.FIELDS = void 0;
  var W = ig(Ss()), Ir, ge;
  function uf() {
    if (typeof WeakMap != "function")
      return null;
    var e = /* @__PURE__ */ new WeakMap();
    return uf = function() {
      return e;
    }, e;
  }
  function ig(e) {
    if (e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var t = uf();
    if (t && t.has(e))
      return t.get(e);
    var r = {}, n = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var i in e)
      if (Object.prototype.hasOwnProperty.call(e, i)) {
        var o = n ? Object.getOwnPropertyDescriptor(e, i) : null;
        o && (o.get || o.set) ? Object.defineProperty(r, i, o) : r[i] = e[i];
      }
    return r.default = e, t && t.set(e, r), r;
  }
  var og = (Ir = {}, Ir[W.tab] = true, Ir[W.newline] = true, Ir[W.cr] = true, Ir[W.feed] = true, Ir), sg = (ge = {}, ge[W.space] = true, ge[W.tab] = true, ge[W.newline] = true, ge[W.cr] = true, ge[W.feed] = true, ge[W.ampersand] = true, ge[W.asterisk] = true, ge[W.bang] = true, ge[W.comma] = true, ge[W.colon] = true, ge[W.semicolon] = true, ge[W.openParenthesis] = true, ge[W.closeParenthesis] = true, ge[W.openSquare] = true, ge[W.closeSquare] = true, ge[W.singleQuote] = true, ge[W.doubleQuote] = true, ge[W.plus] = true, ge[W.pipe] = true, ge[W.tilde] = true, ge[W.greaterThan] = true, ge[W.equals] = true, ge[W.dollar] = true, ge[W.caret] = true, ge[W.slash] = true, ge), _s = {}, af = "0123456789abcdefABCDEF";
  for (Ci = 0; Ci < af.length; Ci++)
    _s[af.charCodeAt(Ci)] = true;
  var Ci;
  function ag(e, t) {
    var r = t, n;
    do {
      if (n = e.charCodeAt(r), sg[n])
        return r - 1;
      n === W.backslash ? r = ug(e, r) + 1 : r++;
    } while (r < e.length);
    return r - 1;
  }
  function ug(e, t) {
    var r = t, n = e.charCodeAt(r + 1);
    if (!og[n])
      if (_s[n]) {
        var i = 0;
        do
          r++, i++, n = e.charCodeAt(r + 1);
        while (_s[n] && i < 6);
        i < 6 && n === W.space && r++;
      } else
        r++;
    return r;
  }
  var lg = { TYPE: 0, START_LINE: 1, START_COL: 2, END_LINE: 3, END_COL: 4, START_POS: 5, END_POS: 6 };
  Tn.FIELDS = lg;
  function fg(e) {
    var t = [], r = e.css.valueOf(), n = r, i = n.length, o = -1, s = 1, a = 0, u2 = 0, l2, f, c2, m2, h2, g2, y, x2, w2, P2, T, A, E;
    function _(R2, C) {
      if (e.safe)
        r += C, w2 = r.length - 1;
      else
        throw e.error("Unclosed " + R2, s, a - o, a);
    }
    for (; a < i; ) {
      switch (l2 = r.charCodeAt(a), l2 === W.newline && (o = a, s += 1), l2) {
        case W.space:
        case W.tab:
        case W.newline:
        case W.cr:
        case W.feed:
          w2 = a;
          do
            w2 += 1, l2 = r.charCodeAt(w2), l2 === W.newline && (o = w2, s += 1);
          while (l2 === W.space || l2 === W.newline || l2 === W.tab || l2 === W.cr || l2 === W.feed);
          E = W.space, m2 = s, c2 = w2 - o - 1, u2 = w2;
          break;
        case W.plus:
        case W.greaterThan:
        case W.tilde:
        case W.pipe:
          w2 = a;
          do
            w2 += 1, l2 = r.charCodeAt(w2);
          while (l2 === W.plus || l2 === W.greaterThan || l2 === W.tilde || l2 === W.pipe);
          E = W.combinator, m2 = s, c2 = a - o, u2 = w2;
          break;
        case W.asterisk:
        case W.ampersand:
        case W.bang:
        case W.comma:
        case W.equals:
        case W.dollar:
        case W.caret:
        case W.openSquare:
        case W.closeSquare:
        case W.colon:
        case W.semicolon:
        case W.openParenthesis:
        case W.closeParenthesis:
          w2 = a, E = l2, m2 = s, c2 = a - o, u2 = w2 + 1;
          break;
        case W.singleQuote:
        case W.doubleQuote:
          A = l2 === W.singleQuote ? "'" : '"', w2 = a;
          do
            for (h2 = false, w2 = r.indexOf(A, w2 + 1), w2 === -1 && _("quote", A), g2 = w2; r.charCodeAt(g2 - 1) === W.backslash; )
              g2 -= 1, h2 = !h2;
          while (h2);
          E = W.str, m2 = s, c2 = a - o, u2 = w2 + 1;
          break;
        default:
          l2 === W.slash && r.charCodeAt(a + 1) === W.asterisk ? (w2 = r.indexOf("*/", a + 2) + 1, w2 === 0 && _("comment", "*/"), f = r.slice(a, w2 + 1), x2 = f.split(`
`), y = x2.length - 1, y > 0 ? (P2 = s + y, T = w2 - x2[y].length) : (P2 = s, T = o), E = W.comment, s = P2, m2 = P2, c2 = w2 - T) : l2 === W.slash ? (w2 = a, E = l2, m2 = s, c2 = a - o, u2 = w2 + 1) : (w2 = ag(r, a), E = W.word, m2 = s, c2 = w2 - o), u2 = w2 + 1;
          break;
      }
      t.push([E, s, a - o, m2, c2, a, u2]), T && (o = T, T = null), a = u2;
    }
    return t;
  }
});
var bf = q((En, gf) => {
  "use strict";
  En.__esModule = true;
  En.default = void 0;
  var cg = ht(Ho()), Ts = ht(Xo()), dg = ht(Jo()), ff = ht(es()), pg = ht(rs()), hg = ht(os()), Es = ht(as()), mg = ht(ls()), cf = Li(ms()), gg = ht(bs()), ks = ht(vs()), bg = ht(ws()), yg = ht(of()), F = Li(lf()), B = Li(Ss()), vg = Li(Ue()), _e = sn(), dr, Ps;
  function mf() {
    if (typeof WeakMap != "function")
      return null;
    var e = /* @__PURE__ */ new WeakMap();
    return mf = function() {
      return e;
    }, e;
  }
  function Li(e) {
    if (e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var t = mf();
    if (t && t.has(e))
      return t.get(e);
    var r = {}, n = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var i in e)
      if (Object.prototype.hasOwnProperty.call(e, i)) {
        var o = n ? Object.getOwnPropertyDescriptor(e, i) : null;
        o && (o.get || o.set) ? Object.defineProperty(r, i, o) : r[i] = e[i];
      }
    return r.default = e, t && t.set(e, r), r;
  }
  function ht(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function df(e, t) {
    for (var r = 0; r < t.length; r++) {
      var n = t[r];
      n.enumerable = n.enumerable || false, n.configurable = true, "value" in n && (n.writable = true), Object.defineProperty(e, n.key, n);
    }
  }
  function xg(e, t, r) {
    return t && df(e.prototype, t), r && df(e, r), e;
  }
  var As = (dr = {}, dr[B.space] = true, dr[B.cr] = true, dr[B.feed] = true, dr[B.newline] = true, dr[B.tab] = true, dr), wg = Object.assign({}, As, (Ps = {}, Ps[B.comment] = true, Ps));
  function pf(e) {
    return { line: e[F.FIELDS.START_LINE], column: e[F.FIELDS.START_COL] };
  }
  function hf(e) {
    return { line: e[F.FIELDS.END_LINE], column: e[F.FIELDS.END_COL] };
  }
  function pr(e, t, r, n) {
    return { start: { line: e, column: t }, end: { line: r, column: n } };
  }
  function Cr(e) {
    return pr(e[F.FIELDS.START_LINE], e[F.FIELDS.START_COL], e[F.FIELDS.END_LINE], e[F.FIELDS.END_COL]);
  }
  function Os(e, t) {
    if (e)
      return pr(e[F.FIELDS.START_LINE], e[F.FIELDS.START_COL], t[F.FIELDS.END_LINE], t[F.FIELDS.END_COL]);
  }
  function Lr(e, t) {
    var r = e[t];
    if (typeof r == "string")
      return r.indexOf("\\") !== -1 && ((0, _e.ensureObject)(e, "raws"), e[t] = (0, _e.unesc)(r), e.raws[t] === void 0 && (e.raws[t] = r)), e;
  }
  function Rs(e, t) {
    for (var r = -1, n = []; (r = e.indexOf(t, r + 1)) !== -1; )
      n.push(r);
    return n;
  }
  function Sg() {
    var e = Array.prototype.concat.apply([], arguments);
    return e.filter(function(t, r) {
      return r === e.indexOf(t);
    });
  }
  var _g = function() {
    function e(r, n) {
      n === void 0 && (n = {}), this.rule = r, this.options = Object.assign({ lossy: false, safe: false }, n), this.position = 0, this.css = typeof this.rule == "string" ? this.rule : this.rule.selector, this.tokens = (0, F.default)({ css: this.css, error: this._errorGenerator(), safe: this.options.safe });
      var i = Os(this.tokens[0], this.tokens[this.tokens.length - 1]);
      this.root = new cg.default({ source: i }), this.root.errorGenerator = this._errorGenerator();
      var o = new Ts.default({ source: { start: { line: 1, column: 1 } } });
      this.root.append(o), this.current = o, this.loop();
    }
    var t = e.prototype;
    return t._errorGenerator = function() {
      var n = this;
      return function(i, o) {
        return typeof n.rule == "string" ? new Error(i) : n.rule.error(i, o);
      };
    }, t.attribute = function() {
      var n = [], i = this.currToken;
      for (this.position++; this.position < this.tokens.length && this.currToken[F.FIELDS.TYPE] !== B.closeSquare; )
        n.push(this.currToken), this.position++;
      if (this.currToken[F.FIELDS.TYPE] !== B.closeSquare)
        return this.expected("closing square bracket", this.currToken[F.FIELDS.START_POS]);
      var o = n.length, s = { source: pr(i[1], i[2], this.currToken[3], this.currToken[4]), sourceIndex: i[F.FIELDS.START_POS] };
      if (o === 1 && !~[B.word].indexOf(n[0][F.FIELDS.TYPE]))
        return this.expected("attribute", n[0][F.FIELDS.START_POS]);
      for (var a = 0, u2 = "", l2 = "", f = null, c2 = false; a < o; ) {
        var m2 = n[a], h2 = this.content(m2), g2 = n[a + 1];
        switch (m2[F.FIELDS.TYPE]) {
          case B.space:
            if (c2 = true, this.options.lossy)
              break;
            if (f) {
              (0, _e.ensureObject)(s, "spaces", f);
              var y = s.spaces[f].after || "";
              s.spaces[f].after = y + h2;
              var x2 = (0, _e.getProp)(s, "raws", "spaces", f, "after") || null;
              x2 && (s.raws.spaces[f].after = x2 + h2);
            } else
              u2 = u2 + h2, l2 = l2 + h2;
            break;
          case B.asterisk:
            if (g2[F.FIELDS.TYPE] === B.equals)
              s.operator = h2, f = "operator";
            else if ((!s.namespace || f === "namespace" && !c2) && g2) {
              u2 && ((0, _e.ensureObject)(s, "spaces", "attribute"), s.spaces.attribute.before = u2, u2 = ""), l2 && ((0, _e.ensureObject)(s, "raws", "spaces", "attribute"), s.raws.spaces.attribute.before = u2, l2 = ""), s.namespace = (s.namespace || "") + h2;
              var w2 = (0, _e.getProp)(s, "raws", "namespace") || null;
              w2 && (s.raws.namespace += h2), f = "namespace";
            }
            c2 = false;
            break;
          case B.dollar:
            if (f === "value") {
              var P2 = (0, _e.getProp)(s, "raws", "value");
              s.value += "$", P2 && (s.raws.value = P2 + "$");
              break;
            }
          case B.caret:
            g2[F.FIELDS.TYPE] === B.equals && (s.operator = h2, f = "operator"), c2 = false;
            break;
          case B.combinator:
            if (h2 === "~" && g2[F.FIELDS.TYPE] === B.equals && (s.operator = h2, f = "operator"), h2 !== "|") {
              c2 = false;
              break;
            }
            g2[F.FIELDS.TYPE] === B.equals ? (s.operator = h2, f = "operator") : !s.namespace && !s.attribute && (s.namespace = true), c2 = false;
            break;
          case B.word:
            if (g2 && this.content(g2) === "|" && n[a + 2] && n[a + 2][F.FIELDS.TYPE] !== B.equals && !s.operator && !s.namespace)
              s.namespace = h2, f = "namespace";
            else if (!s.attribute || f === "attribute" && !c2) {
              u2 && ((0, _e.ensureObject)(s, "spaces", "attribute"), s.spaces.attribute.before = u2, u2 = ""), l2 && ((0, _e.ensureObject)(s, "raws", "spaces", "attribute"), s.raws.spaces.attribute.before = l2, l2 = ""), s.attribute = (s.attribute || "") + h2;
              var T = (0, _e.getProp)(s, "raws", "attribute") || null;
              T && (s.raws.attribute += h2), f = "attribute";
            } else if (!s.value && s.value !== "" || f === "value" && !c2) {
              var A = (0, _e.unesc)(h2), E = (0, _e.getProp)(s, "raws", "value") || "", _ = s.value || "";
              s.value = _ + A, s.quoteMark = null, (A !== h2 || E) && ((0, _e.ensureObject)(s, "raws"), s.raws.value = (E || _) + h2), f = "value";
            } else {
              var R2 = h2 === "i" || h2 === "I";
              (s.value || s.value === "") && (s.quoteMark || c2) ? (s.insensitive = R2, (!R2 || h2 === "I") && ((0, _e.ensureObject)(s, "raws"), s.raws.insensitiveFlag = h2), f = "insensitive", u2 && ((0, _e.ensureObject)(s, "spaces", "insensitive"), s.spaces.insensitive.before = u2, u2 = ""), l2 && ((0, _e.ensureObject)(s, "raws", "spaces", "insensitive"), s.raws.spaces.insensitive.before = l2, l2 = "")) : (s.value || s.value === "") && (f = "value", s.value += h2, s.raws.value && (s.raws.value += h2));
            }
            c2 = false;
            break;
          case B.str:
            if (!s.attribute || !s.operator)
              return this.error("Expected an attribute followed by an operator preceding the string.", { index: m2[F.FIELDS.START_POS] });
            var C = (0, cf.unescapeValue)(h2), z = C.unescaped, G = C.quoteMark;
            s.value = z, s.quoteMark = G, f = "value", (0, _e.ensureObject)(s, "raws"), s.raws.value = h2, c2 = false;
            break;
          case B.equals:
            if (!s.attribute)
              return this.expected("attribute", m2[F.FIELDS.START_POS], h2);
            if (s.value)
              return this.error('Unexpected "=" found; an operator was already defined.', { index: m2[F.FIELDS.START_POS] });
            s.operator = s.operator ? s.operator + h2 : h2, f = "operator", c2 = false;
            break;
          case B.comment:
            if (f)
              if (c2 || g2 && g2[F.FIELDS.TYPE] === B.space || f === "insensitive") {
                var ie = (0, _e.getProp)(s, "spaces", f, "after") || "", te = (0, _e.getProp)(s, "raws", "spaces", f, "after") || ie;
                (0, _e.ensureObject)(s, "raws", "spaces", f), s.raws.spaces[f].after = te + h2;
              } else {
                var he = s[f] || "", de = (0, _e.getProp)(s, "raws", f) || he;
                (0, _e.ensureObject)(s, "raws"), s.raws[f] = de + h2;
              }
            else
              l2 = l2 + h2;
            break;
          default:
            return this.error('Unexpected "' + h2 + '" found.', { index: m2[F.FIELDS.START_POS] });
        }
        a++;
      }
      Lr(s, "attribute"), Lr(s, "namespace"), this.newNode(new cf.default(s)), this.position++;
    }, t.parseWhitespaceEquivalentTokens = function(n) {
      n < 0 && (n = this.tokens.length);
      var i = this.position, o = [], s = "", a = void 0;
      do
        if (As[this.currToken[F.FIELDS.TYPE]])
          this.options.lossy || (s += this.content());
        else if (this.currToken[F.FIELDS.TYPE] === B.comment) {
          var u2 = {};
          s && (u2.before = s, s = ""), a = new ff.default({ value: this.content(), source: Cr(this.currToken), sourceIndex: this.currToken[F.FIELDS.START_POS], spaces: u2 }), o.push(a);
        }
      while (++this.position < n);
      if (s) {
        if (a)
          a.spaces.after = s;
        else if (!this.options.lossy) {
          var l2 = this.tokens[i], f = this.tokens[this.position - 1];
          o.push(new Es.default({ value: "", source: pr(l2[F.FIELDS.START_LINE], l2[F.FIELDS.START_COL], f[F.FIELDS.END_LINE], f[F.FIELDS.END_COL]), sourceIndex: l2[F.FIELDS.START_POS], spaces: { before: s, after: "" } }));
        }
      }
      return o;
    }, t.convertWhitespaceNodesToSpace = function(n, i) {
      var o = this;
      i === void 0 && (i = false);
      var s = "", a = "";
      n.forEach(function(l2) {
        var f = o.lossySpace(l2.spaces.before, i), c2 = o.lossySpace(l2.rawSpaceBefore, i);
        s += f + o.lossySpace(l2.spaces.after, i && f.length === 0), a += f + l2.value + o.lossySpace(l2.rawSpaceAfter, i && c2.length === 0);
      }), a === s && (a = void 0);
      var u2 = { space: s, rawSpace: a };
      return u2;
    }, t.isNamedCombinator = function(n) {
      return n === void 0 && (n = this.position), this.tokens[n + 0] && this.tokens[n + 0][F.FIELDS.TYPE] === B.slash && this.tokens[n + 1] && this.tokens[n + 1][F.FIELDS.TYPE] === B.word && this.tokens[n + 2] && this.tokens[n + 2][F.FIELDS.TYPE] === B.slash;
    }, t.namedCombinator = function() {
      if (this.isNamedCombinator()) {
        var n = this.content(this.tokens[this.position + 1]), i = (0, _e.unesc)(n).toLowerCase(), o = {};
        i !== n && (o.value = "/" + n + "/");
        var s = new ks.default({ value: "/" + i + "/", source: pr(this.currToken[F.FIELDS.START_LINE], this.currToken[F.FIELDS.START_COL], this.tokens[this.position + 2][F.FIELDS.END_LINE], this.tokens[this.position + 2][F.FIELDS.END_COL]), sourceIndex: this.currToken[F.FIELDS.START_POS], raws: o });
        return this.position = this.position + 3, s;
      } else
        this.unexpected();
    }, t.combinator = function() {
      var n = this;
      if (this.content() === "|")
        return this.namespace();
      var i = this.locateNextMeaningfulToken(this.position);
      if (i < 0 || this.tokens[i][F.FIELDS.TYPE] === B.comma) {
        var o = this.parseWhitespaceEquivalentTokens(i);
        if (o.length > 0) {
          var s = this.current.last;
          if (s) {
            var a = this.convertWhitespaceNodesToSpace(o), u2 = a.space, l2 = a.rawSpace;
            l2 !== void 0 && (s.rawSpaceAfter += l2), s.spaces.after += u2;
          } else
            o.forEach(function(E) {
              return n.newNode(E);
            });
        }
        return;
      }
      var f = this.currToken, c2 = void 0;
      i > this.position && (c2 = this.parseWhitespaceEquivalentTokens(i));
      var m2;
      if (this.isNamedCombinator() ? m2 = this.namedCombinator() : this.currToken[F.FIELDS.TYPE] === B.combinator ? (m2 = new ks.default({ value: this.content(), source: Cr(this.currToken), sourceIndex: this.currToken[F.FIELDS.START_POS] }), this.position++) : As[this.currToken[F.FIELDS.TYPE]] || c2 || this.unexpected(), m2) {
        if (c2) {
          var h2 = this.convertWhitespaceNodesToSpace(c2), g2 = h2.space, y = h2.rawSpace;
          m2.spaces.before = g2, m2.rawSpaceBefore = y;
        }
      } else {
        var x2 = this.convertWhitespaceNodesToSpace(c2, true), w2 = x2.space, P2 = x2.rawSpace;
        P2 || (P2 = w2);
        var T = {}, A = { spaces: {} };
        w2.endsWith(" ") && P2.endsWith(" ") ? (T.before = w2.slice(0, w2.length - 1), A.spaces.before = P2.slice(0, P2.length - 1)) : w2.startsWith(" ") && P2.startsWith(" ") ? (T.after = w2.slice(1), A.spaces.after = P2.slice(1)) : A.value = P2, m2 = new ks.default({ value: " ", source: Os(f, this.tokens[this.position - 1]), sourceIndex: f[F.FIELDS.START_POS], spaces: T, raws: A });
      }
      return this.currToken && this.currToken[F.FIELDS.TYPE] === B.space && (m2.spaces.after = this.optionalSpace(this.content()), this.position++), this.newNode(m2);
    }, t.comma = function() {
      if (this.position === this.tokens.length - 1) {
        this.root.trailingComma = true, this.position++;
        return;
      }
      this.current._inferEndPosition();
      var n = new Ts.default({ source: { start: pf(this.tokens[this.position + 1]) } });
      this.current.parent.append(n), this.current = n, this.position++;
    }, t.comment = function() {
      var n = this.currToken;
      this.newNode(new ff.default({ value: this.content(), source: Cr(n), sourceIndex: n[F.FIELDS.START_POS] })), this.position++;
    }, t.error = function(n, i) {
      throw this.root.error(n, i);
    }, t.missingBackslash = function() {
      return this.error("Expected a backslash preceding the semicolon.", { index: this.currToken[F.FIELDS.START_POS] });
    }, t.missingParenthesis = function() {
      return this.expected("opening parenthesis", this.currToken[F.FIELDS.START_POS]);
    }, t.missingSquareBracket = function() {
      return this.expected("opening square bracket", this.currToken[F.FIELDS.START_POS]);
    }, t.unexpected = function() {
      return this.error("Unexpected '" + this.content() + "'. Escaping special characters with \\ may help.", this.currToken[F.FIELDS.START_POS]);
    }, t.namespace = function() {
      var n = this.prevToken && this.content(this.prevToken) || true;
      if (this.nextToken[F.FIELDS.TYPE] === B.word)
        return this.position++, this.word(n);
      if (this.nextToken[F.FIELDS.TYPE] === B.asterisk)
        return this.position++, this.universal(n);
    }, t.nesting = function() {
      if (this.nextToken) {
        var n = this.content(this.nextToken);
        if (n === "|") {
          this.position++;
          return;
        }
      }
      var i = this.currToken;
      this.newNode(new bg.default({ value: this.content(), source: Cr(i), sourceIndex: i[F.FIELDS.START_POS] })), this.position++;
    }, t.parentheses = function() {
      var n = this.current.last, i = 1;
      if (this.position++, n && n.type === vg.PSEUDO) {
        var o = new Ts.default({ source: { start: pf(this.tokens[this.position - 1]) } }), s = this.current;
        for (n.append(o), this.current = o; this.position < this.tokens.length && i; )
          this.currToken[F.FIELDS.TYPE] === B.openParenthesis && i++, this.currToken[F.FIELDS.TYPE] === B.closeParenthesis && i--, i ? this.parse() : (this.current.source.end = hf(this.currToken), this.current.parent.source.end = hf(this.currToken), this.position++);
        this.current = s;
      } else {
        for (var a = this.currToken, u2 = "(", l2; this.position < this.tokens.length && i; )
          this.currToken[F.FIELDS.TYPE] === B.openParenthesis && i++, this.currToken[F.FIELDS.TYPE] === B.closeParenthesis && i--, l2 = this.currToken, u2 += this.parseParenthesisToken(this.currToken), this.position++;
        n ? n.appendToPropertyAndEscape("value", u2, u2) : this.newNode(new Es.default({ value: u2, source: pr(a[F.FIELDS.START_LINE], a[F.FIELDS.START_COL], l2[F.FIELDS.END_LINE], l2[F.FIELDS.END_COL]), sourceIndex: a[F.FIELDS.START_POS] }));
      }
      if (i)
        return this.expected("closing parenthesis", this.currToken[F.FIELDS.START_POS]);
    }, t.pseudo = function() {
      for (var n = this, i = "", o = this.currToken; this.currToken && this.currToken[F.FIELDS.TYPE] === B.colon; )
        i += this.content(), this.position++;
      if (!this.currToken)
        return this.expected(["pseudo-class", "pseudo-element"], this.position - 1);
      if (this.currToken[F.FIELDS.TYPE] === B.word)
        this.splitWord(false, function(s, a) {
          i += s, n.newNode(new mg.default({ value: i, source: Os(o, n.currToken), sourceIndex: o[F.FIELDS.START_POS] })), a > 1 && n.nextToken && n.nextToken[F.FIELDS.TYPE] === B.openParenthesis && n.error("Misplaced parenthesis.", { index: n.nextToken[F.FIELDS.START_POS] });
        });
      else
        return this.expected(["pseudo-class", "pseudo-element"], this.currToken[F.FIELDS.START_POS]);
    }, t.space = function() {
      var n = this.content();
      this.position === 0 || this.prevToken[F.FIELDS.TYPE] === B.comma || this.prevToken[F.FIELDS.TYPE] === B.openParenthesis || this.current.nodes.every(function(i) {
        return i.type === "comment";
      }) ? (this.spaces = this.optionalSpace(n), this.position++) : this.position === this.tokens.length - 1 || this.nextToken[F.FIELDS.TYPE] === B.comma || this.nextToken[F.FIELDS.TYPE] === B.closeParenthesis ? (this.current.last.spaces.after = this.optionalSpace(n), this.position++) : this.combinator();
    }, t.string = function() {
      var n = this.currToken;
      this.newNode(new Es.default({ value: this.content(), source: Cr(n), sourceIndex: n[F.FIELDS.START_POS] })), this.position++;
    }, t.universal = function(n) {
      var i = this.nextToken;
      if (i && this.content(i) === "|")
        return this.position++, this.namespace();
      var o = this.currToken;
      this.newNode(new gg.default({ value: this.content(), source: Cr(o), sourceIndex: o[F.FIELDS.START_POS] }), n), this.position++;
    }, t.splitWord = function(n, i) {
      for (var o = this, s = this.nextToken, a = this.content(); s && ~[B.dollar, B.caret, B.equals, B.word].indexOf(s[F.FIELDS.TYPE]); ) {
        this.position++;
        var u2 = this.content();
        if (a += u2, u2.lastIndexOf("\\") === u2.length - 1) {
          var l2 = this.nextToken;
          l2 && l2[F.FIELDS.TYPE] === B.space && (a += this.requiredSpace(this.content(l2)), this.position++);
        }
        s = this.nextToken;
      }
      var f = Rs(a, ".").filter(function(g2) {
        var y = a[g2 - 1] === "\\", x2 = /^\d+\.\d+%$/.test(a);
        return !y && !x2;
      }), c2 = Rs(a, "#").filter(function(g2) {
        return a[g2 - 1] !== "\\";
      }), m2 = Rs(a, "#{");
      m2.length && (c2 = c2.filter(function(g2) {
        return !~m2.indexOf(g2);
      }));
      var h2 = (0, yg.default)(Sg([0].concat(f, c2)));
      h2.forEach(function(g2, y) {
        var x2 = h2[y + 1] || a.length, w2 = a.slice(g2, x2);
        if (y === 0 && i)
          return i.call(o, w2, h2.length);
        var P2, T = o.currToken, A = T[F.FIELDS.START_POS] + h2[y], E = pr(T[1], T[2] + g2, T[3], T[2] + (x2 - 1));
        if (~f.indexOf(g2)) {
          var _ = { value: w2.slice(1), source: E, sourceIndex: A };
          P2 = new dg.default(Lr(_, "value"));
        } else if (~c2.indexOf(g2)) {
          var R2 = { value: w2.slice(1), source: E, sourceIndex: A };
          P2 = new pg.default(Lr(R2, "value"));
        } else {
          var C = { value: w2, source: E, sourceIndex: A };
          Lr(C, "value"), P2 = new hg.default(C);
        }
        o.newNode(P2, n), n = null;
      }), this.position++;
    }, t.word = function(n) {
      var i = this.nextToken;
      return i && this.content(i) === "|" ? (this.position++, this.namespace()) : this.splitWord(n);
    }, t.loop = function() {
      for (; this.position < this.tokens.length; )
        this.parse(true);
      return this.current._inferEndPosition(), this.root;
    }, t.parse = function(n) {
      switch (this.currToken[F.FIELDS.TYPE]) {
        case B.space:
          this.space();
          break;
        case B.comment:
          this.comment();
          break;
        case B.openParenthesis:
          this.parentheses();
          break;
        case B.closeParenthesis:
          n && this.missingParenthesis();
          break;
        case B.openSquare:
          this.attribute();
          break;
        case B.dollar:
        case B.caret:
        case B.equals:
        case B.word:
          this.word();
          break;
        case B.colon:
          this.pseudo();
          break;
        case B.comma:
          this.comma();
          break;
        case B.asterisk:
          this.universal();
          break;
        case B.ampersand:
          this.nesting();
          break;
        case B.slash:
        case B.combinator:
          this.combinator();
          break;
        case B.str:
          this.string();
          break;
        case B.closeSquare:
          this.missingSquareBracket();
        case B.semicolon:
          this.missingBackslash();
        default:
          this.unexpected();
      }
    }, t.expected = function(n, i, o) {
      if (Array.isArray(n)) {
        var s = n.pop();
        n = n.join(", ") + " or " + s;
      }
      var a = /^[aeiou]/.test(n[0]) ? "an" : "a";
      return o ? this.error("Expected " + a + " " + n + ', found "' + o + '" instead.', { index: i }) : this.error("Expected " + a + " " + n + ".", { index: i });
    }, t.requiredSpace = function(n) {
      return this.options.lossy ? " " : n;
    }, t.optionalSpace = function(n) {
      return this.options.lossy ? "" : n;
    }, t.lossySpace = function(n, i) {
      return this.options.lossy ? i ? " " : "" : n;
    }, t.parseParenthesisToken = function(n) {
      var i = this.content(n);
      return n[F.FIELDS.TYPE] === B.space ? this.requiredSpace(i) : i;
    }, t.newNode = function(n, i) {
      return i && (/^ +$/.test(i) && (this.options.lossy || (this.spaces = (this.spaces || "") + i), i = true), n.namespace = i, Lr(n, "namespace")), this.spaces && (n.spaces.before = this.spaces, this.spaces = ""), this.current.append(n);
    }, t.content = function(n) {
      return n === void 0 && (n = this.currToken), this.css.slice(n[F.FIELDS.START_POS], n[F.FIELDS.END_POS]);
    }, t.locateNextMeaningfulToken = function(n) {
      n === void 0 && (n = this.position + 1);
      for (var i = n; i < this.tokens.length; )
        if (wg[this.tokens[i][F.FIELDS.TYPE]]) {
          i++;
          continue;
        } else
          return i;
      return -1;
    }, xg(e, [{ key: "currToken", get: function() {
      return this.tokens[this.position];
    } }, { key: "nextToken", get: function() {
      return this.tokens[this.position + 1];
    } }, { key: "prevToken", get: function() {
      return this.tokens[this.position - 1];
    } }]), e;
  }();
  En.default = _g;
  gf.exports = En.default;
});
var vf = q((kn, yf) => {
  "use strict";
  kn.__esModule = true;
  kn.default = void 0;
  var Tg = Eg(bf());
  function Eg(e) {
    return e && e.__esModule ? e : { default: e };
  }
  var kg = function() {
    function e(r, n) {
      this.func = r || function() {
      }, this.funcRes = null, this.options = n;
    }
    var t = e.prototype;
    return t._shouldUpdateSelector = function(n, i) {
      i === void 0 && (i = {});
      var o = Object.assign({}, this.options, i);
      return o.updateSelector === false ? false : typeof n != "string";
    }, t._isLossy = function(n) {
      n === void 0 && (n = {});
      var i = Object.assign({}, this.options, n);
      return i.lossless === false;
    }, t._root = function(n, i) {
      i === void 0 && (i = {});
      var o = new Tg.default(n, this._parseOptions(i));
      return o.root;
    }, t._parseOptions = function(n) {
      return { lossy: this._isLossy(n) };
    }, t._run = function(n, i) {
      var o = this;
      return i === void 0 && (i = {}), new Promise(function(s, a) {
        try {
          var u2 = o._root(n, i);
          Promise.resolve(o.func(u2)).then(function(l2) {
            var f = void 0;
            return o._shouldUpdateSelector(n, i) && (f = u2.toString(), n.selector = f), { transform: l2, root: u2, string: f };
          }).then(s, a);
        } catch (l2) {
          a(l2);
          return;
        }
      });
    }, t._runSync = function(n, i) {
      i === void 0 && (i = {});
      var o = this._root(n, i), s = this.func(o);
      if (s && typeof s.then == "function")
        throw new Error("Selector processor returned a promise to a synchronous call.");
      var a = void 0;
      return i.updateSelector && typeof n != "string" && (a = o.toString(), n.selector = a), { transform: s, root: o, string: a };
    }, t.ast = function(n, i) {
      return this._run(n, i).then(function(o) {
        return o.root;
      });
    }, t.astSync = function(n, i) {
      return this._runSync(n, i).root;
    }, t.transform = function(n, i) {
      return this._run(n, i).then(function(o) {
        return o.transform;
      });
    }, t.transformSync = function(n, i) {
      return this._runSync(n, i).transform;
    }, t.process = function(n, i) {
      return this._run(n, i).then(function(o) {
        return o.string || o.root.toString();
      });
    }, t.processSync = function(n, i) {
      var o = this._runSync(n, i);
      return o.string || o.root.toString();
    }, e;
  }();
  kn.default = kg;
  yf.exports = kn.default;
});
var xf = q((xe) => {
  "use strict";
  xe.__esModule = true;
  xe.universal = xe.tag = xe.string = xe.selector = xe.root = xe.pseudo = xe.nesting = xe.id = xe.comment = xe.combinator = xe.className = xe.attribute = void 0;
  var Pg = mt(ms()), Og = mt(Jo()), Rg = mt(vs()), Ag = mt(es()), Ig = mt(rs()), Cg = mt(ws()), Lg = mt(ls()), Mg = mt(Ho()), Fg = mt(Xo()), Ng = mt(as()), Dg = mt(os()), Wg = mt(bs());
  function mt(e) {
    return e && e.__esModule ? e : { default: e };
  }
  var $g = function(t) {
    return new Pg.default(t);
  };
  xe.attribute = $g;
  var Bg = function(t) {
    return new Og.default(t);
  };
  xe.className = Bg;
  var Ug = function(t) {
    return new Rg.default(t);
  };
  xe.combinator = Ug;
  var qg = function(t) {
    return new Ag.default(t);
  };
  xe.comment = qg;
  var zg = function(t) {
    return new Ig.default(t);
  };
  xe.id = zg;
  var Gg = function(t) {
    return new Cg.default(t);
  };
  xe.nesting = Gg;
  var jg = function(t) {
    return new Lg.default(t);
  };
  xe.pseudo = jg;
  var Vg = function(t) {
    return new Mg.default(t);
  };
  xe.root = Vg;
  var Hg = function(t) {
    return new Fg.default(t);
  };
  xe.selector = Hg;
  var Yg = function(t) {
    return new Ng.default(t);
  };
  xe.string = Yg;
  var Xg = function(t) {
    return new Dg.default(t);
  };
  xe.tag = Xg;
  var Kg = function(t) {
    return new Wg.default(t);
  };
  xe.universal = Kg;
});
var Tf = q((ae) => {
  "use strict";
  ae.__esModule = true;
  ae.isNode = Is;
  ae.isPseudoElement = _f;
  ae.isPseudoClass = ab;
  ae.isContainer = ub;
  ae.isNamespace = lb;
  ae.isUniversal = ae.isTag = ae.isString = ae.isSelector = ae.isRoot = ae.isPseudo = ae.isNesting = ae.isIdentifier = ae.isComment = ae.isCombinator = ae.isClassName = ae.isAttribute = void 0;
  var Te = Ue(), Ze, Qg = (Ze = {}, Ze[Te.ATTRIBUTE] = true, Ze[Te.CLASS] = true, Ze[Te.COMBINATOR] = true, Ze[Te.COMMENT] = true, Ze[Te.ID] = true, Ze[Te.NESTING] = true, Ze[Te.PSEUDO] = true, Ze[Te.ROOT] = true, Ze[Te.SELECTOR] = true, Ze[Te.STRING] = true, Ze[Te.TAG] = true, Ze[Te.UNIVERSAL] = true, Ze);
  function Is(e) {
    return typeof e == "object" && Qg[e.type];
  }
  function gt(e, t) {
    return Is(t) && t.type === e;
  }
  var wf = gt.bind(null, Te.ATTRIBUTE);
  ae.isAttribute = wf;
  var Jg = gt.bind(null, Te.CLASS);
  ae.isClassName = Jg;
  var Zg = gt.bind(null, Te.COMBINATOR);
  ae.isCombinator = Zg;
  var eb = gt.bind(null, Te.COMMENT);
  ae.isComment = eb;
  var tb = gt.bind(null, Te.ID);
  ae.isIdentifier = tb;
  var rb = gt.bind(null, Te.NESTING);
  ae.isNesting = rb;
  var Cs = gt.bind(null, Te.PSEUDO);
  ae.isPseudo = Cs;
  var nb = gt.bind(null, Te.ROOT);
  ae.isRoot = nb;
  var ib = gt.bind(null, Te.SELECTOR);
  ae.isSelector = ib;
  var ob = gt.bind(null, Te.STRING);
  ae.isString = ob;
  var Sf = gt.bind(null, Te.TAG);
  ae.isTag = Sf;
  var sb = gt.bind(null, Te.UNIVERSAL);
  ae.isUniversal = sb;
  function _f(e) {
    return Cs(e) && e.value && (e.value.startsWith("::") || e.value.toLowerCase() === ":before" || e.value.toLowerCase() === ":after" || e.value.toLowerCase() === ":first-letter" || e.value.toLowerCase() === ":first-line");
  }
  function ab(e) {
    return Cs(e) && !_f(e);
  }
  function ub(e) {
    return !!(Is(e) && e.walk);
  }
  function lb(e) {
    return wf(e) || Sf(e);
  }
});
var Ef = q((_t) => {
  "use strict";
  _t.__esModule = true;
  var Ls = Ue();
  Object.keys(Ls).forEach(function(e) {
    e === "default" || e === "__esModule" || e in _t && _t[e] === Ls[e] || (_t[e] = Ls[e]);
  });
  var Ms = xf();
  Object.keys(Ms).forEach(function(e) {
    e === "default" || e === "__esModule" || e in _t && _t[e] === Ms[e] || (_t[e] = Ms[e]);
  });
  var Fs = Tf();
  Object.keys(Fs).forEach(function(e) {
    e === "default" || e === "__esModule" || e in _t && _t[e] === Fs[e] || (_t[e] = Fs[e]);
  });
});
var Of = q((Pn, Pf) => {
  "use strict";
  Pn.__esModule = true;
  Pn.default = void 0;
  var fb = pb(vf()), cb = db(Ef());
  function kf() {
    if (typeof WeakMap != "function")
      return null;
    var e = /* @__PURE__ */ new WeakMap();
    return kf = function() {
      return e;
    }, e;
  }
  function db(e) {
    if (e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var t = kf();
    if (t && t.has(e))
      return t.get(e);
    var r = {}, n = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var i in e)
      if (Object.prototype.hasOwnProperty.call(e, i)) {
        var o = n ? Object.getOwnPropertyDescriptor(e, i) : null;
        o && (o.get || o.set) ? Object.defineProperty(r, i, o) : r[i] = e[i];
      }
    return r.default = e, t && t.set(e, r), r;
  }
  function pb(e) {
    return e && e.__esModule ? e : { default: e };
  }
  var Ns = function(t) {
    return new fb.default(t);
  };
  Object.assign(Ns, cb);
  delete Ns.__esModule;
  var hb = Ns;
  Pn.default = hb;
  Pf.exports = Pn.default;
});
var Rf = q((Ds) => {
  "use strict";
  Object.defineProperty(Ds, "__esModule", { value: true });
  Object.defineProperty(Ds, "default", { enumerable: true, get: () => mb });
  function mb(e) {
    return e.replace(/\\,/g, "\\2c ");
  }
});
var If = q((eS, Af) => {
  "use strict";
  Af.exports = { aliceblue: [240, 248, 255], antiquewhite: [250, 235, 215], aqua: [0, 255, 255], aquamarine: [127, 255, 212], azure: [240, 255, 255], beige: [245, 245, 220], bisque: [255, 228, 196], black: [0, 0, 0], blanchedalmond: [255, 235, 205], blue: [0, 0, 255], blueviolet: [138, 43, 226], brown: [165, 42, 42], burlywood: [222, 184, 135], cadetblue: [95, 158, 160], chartreuse: [127, 255, 0], chocolate: [210, 105, 30], coral: [255, 127, 80], cornflowerblue: [100, 149, 237], cornsilk: [255, 248, 220], crimson: [220, 20, 60], cyan: [0, 255, 255], darkblue: [0, 0, 139], darkcyan: [0, 139, 139], darkgoldenrod: [184, 134, 11], darkgray: [169, 169, 169], darkgreen: [0, 100, 0], darkgrey: [169, 169, 169], darkkhaki: [189, 183, 107], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47], darkorange: [255, 140, 0], darkorchid: [153, 50, 204], darkred: [139, 0, 0], darksalmon: [233, 150, 122], darkseagreen: [143, 188, 143], darkslateblue: [72, 61, 139], darkslategray: [47, 79, 79], darkslategrey: [47, 79, 79], darkturquoise: [0, 206, 209], darkviolet: [148, 0, 211], deeppink: [255, 20, 147], deepskyblue: [0, 191, 255], dimgray: [105, 105, 105], dimgrey: [105, 105, 105], dodgerblue: [30, 144, 255], firebrick: [178, 34, 34], floralwhite: [255, 250, 240], forestgreen: [34, 139, 34], fuchsia: [255, 0, 255], gainsboro: [220, 220, 220], ghostwhite: [248, 248, 255], gold: [255, 215, 0], goldenrod: [218, 165, 32], gray: [128, 128, 128], green: [0, 128, 0], greenyellow: [173, 255, 47], grey: [128, 128, 128], honeydew: [240, 255, 240], hotpink: [255, 105, 180], indianred: [205, 92, 92], indigo: [75, 0, 130], ivory: [255, 255, 240], khaki: [240, 230, 140], lavender: [230, 230, 250], lavenderblush: [255, 240, 245], lawngreen: [124, 252, 0], lemonchiffon: [255, 250, 205], lightblue: [173, 216, 230], lightcoral: [240, 128, 128], lightcyan: [224, 255, 255], lightgoldenrodyellow: [250, 250, 210], lightgray: [211, 211, 211], lightgreen: [144, 238, 144], lightgrey: [211, 211, 211], lightpink: [255, 182, 193], lightsalmon: [255, 160, 122], lightseagreen: [32, 178, 170], lightskyblue: [135, 206, 250], lightslategray: [119, 136, 153], lightslategrey: [119, 136, 153], lightsteelblue: [176, 196, 222], lightyellow: [255, 255, 224], lime: [0, 255, 0], limegreen: [50, 205, 50], linen: [250, 240, 230], magenta: [255, 0, 255], maroon: [128, 0, 0], mediumaquamarine: [102, 205, 170], mediumblue: [0, 0, 205], mediumorchid: [186, 85, 211], mediumpurple: [147, 112, 219], mediumseagreen: [60, 179, 113], mediumslateblue: [123, 104, 238], mediumspringgreen: [0, 250, 154], mediumturquoise: [72, 209, 204], mediumvioletred: [199, 21, 133], midnightblue: [25, 25, 112], mintcream: [245, 255, 250], mistyrose: [255, 228, 225], moccasin: [255, 228, 181], navajowhite: [255, 222, 173], navy: [0, 0, 128], oldlace: [253, 245, 230], olive: [128, 128, 0], olivedrab: [107, 142, 35], orange: [255, 165, 0], orangered: [255, 69, 0], orchid: [218, 112, 214], palegoldenrod: [238, 232, 170], palegreen: [152, 251, 152], paleturquoise: [175, 238, 238], palevioletred: [219, 112, 147], papayawhip: [255, 239, 213], peachpuff: [255, 218, 185], peru: [205, 133, 63], pink: [255, 192, 203], plum: [221, 160, 221], powderblue: [176, 224, 230], purple: [128, 0, 128], rebeccapurple: [102, 51, 153], red: [255, 0, 0], rosybrown: [188, 143, 143], royalblue: [65, 105, 225], saddlebrown: [139, 69, 19], salmon: [250, 128, 114], sandybrown: [244, 164, 96], seagreen: [46, 139, 87], seashell: [255, 245, 238], sienna: [160, 82, 45], silver: [192, 192, 192], skyblue: [135, 206, 235], slateblue: [106, 90, 205], slategray: [112, 128, 144], slategrey: [112, 128, 144], snow: [255, 250, 250], springgreen: [0, 255, 127], steelblue: [70, 130, 180], tan: [210, 180, 140], teal: [0, 128, 128], thistle: [216, 191, 216], tomato: [255, 99, 71], turquoise: [64, 224, 208], violet: [238, 130, 238], wheat: [245, 222, 179], white: [255, 255, 255], whitesmoke: [245, 245, 245], yellow: [255, 255, 0], yellowgreen: [154, 205, 50] };
});
var $s = q((Ws) => {
  "use strict";
  Object.defineProperty(Ws, "__esModule", { value: true });
  function gb(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  gb(Ws, { parseColor: () => Sb, formatColor: () => _b3 });
  var Cf = bb(If());
  function bb(e) {
    return e && e.__esModule ? e : { default: e };
  }
  var yb = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i, vb = /^#([a-f\d])([a-f\d])([a-f\d])([a-f\d])?$/i, tr = /(?:\d+|\d*\.\d+)%?/, Mi = /(?:\s*,\s*|\s+)/, Lf = /\s*[,/]\s*/, rr = /var\(--(?:[^ )]*?)\)/, xb = new RegExp(`^(rgb)a?\\(\\s*(${tr.source}|${rr.source})(?:${Mi.source}(${tr.source}|${rr.source}))?(?:${Mi.source}(${tr.source}|${rr.source}))?(?:${Lf.source}(${tr.source}|${rr.source}))?\\s*\\)$`), wb = new RegExp(`^(hsl)a?\\(\\s*((?:${tr.source})(?:deg|rad|grad|turn)?|${rr.source})(?:${Mi.source}(${tr.source}|${rr.source}))?(?:${Mi.source}(${tr.source}|${rr.source}))?(?:${Lf.source}(${tr.source}|${rr.source}))?\\s*\\)$`);
  function Sb(e, { loose: t = false } = {}) {
    var r, n;
    if (typeof e != "string")
      return null;
    if (e = e.trim(), e === "transparent")
      return { mode: "rgb", color: ["0", "0", "0"], alpha: "0" };
    if (e in Cf.default)
      return { mode: "rgb", color: Cf.default[e].map((u2) => u2.toString()) };
    let i = e.replace(vb, (u2, l2, f, c2, m2) => ["#", l2, l2, f, f, c2, c2, m2 ? m2 + m2 : ""].join("")).match(yb);
    if (i !== null)
      return { mode: "rgb", color: [parseInt(i[1], 16), parseInt(i[2], 16), parseInt(i[3], 16)].map((u2) => u2.toString()), alpha: i[4] ? (parseInt(i[4], 16) / 255).toString() : void 0 };
    var o;
    let s = (o = e.match(xb)) !== null && o !== void 0 ? o : e.match(wb);
    if (s === null)
      return null;
    let a = [s[2], s[3], s[4]].filter(Boolean).map((u2) => u2.toString());
    return !t && a.length !== 3 || a.length < 3 && !a.some((u2) => /^var\(.*?\)$/.test(u2)) ? null : { mode: s[1], color: a, alpha: (r = s[5]) === null || r === void 0 || (n = r.toString) === null || n === void 0 ? void 0 : n.call(r) };
  }
  function _b3({ mode: e, color: t, alpha: r }) {
    let n = r !== void 0;
    return `${e}(${t.join(" ")}${n ? ` / ${r}` : ""})`;
  }
});
var Us = q((Bs) => {
  "use strict";
  Object.defineProperty(Bs, "__esModule", { value: true });
  function Tb(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  Tb(Bs, { withAlphaValue: () => Eb, default: () => kb });
  var Fi = $s();
  function Eb(e, t, r) {
    if (typeof e == "function")
      return e({ opacityValue: t });
    let n = (0, Fi.parseColor)(e, { loose: true });
    return n === null ? r : (0, Fi.formatColor)({ ...n, alpha: t });
  }
  function kb({ color: e, property: t, variable: r }) {
    let n = [].concat(t);
    if (typeof e == "function")
      return { [r]: "1", ...Object.fromEntries(n.map((o) => [o, e({ opacityVariable: r, opacityValue: `var(${r})` })])) };
    let i = (0, Fi.parseColor)(e);
    return i === null ? Object.fromEntries(n.map((o) => [o, e])) : i.alpha !== void 0 ? Object.fromEntries(n.map((o) => [o, e])) : { [r]: "1", ...Object.fromEntries(n.map((o) => [o, (0, Fi.formatColor)({ ...i, alpha: `var(${r})` })])) };
  }
});
var Wf = q((qs) => {
  "use strict";
  Object.defineProperty(qs, "__esModule", { value: true });
  function Pb(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  Pb(qs, { pattern: () => Rb, withoutCapturing: () => Ff, any: () => Nf, optional: () => Ab, zeroOrMore: () => Ib, nestedBrackets: () => Df, escape: () => hr });
  var Mf = /[\\^$.*+?()[\]{}|]/g, Ob = RegExp(Mf.source);
  function On(e) {
    return e = Array.isArray(e) ? e : [e], e = e.map((t) => t instanceof RegExp ? t.source : t), e.join("");
  }
  function Rb(e) {
    return new RegExp(On(e), "g");
  }
  function Ff(e) {
    return new RegExp(`(?:${On(e)})`, "g");
  }
  function Nf(e) {
    return `(?:${e.map(On).join("|")})`;
  }
  function Ab(e) {
    return `(?:${On(e)})?`;
  }
  function Ib(e) {
    return `(?:${On(e)})*`;
  }
  function Df(e, t, r = 1) {
    return Ff([hr(e), /[^\s]*/, r === 1 ? `[^${hr(e)}${hr(t)}s]*` : Nf([`[^${hr(e)}${hr(t)}s]*`, Df(e, t, r - 1)]), /[^\s]*/, hr(t)]);
  }
  function hr(e) {
    return e && Ob.test(e) ? e.replace(Mf, "\\$&") : e || "";
  }
});
var Bf = q((zs) => {
  "use strict";
  Object.defineProperty(zs, "__esModule", { value: true });
  Object.defineProperty(zs, "splitAtTopLevelOnly", { enumerable: true, get: () => Mb });
  var Cb = Lb(Wf());
  function $f(e) {
    if (typeof WeakMap != "function")
      return null;
    var t = /* @__PURE__ */ new WeakMap(), r = /* @__PURE__ */ new WeakMap();
    return ($f = function(n) {
      return n ? r : t;
    })(e);
  }
  function Lb(e, t) {
    if (!t && e && e.__esModule)
      return e;
    if (e === null || typeof e != "object" && typeof e != "function")
      return { default: e };
    var r = $f(t);
    if (r && r.has(e))
      return r.get(e);
    var n = {}, i = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for (var o in e)
      if (o !== "default" && Object.prototype.hasOwnProperty.call(e, o)) {
        var s = i ? Object.getOwnPropertyDescriptor(e, o) : null;
        s && (s.get || s.set) ? Object.defineProperty(n, o, s) : n[o] = e[o];
      }
    return n.default = e, r && r.set(e, n), n;
  }
  function* Mb(e, t) {
    let r = new RegExp(`[(){}\\[\\]${Cb.escape(t)}]`, "g"), n = 0, i = 0, o = false, s = 0, a = 0, u2 = t.length;
    for (let l2 of e.matchAll(r)) {
      let f = l2[0] === t[s], c2 = s === u2 - 1, m2 = f && c2;
      l2[0] === "(" && n++, l2[0] === ")" && n--, l2[0] === "[" && n++, l2[0] === "]" && n--, l2[0] === "{" && n++, l2[0] === "}" && n--, f && n === 0 && (a === 0 && (a = l2.index), s++), m2 && n === 0 && (o = true, yield e.substring(i, a), i = a + u2), s === u2 && (s = 0, a = 0);
    }
    o ? yield e.substring(i) : yield e;
  }
});
var qf = q((Gs) => {
  "use strict";
  Object.defineProperty(Gs, "__esModule", { value: true });
  function Fb(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  Fb(Gs, { parseBoxShadowValue: () => $b, formatBoxShadowValue: () => Bb });
  var Nb = Bf(), Db = /* @__PURE__ */ new Set(["inset", "inherit", "initial", "revert", "unset"]), Wb = /\ +(?![^(]*\))/g, Uf = /^-?(\d+|\.\d+)(.*?)$/g;
  function $b(e) {
    return Array.from((0, Nb.splitAtTopLevelOnly)(e, ",")).map((r) => {
      let n = r.trim(), i = { raw: n }, o = n.split(Wb), s = /* @__PURE__ */ new Set();
      for (let a of o)
        Uf.lastIndex = 0, !s.has("KEYWORD") && Db.has(a) ? (i.keyword = a, s.add("KEYWORD")) : Uf.test(a) ? s.has("X") ? s.has("Y") ? s.has("BLUR") ? s.has("SPREAD") || (i.spread = a, s.add("SPREAD")) : (i.blur = a, s.add("BLUR")) : (i.y = a, s.add("Y")) : (i.x = a, s.add("X")) : i.color ? (i.unknown || (i.unknown = []), i.unknown.push(a)) : i.color = a;
      return i.valid = i.x !== void 0 && i.y !== void 0, i;
    });
  }
  function Bb(e) {
    return e.map((t) => t.valid ? [t.keyword, t.x, t.y, t.blur, t.spread, t.color].filter(Boolean).join(" ") : t.raw).join(", ");
  }
});
var Xf = q((Vs) => {
  "use strict";
  Object.defineProperty(Vs, "__esModule", { value: true });
  function Ub(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  Ub(Vs, { normalize: () => nr, url: () => jf, number: () => Gb, percentage: () => Vf, length: () => Hf, lineWidth: () => Hb, shadow: () => Yb, color: () => Xb, image: () => Kb, gradient: () => Yf, position: () => Zb, familyName: () => ey, genericName: () => ry, absoluteSize: () => iy, relativeSize: () => sy });
  var qb = $s(), zb = qf(), js = ["min", "max", "clamp", "calc"], Gf = /,(?![^(]*\))/g, Ni = /_(?![^(]*\))/g;
  function nr(e, t = true) {
    return e.includes("url(") ? e.split(/(url\(.*?\))/g).filter(Boolean).map((r) => /^url\(.*?\)$/.test(r) ? r : nr(r, false)).join("") : (e = e.replace(/([^\\])_+/g, (r, n) => n + " ".repeat(r.length - 1)).replace(/^_/g, " ").replace(/\\_/g, "_"), t && (e = e.trim()), e = e.replace(/(calc|min|max|clamp)\(.+\)/g, (r) => r.replace(/(-?\d*\.?\d(?!\b-.+[,)](?![^+\-/*])\D)(?:%|[a-z]+)?|\))([+\-/*])/g, "$1 $2 ")), e);
  }
  function jf(e) {
    return e.startsWith("url(");
  }
  function Gb(e) {
    return !isNaN(Number(e)) || js.some((t) => new RegExp(`^${t}\\(.+?`).test(e));
  }
  function Vf(e) {
    return e.split(Ni).every((t) => /%$/g.test(t) || js.some((r) => new RegExp(`^${r}\\(.+?%`).test(t)));
  }
  var jb = ["cm", "mm", "Q", "in", "pc", "pt", "px", "em", "ex", "ch", "rem", "lh", "vw", "vh", "vmin", "vmax"], zf = `(?:${jb.join("|")})`;
  function Hf(e) {
    return e.split(Ni).every((t) => t === "0" || new RegExp(`${zf}$`).test(t) || js.some((r) => new RegExp(`^${r}\\(.+?${zf}`).test(t)));
  }
  var Vb = /* @__PURE__ */ new Set(["thin", "medium", "thick"]);
  function Hb(e) {
    return Vb.has(e);
  }
  function Yb(e) {
    let t = (0, zb.parseBoxShadowValue)(nr(e));
    for (let r of t)
      if (!r.valid)
        return false;
    return true;
  }
  function Xb(e) {
    let t = 0;
    return e.split(Ni).every((n) => (n = nr(n), n.startsWith("var(") ? true : (0, qb.parseColor)(n, { loose: true }) !== null ? (t++, true) : false)) ? t > 0 : false;
  }
  function Kb(e) {
    let t = 0;
    return e.split(Gf).every((n) => (n = nr(n), n.startsWith("var(") ? true : jf(n) || Yf(n) || ["element(", "image(", "cross-fade(", "image-set("].some((i) => n.startsWith(i)) ? (t++, true) : false)) ? t > 0 : false;
  }
  var Qb = /* @__PURE__ */ new Set(["linear-gradient", "radial-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "conic-gradient"]);
  function Yf(e) {
    e = nr(e);
    for (let t of Qb)
      if (e.startsWith(`${t}(`))
        return true;
    return false;
  }
  var Jb = /* @__PURE__ */ new Set(["center", "top", "right", "bottom", "left"]);
  function Zb(e) {
    let t = 0;
    return e.split(Ni).every((n) => (n = nr(n), n.startsWith("var(") ? true : Jb.has(n) || Hf(n) || Vf(n) ? (t++, true) : false)) ? t > 0 : false;
  }
  function ey(e) {
    let t = 0;
    return e.split(Gf).every((n) => (n = nr(n), n.startsWith("var(") ? true : n.includes(" ") && !/(['"])([^"']+)\1/g.test(n) || /^\d/g.test(n) ? false : (t++, true))) ? t > 0 : false;
  }
  var ty = /* @__PURE__ */ new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]);
  function ry(e) {
    return ty.has(e);
  }
  var ny = /* @__PURE__ */ new Set(["xx-small", "x-small", "small", "medium", "large", "x-large", "x-large", "xxx-large"]);
  function iy(e) {
    return ny.has(e);
  }
  var oy = /* @__PURE__ */ new Set(["larger", "smaller"]);
  function sy(e) {
    return oy.has(e);
  }
});
var nc = q((Xs) => {
  "use strict";
  Object.defineProperty(Xs, "__esModule", { value: true });
  function ay(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  ay(Xs, { updateAllClasses: () => fy, asValue: () => An, parseColorFormat: () => Hs, asColor: () => ec3, asLookupValue: () => tc, coerceValue: () => hy });
  var uy = Ys(Of()), ly = Ys(Rf()), Kf = Us(), et3 = Xf(), Qf = Ys(Lo());
  function Ys(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function fy(e, t) {
    return (0, uy.default)((i) => {
      i.walkClasses((o) => {
        let s = t(o.value);
        o.value = s, o.raws && o.raws.value && (o.raws.value = (0, ly.default)(o.raws.value));
      });
    }).processSync(e);
  }
  function Zf(e, t) {
    if (!Rn(e))
      return;
    let r = e.slice(1, -1);
    if (t(r))
      return (0, et3.normalize)(r);
  }
  function cy(e, t = {}, r) {
    let n = t[e];
    if (n !== void 0)
      return (0, Qf.default)(n);
    if (Rn(e)) {
      let i = Zf(e, r);
      return i === void 0 ? void 0 : (0, Qf.default)(i);
    }
  }
  function An(e, t = {}, { validate: r = () => true } = {}) {
    var n;
    let i = (n = t.values) === null || n === void 0 ? void 0 : n[e];
    return i !== void 0 ? i : t.supportsNegativeValues && e.startsWith("-") ? cy(e.slice(1), t.values, r) : Zf(e, r);
  }
  function Rn(e) {
    return e.startsWith("[") && e.endsWith("]");
  }
  function dy(e) {
    let t = e.lastIndexOf("/");
    return t === -1 || t === e.length - 1 ? [e] : [e.slice(0, t), e.slice(t + 1)];
  }
  function Hs(e) {
    if (typeof e == "string" && e.includes("<alpha-value>")) {
      let t = e;
      return ({ opacityValue: r = 1 }) => t.replace("<alpha-value>", r);
    }
    return e;
  }
  function ec3(e, t = {}, { tailwindConfig: r = {} } = {}) {
    var n;
    if (((n = t.values) === null || n === void 0 ? void 0 : n[e]) !== void 0) {
      var i;
      return Hs((i = t.values) === null || i === void 0 ? void 0 : i[e]);
    }
    let [o, s] = dy(e);
    if (s !== void 0) {
      var a, u2, l2, f;
      let c2 = (f = (a = t.values) === null || a === void 0 ? void 0 : a[o]) !== null && f !== void 0 ? f : Rn(o) ? o.slice(1, -1) : void 0;
      return c2 === void 0 ? void 0 : (c2 = Hs(c2), Rn(s) ? (0, Kf.withAlphaValue)(c2, s.slice(1, -1)) : ((u2 = r.theme) === null || u2 === void 0 || (l2 = u2.opacity) === null || l2 === void 0 ? void 0 : l2[s]) === void 0 ? void 0 : (0, Kf.withAlphaValue)(c2, r.theme.opacity[s]));
    }
    return An(e, t, { validate: et3.color });
  }
  function tc(e, t = {}) {
    var r;
    return (r = t.values) === null || r === void 0 ? void 0 : r[e];
  }
  function bt(e) {
    return (t, r) => An(t, r, { validate: e });
  }
  var rc = { any: An, color: ec3, url: bt(et3.url), image: bt(et3.image), length: bt(et3.length), percentage: bt(et3.percentage), position: bt(et3.position), lookup: tc, "generic-name": bt(et3.genericName), "family-name": bt(et3.familyName), number: bt(et3.number), "line-width": bt(et3.lineWidth), "absolute-size": bt(et3.absoluteSize), "relative-size": bt(et3.relativeSize), shadow: bt(et3.shadow) }, Jf = Object.keys(rc);
  function py(e, t) {
    let r = e.indexOf(t);
    return r === -1 ? [void 0, e] : [e.slice(0, r), e.slice(r + 1)];
  }
  function hy(e, t, r, n) {
    if (Rn(t)) {
      let i = t.slice(1, -1), [o, s] = py(i, ":");
      if (!/^[\w-_]+$/g.test(o))
        s = i;
      else if (o !== void 0 && !Jf.includes(o))
        return [];
      if (s.length > 0 && Jf.includes(o))
        return [An(`[${s}]`, r), o];
    }
    for (let i of [].concat(e)) {
      let o = rc[i](t, r, { tailwindConfig: n });
      if (o !== void 0)
        return [o, i];
    }
    return [];
  }
});
var ic = q((Ks) => {
  "use strict";
  Object.defineProperty(Ks, "__esModule", { value: true });
  Object.defineProperty(Ks, "default", { enumerable: true, get: () => my });
  function my(e) {
    return typeof e == "function" ? e({}) : e;
  }
});
var lc = q((Js) => {
  "use strict";
  Object.defineProperty(Js, "__esModule", { value: true });
  Object.defineProperty(Js, "default", { enumerable: true, get: () => Fy });
  var gy = mr(Lo()), by = mr(cl()), yy = mr(dl()), vy = mr(No()), xy = mr(hl()), ac = ml(), oc = gl(), wy = yl(), Sy = mr(vl()), _y = xl(), Ty = nc(), Ey = Us(), ky = mr(ic());
  function mr(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Mr(e) {
    return typeof e == "function";
  }
  function In(e) {
    return typeof e == "object" && e !== null;
  }
  function Cn(e, ...t) {
    let r = t.pop();
    for (let n of t)
      for (let i in n) {
        let o = r(e[i], n[i]);
        o === void 0 ? In(e[i]) && In(n[i]) ? e[i] = Cn(e[i], n[i], r) : e[i] = n[i] : e[i] = o;
      }
    return e;
  }
  var Qs = { colors: xy.default, negative(e) {
    return Object.keys(e).filter((t) => e[t] !== "0").reduce((t, r) => {
      let n = (0, gy.default)(e[r]);
      return n !== void 0 && (t[`-${r}`] = n), t;
    }, {});
  }, breakpoints(e) {
    return Object.keys(e).filter((t) => typeof e[t] == "string").reduce((t, r) => ({ ...t, [`screen-${r}`]: e[r] }), {});
  } };
  function Py(e, ...t) {
    return Mr(e) ? e(...t) : e;
  }
  function Oy(e) {
    return e.reduce((t, { extend: r }) => Cn(t, r, (n, i) => n === void 0 ? [i] : Array.isArray(n) ? [i, ...n] : [i, n]), {});
  }
  function Ry(e) {
    return { ...e.reduce((t, r) => (0, ac.defaults)(t, r), {}), extend: Oy(e) };
  }
  function sc(e, t) {
    if (Array.isArray(e) && In(e[0]))
      return e.concat(t);
    if (Array.isArray(t) && In(t[0]) && In(e))
      return [e, ...t];
    if (Array.isArray(t))
      return t;
  }
  function Ay({ extend: e, ...t }) {
    return Cn(t, e, (r, n) => !Mr(r) && !n.some(Mr) ? Cn({}, r, ...n, sc) : (i, o) => Cn({}, ...[r, ...n].map((s) => Py(s, i, o)), sc));
  }
  function* Iy(e) {
    let t = (0, oc.toPath)(e);
    if (t.length === 0 || (yield t, Array.isArray(e)))
      return;
    let r = /^(.*?)\s*\/\s*([^/]+)$/, n = e.match(r);
    if (n !== null) {
      let [, i, o] = n, s = (0, oc.toPath)(i);
      s.alpha = o, yield s;
    }
  }
  function Cy(e) {
    let t = (r, n) => {
      for (let i of Iy(r)) {
        let o = 0, s = e;
        for (; s != null && o < i.length; )
          s = s[i[o++]], s = Mr(s) && (i.alpha === void 0 || o <= i.length - 1) ? s(t, Qs) : s;
        if (s !== void 0) {
          if (i.alpha !== void 0) {
            let a = (0, Ty.parseColorFormat)(s);
            return (0, Ey.withAlphaValue)(a, i.alpha, (0, ky.default)(a));
          }
          return (0, Sy.default)(s) ? (0, _y.cloneDeep)(s) : s;
        }
      }
      return n;
    };
    return Object.assign(t, { theme: t, ...Qs }), Object.keys(e).reduce((r, n) => (r[n] = Mr(e[n]) ? e[n](t, Qs) : e[n], r), {});
  }
  function uc(e) {
    let t = [];
    return e.forEach((r) => {
      t = [...t, r];
      var n;
      let i = (n = r == null ? void 0 : r.plugins) !== null && n !== void 0 ? n : [];
      i.length !== 0 && i.forEach((o) => {
        o.__isOptionsFunction && (o = o());
        var s;
        t = [...t, ...uc([(s = o == null ? void 0 : o.config) !== null && s !== void 0 ? s : {}])];
      });
    }), t;
  }
  function Ly(e) {
    return [...e].reduceRight((r, n) => Mr(n) ? n({ corePlugins: r }) : (0, yy.default)(n, r), by.default);
  }
  function My(e) {
    return [...e].reduceRight((r, n) => [...r, ...n], []);
  }
  function Fy(e) {
    let t = [...uc(e), { prefix: "", important: false, separator: ":", variantOrder: vy.default.variantOrder }];
    var r, n;
    return (0, wy.normalizeConfig)((0, ac.defaults)({ theme: Cy(Ay(Ry(t.map((i) => (r = i == null ? void 0 : i.theme) !== null && r !== void 0 ? r : {})))), corePlugins: Ly(t.map((i) => i.corePlugins)), plugins: My(e.map((i) => (n = i == null ? void 0 : i.plugins) !== null && n !== void 0 ? n : [])) }, ...t));
  }
});
var fc = {};
Gn(fc, { default: () => Ny });
var Ny;
var cc = ar(() => {
  Ny = { yellow: (e) => e };
});
var mc = q((Zs) => {
  "use strict";
  Object.defineProperty(Zs, "__esModule", { value: true });
  function Dy(e, t) {
    for (var r in t)
      Object.defineProperty(e, r, { enumerable: true, get: t[r] });
  }
  Dy(Zs, { flagEnabled: () => By, issueFlagNotices: () => Uy, default: () => qy });
  var Wy = hc((cc(), jn(fc))), $y = hc((wi(), jn(xi)));
  function hc(e) {
    return e && e.__esModule ? e : { default: e };
  }
  var dc = { optimizeUniversalDefaults: false }, Ln = { future: ["hoverOnlyWhenSupported", "respectDefaultRingColorOpacity"], experimental: ["optimizeUniversalDefaults", "matchVariant"] };
  function By(e, t) {
    if (Ln.future.includes(t)) {
      var r, n, i;
      return e.future === "all" || ((i = (n = e == null || (r = e.future) === null || r === void 0 ? void 0 : r[t]) !== null && n !== void 0 ? n : dc[t]) !== null && i !== void 0 ? i : false);
    }
    if (Ln.experimental.includes(t)) {
      var o, s, a;
      return e.experimental === "all" || ((a = (s = e == null || (o = e.experimental) === null || o === void 0 ? void 0 : o[t]) !== null && s !== void 0 ? s : dc[t]) !== null && a !== void 0 ? a : false);
    }
    return false;
  }
  function pc(e) {
    if (e.experimental === "all")
      return Ln.experimental;
    var t;
    return Object.keys((t = e == null ? void 0 : e.experimental) !== null && t !== void 0 ? t : {}).filter((r) => Ln.experimental.includes(r) && e.experimental[r]);
  }
  function Uy(e) {
    if (process.env.JEST_WORKER_ID === void 0 && pc(e).length > 0) {
      let t = pc(e).map((r) => Wy.default.yellow(r)).join(", ");
      $y.default.warn("experimental-flags-enabled", [`You have enabled experimental features: ${t}`, "Experimental features in Tailwind CSS are not covered by semver, may introduce breaking changes, and can change at any time."]);
    }
  }
  var qy = Ln;
});
var bc = q((ea) => {
  "use strict";
  Object.defineProperty(ea, "__esModule", { value: true });
  Object.defineProperty(ea, "default", { enumerable: true, get: () => gc });
  var zy = jy(No()), Gy = mc();
  function jy(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function gc(e) {
    var t;
    let r = ((t = e == null ? void 0 : e.presets) !== null && t !== void 0 ? t : [zy.default]).slice().reverse().flatMap((o) => gc(typeof o == "function" ? o() : o)), n = { respectDefaultRingColorOpacity: { theme: { ringColor: { DEFAULT: "#3b82f67f" } } } }, i = Object.keys(n).filter((o) => (0, Gy.flagEnabled)(e, o)).map((o) => n[o]);
    return [e, ...i, ...r];
  }
});
var vc = q((ta) => {
  "use strict";
  Object.defineProperty(ta, "__esModule", { value: true });
  Object.defineProperty(ta, "default", { enumerable: true, get: () => Yy });
  var Vy = yc(lc()), Hy = yc(bc());
  function yc(e) {
    return e && e.__esModule ? e : { default: e };
  }
  function Yy(...e) {
    let [, ...t] = (0, Hy.default)(e[0]);
    return (0, Vy.default)([...e, ...t]);
  }
});
var wc = q((pS, xc) => {
  var ra = vc();
  xc.exports = (ra.__esModule ? ra : { default: ra }).default;
});
var Gr = (e, t) => () => (t || e((t = { exports: {} }).exports, t), t.exports);
var sd = Gr((e, t) => {
  t.exports = ["em", "ex", "ch", "rem", "vh", "vw", "vmin", "vmax", "px", "mm", "cm", "in", "pt", "pc", "mozmm"];
});
var ad = Gr((e, t) => {
  t.exports = ["deg", "grad", "rad", "turn"];
});
var ud = Gr((e, t) => {
  t.exports = ["dpi", "dpcm", "dppx"];
});
var ld = Gr((e, t) => {
  t.exports = ["Hz", "kHz"];
});
var fd3 = Gr((e, t) => {
  t.exports = ["s", "ms"];
});
var cd = sd();
var Pa = ad();
var Oa = ud();
var Ra = ld();
var Aa = fd3();
function qi(e) {
  if (/\.\D?$/.test(e))
    throw new Error("The dot should be followed by a number");
  if (/^[+-]{2}/.test(e))
    throw new Error("Only one leading +/- is allowed");
  if (dd(e) > 1)
    throw new Error("Only one dot is allowed");
  if (/%$/.test(e)) {
    this.type = "percentage", this.value = Ui(e), this.unit = "%";
    return;
  }
  var t = hd(e);
  if (!t) {
    this.type = "number", this.value = Ui(e);
    return;
  }
  this.type = gd(t), this.value = Ui(e.substr(0, e.length - t.length)), this.unit = t;
}
qi.prototype.valueOf = function() {
  return this.value;
};
qi.prototype.toString = function() {
  return this.value + (this.unit || "");
};
function wt(e) {
  return new qi(e);
}
function dd(e) {
  var t = e.match(/\./g);
  return t ? t.length : 0;
}
function Ui(e) {
  var t = parseFloat(e);
  if (isNaN(t))
    throw new Error("Invalid number: " + e);
  return t;
}
var pd = [].concat(Pa, Ra, cd, Oa, Aa);
function hd(e) {
  var t = e.match(/\D+$/), r = t && t[0];
  if (r && pd.indexOf(r) === -1)
    throw new Error("Invalid unit: " + r);
  return r;
}
var md = Object.assign(Vn(Pa, "angle"), Vn(Ra, "frequency"), Vn(Oa, "resolution"), Vn(Aa, "time"));
function Vn(e, t) {
  return Object.fromEntries(e.map((r) => [r, t]));
}
function gd(e) {
  return md[e] || "length";
}
function Sr(e) {
  let t = typeof e;
  return !(t === "number" || t === "bigint" || t === "string" || t === "boolean");
}
function Ma(e) {
  return /^class\s/.test(e.toString());
}
function ji(e) {
  return e && e.$$typeof === Symbol.for("react.forward_ref");
}
function Fa(e) {
  return typeof e == "function" || ji(e);
}
function Na(e) {
  return "dangerouslySetInnerHTML" in e;
}
function Da(e) {
  let t = typeof e > "u" ? [] : [].concat(e).flat(1 / 0), r = [];
  for (let n = 0; n < t.length; n++) {
    let i = t[n];
    typeof i > "u" || typeof i == "boolean" || i === null || (typeof i == "number" && (i = String(i)), typeof i == "string" && r.length && typeof r[r.length - 1] == "string" ? r[r.length - 1] += i : r.push(i));
  }
  return r;
}
function X(e, t, r, n, i = false) {
  if (typeof e == "number")
    return e;
  try {
    if (e = e.trim(), /[ /\(,]/.test(e))
      return;
    if (e === String(+e))
      return +e;
    let o = new wt(e);
    if (o.type === "length")
      switch (o.unit) {
        case "em":
          return o.value * t;
        case "rem":
          return o.value * 16;
        case "vw":
          return ~~(o.value * n._viewportWidth / 100);
        case "vh":
          return ~~(o.value * n._viewportHeight / 100);
        default:
          return o.value;
      }
    else {
      if (o.type === "angle")
        return ur(e);
      if (o.type === "percentage" && i)
        return o.value / 100 * r;
    }
  } catch {
  }
}
function ur(e) {
  let t = new wt(e);
  switch (t.unit) {
    case "deg":
      return t.value;
    case "rad":
      return t.value * 180 / Math.PI;
    case "turn":
      return t.value * 360;
    case "grad":
      return 0.9 * t.value;
  }
}
function jr(e, t) {
  return [e[0] * t[0] + e[2] * t[1], e[1] * t[0] + e[3] * t[1], e[0] * t[2] + e[2] * t[3], e[1] * t[2] + e[3] * t[3], e[0] * t[4] + e[2] * t[5] + e[4], e[1] * t[4] + e[3] * t[5] + e[5]];
}
function Ke(e, t, r, n) {
  let i = t[e];
  if (typeof i > "u") {
    if (n && typeof e < "u")
      throw new Error(`Invalid value for CSS property "${n}". Allowed values: ${Object.keys(t).map((o) => `"${o}"`).join(" | ")}. Received: "${e}".`);
    i = r;
  }
  return i;
}
var zi;
var Gi;
var Wa = [32, 160, 4961, 65792, 65793, 4153, 4241, 10].map((e) => String.fromCodePoint(e));
var wr = /* @__PURE__ */ new Map();
var yd = 500;
function De(e, t, r) {
  let n = `${t}:${r || ""}:${e}`;
  if (wr.has(n))
    return wr.get(n);
  if (!zi || !Gi) {
    if (!(typeof Intl < "u" && "Segmenter" in Intl))
      throw new Error("Intl.Segmenter does not exist, please use import a polyfill.");
    zi = new Intl.Segmenter(r, { granularity: "word" }), Gi = new Intl.Segmenter(r, { granularity: "grapheme" });
  }
  let i;
  if (t === "grapheme")
    i = [...Gi.segment(e)].map((o) => o.segment);
  else {
    let o = [...zi.segment(e)].map((u2) => u2.segment), s = [], a = 0;
    for (; a < o.length; ) {
      let u2 = o[a];
      if (u2 == "\xA0") {
        let l2 = a === 0 ? "" : s.pop(), f = a === o.length - 1 ? "" : o[a + 1];
        s.push(l2 + "\xA0" + f), a += 2;
      } else
        s.push(u2), a++;
    }
    i = s;
  }
  if (wr.size >= yd) {
    let o = wr.keys().next().value;
    wr.delete(o);
  }
  return wr.set(n, i), i;
}
function I(e, t, r) {
  Ca(e, "element");
  let n = "";
  for (let [i, o] of Object.entries(t))
    typeof o < "u" && (Ca(i, "attribute"), n += ` ${i}="${wd(o)}"`);
  return r ? `<${e}${n}>${r}</${e}>` : `<${e}${n}/>`;
}
var $a = ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
var vd = $a + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
var xd = new RegExp("^[" + $a + "][" + vd + "]*$", "u");
var Ia = /* @__PURE__ */ new Set();
function Ca(e, t) {
  if (!Ia.has(e)) {
    if (!xd.test(e))
      throw new Error(`Invalid XML ${t} name: ${JSON.stringify(e)}`);
    Ia.add(e);
  }
}
function wd(e) {
  return typeof e == "number" || typeof e == "bigint" || typeof e == "boolean" ? "" + e : (0, import_escape_html.default)(String(e));
}
function Ba(e) {
  return (0, import_escape_html.default)(String(e));
}
function Ua(e = 20) {
  let t = /* @__PURE__ */ new Map();
  function r(o) {
    let s = t.get(o);
    if (s !== void 0)
      return t.delete(o), t.set(o, s), s;
  }
  function n(o, s) {
    if (t.has(o))
      t.delete(o);
    else if (t.size >= e) {
      let a = t.keys().next().value;
      t.delete(a);
    }
    t.set(o, s);
  }
  function i() {
    t.clear();
  }
  return { set: n, get: r, clear: i };
}
function _r(e) {
  return e ? e.split(/[, ]/).filter(Boolean).map(Number) : null;
}
function Hn(e) {
  return typeof e == "string";
}
function qa(e) {
  return typeof e == "number";
}
function za(e) {
  return typeof e > "u";
}
function qt(e, t) {
  if (typeof e == "number")
    return e;
  if (e.endsWith("%")) {
    let r = parseFloat(e.slice(0, -1));
    if (isNaN(r)) {
      console.warn(`Invalid value "${e}"${typeof t == "string" ? ` for "${t}"` : ""}. Expected a percentage value (e.g., "50%").`);
      return;
    }
    return `${r}%`;
  }
  console.warn(`Invalid value "${e}"${typeof t == "string" ? ` for "${t}"` : ""}. Expected a number or a percentage value (e.g., "50%").`);
}
function Kt(e, t) {
  if (typeof e == "number")
    return e;
  if (e === "auto")
    return "auto";
  if (e.endsWith("%")) {
    let r = parseFloat(e.slice(0, -1));
    if (isNaN(r)) {
      console.warn(`Invalid value "${e}"${typeof t == "string" ? ` for "${t}"` : ""}. Expected a percentage value (e.g., "50%").`);
      return;
    }
    return `${r}%`;
  }
  console.warn(`Invalid value "${e}"${typeof t == "string" ? ` for "${t}"` : ""}. Expected a number, "auto", or a percentage value (e.g., "50%").`);
}
function Ga(e, t) {
  if (t === "break-all")
    return { words: De(e, "grapheme"), requiredBreaks: [] };
  if (t === "keep-all")
    return { words: De(e, "word"), requiredBreaks: [] };
  let r = new $557adaaeb0c7885f$exports(e), n = 0, i = r.nextBreak(), o = [], s = [false];
  for (; i; ) {
    let a = e.slice(n, i.position);
    o.push(a), i.required ? s.push(true) : s.push(false), n = i.position, i = r.nextBreak();
  }
  return { words: o, requiredBreaks: s };
}
var ja = (e) => e.replaceAll(/([A-Z])/g, (t, r) => `-${r.toLowerCase()}`);
function zt(e, t = ",") {
  let r = [], n = 0, i = 0;
  t = new RegExp(t);
  for (let o = 0; o < e.length; o++)
    e[o] === "(" ? i++ : e[o] === ")" && i--, i === 0 && t.test(e[o]) && (r.push(e.slice(n, o).trim()), n = o + 1);
  return r.push(e.slice(n).trim()), r;
}
function Ad(e) {
  return Promise.resolve().then(() => (to(), eo)).then((t) => t.init(e));
}
function Qt() {
  return Promise.resolve().then(() => (to(), eo)).then((e) => e.getYoga());
}
var nu = Symbol.for("react.fragment");
var Qn = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
var Id = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function ro(e) {
  let t = e.split(".").map((o) => Number.parseInt(o, 10));
  if (t.length !== 4 || t.some((o) => !Number.isInteger(o) || o < 0 || o > 255))
    return true;
  let [r, n, i] = t;
  return r === 0 || r === 10 || r === 100 && n >= 64 && n <= 127 || r === 127 || r === 169 && n === 254 || r === 172 && n >= 16 && n <= 31 || r === 192 && n === 0 && i === 0 || r === 192 && n === 168 || r === 198 && (n === 18 || n === 19) || r >= 224;
}
function Cd(e) {
  let t = e, r = t.indexOf("%");
  r !== -1 && (t = t.slice(0, r));
  let n = t.split("::");
  if (n.length > 2)
    return null;
  let i = (s) => {
    if (s === "")
      return [];
    let a = [], u2 = s.split(":");
    for (let l2 = 0; l2 < u2.length; l2++) {
      let f = u2[l2];
      if (f.includes(".")) {
        if (l2 !== u2.length - 1 || !Qn.test(f))
          return null;
        let [c2, m2, h2, g2] = f.split(".").map((y) => Number.parseInt(y, 10));
        if ([c2, m2, h2, g2].some((y) => !Number.isInteger(y) || y < 0 || y > 255))
          return null;
        a.push(c2 << 8 | m2, h2 << 8 | g2);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(f))
        return null;
      a.push(Number.parseInt(f, 16));
    }
    return a;
  }, o = i(n[0]);
  if (o === null)
    return null;
  if (n.length === 2) {
    let s = i(n[1]);
    if (s === null)
      return null;
    let a = 8 - o.length - s.length;
    return a < 0 ? null : [...o, ...new Array(a).fill(0), ...s];
  }
  return o.length === 8 ? o : null;
}
function Ld(e) {
  let t = (a) => e.slice(0, a).every((u2) => u2 === 0);
  if (!(t(6) || t(5) && e[5] === 65535 || t(4) && e[4] === 65535 && e[5] === 0 || e[0] === 100 && e[1] === 65435 && e[2] === 0 && e[3] === 0 && e[4] === 0 && e[5] === 0 || e[0] === 100 && e[1] === 65435 && e[2] === 1))
    return null;
  let n = e[6] >> 8 & 255, i = e[6] & 255, o = e[7] >> 8 & 255, s = e[7] & 255;
  return `${n}.${i}.${o}.${s}`;
}
function ou(e) {
  let t = Cd(e);
  if (t === null)
    return true;
  let r = Ld(t);
  return r ? ro(r) : !!(t.every((n) => n === 0) || t.slice(0, 7).every((n) => n === 0) && t[7] === 1 || (t[0] & 65024) === 64512 || (t[0] & 65472) === 65152 || (t[0] & 65472) === 65216 || (t[0] & 65280) === 65280 || t[0] === 8193 && t[1] === 3512);
}
function Md(e) {
  let t = e.toLowerCase().replace(/^\[|\]$/g, "");
  return Qn.test(t) ? ro(t) : t.includes(":") ? ou(t) : true;
}
function su(e) {
  let t;
  try {
    t = new URL(e);
  } catch {
    return null;
  }
  if (t.protocol !== "http:" && t.protocol !== "https:")
    return null;
  let r = t.hostname.toLowerCase().replace(/\.+$/, "");
  return r.startsWith("[") && r.endsWith("]") && (r = r.slice(1, -1)), r ? { url: t, host: r } : null;
}
function Fd(e) {
  let t = su(e);
  if (!t)
    return true;
  let { host: r } = t;
  return r === "localhost" || r.endsWith(".localhost") || r === "local" || r.endsWith(".local") || r === "internal" || r.endsWith(".internal") ? true : Qn.test(r) ? ro(r) : r.includes(":") ? ou(r) : false;
}
function Kn(e) {
  return new Error(`Image source resolves to a blocked address (SSRF protection): ${e}`);
}
function Nd(e) {
  if (Fd(e))
    throw Kn(e);
}
var Pr;
async function Dd() {
  if (Pr !== void 0)
    return Pr;
  if (typeof window < "u")
    return Pr = null, null;
  try {
    let t = await new Function("s", "return import(s)")("node:dns/promises");
    return Pr = (r, n) => t.lookup(r, n), Pr;
  } catch {
    return Pr = null, null;
  }
}
async function Wd(e, t) {
  Nd(e);
  let r = su(e);
  if (!r)
    throw Kn(e);
  let { host: n } = r;
  if (Qn.test(n) || n.includes(":"))
    return;
  let i = t && "lookup" in t ? t.lookup : await Dd();
  if (!i)
    return;
  let o;
  try {
    o = await i(n, { all: true });
  } catch {
    throw new Error(`Can't resolve image host: ${e}`);
  }
  if (o.length === 0)
    throw new Error(`Can't resolve image host: ${e}`);
  for (let { address: s } of o)
    if (Md(s))
      throw Kn(e);
}
async function iu(e) {
  try {
    e.body && typeof e.body.cancel == "function" ? await e.body.cancel() : typeof e.arrayBuffer == "function" && await e.arrayBuffer();
  } catch {
  }
}
async function au(e, t) {
  let r = (t == null ? void 0 : t.fetch) ?? globalThis.fetch, n = e;
  for (let i = 0; i <= 10; i++) {
    await Wd(n, t);
    let o = await r(n, { redirect: "manual" });
    if (o.type === "opaqueredirect")
      throw await iu(o), Kn(n);
    let s = o.headers.get("location");
    if (Id.has(o.status) && s) {
      await iu(o), n = new URL(s, n).href;
      continue;
    }
    return o;
  }
  throw new Error(`Image source redirected too many times (SSRF protection): ${e}`);
}
var $d = "image/avif";
var Jn = "image/webp";
var Zn = "image/apng";
var ei = "image/png";
var ti = "image/jpeg";
var ri = "image/gif";
var no = "image/svg+xml";
function fu(e) {
  let t = new DataView(e), r = 4, n = t.byteLength;
  for (; r < n; ) {
    let i = t.getUint16(r, false);
    if (i > n)
      throw new TypeError("Invalid JPEG");
    let o = t.getUint8(i + 1 + r);
    if (o === 192 || o === 193 || o === 194)
      return [t.getUint16(i + 7 + r, false), t.getUint16(i + 5 + r, false)];
    r += i + 2;
  }
  throw new TypeError("Invalid JPEG");
}
function cu(e) {
  let t = new DataView(e), r = new Uint8Array(e);
  if (t.byteLength < 20 || t.getUint32(0) !== 1380533830 || t.getUint32(8) !== 1464156752)
    throw new TypeError("Invalid WebP");
  let n = t.getUint32(4, true) + 8;
  if (n < 20 || n > t.byteLength)
    throw new TypeError("Invalid WebP");
  let i = 12;
  for (; i + 8 <= n; ) {
    let o = t.getUint32(i), s = t.getUint32(i + 4, true), a = i + 8, u2 = a + s;
    if (u2 > n)
      throw new TypeError("Invalid WebP");
    if (o === 1448097824) {
      if (s < 10 || r[a + 3] !== 157 || r[a + 4] !== 1 || r[a + 5] !== 42)
        throw new TypeError("Invalid WebP");
      let l2 = t.getUint16(a + 6, true) & 16383, f = t.getUint16(a + 8, true) & 16383;
      if (!l2 || !f)
        throw new TypeError("Invalid WebP");
      return [l2, f];
    }
    if (o === 1448097868) {
      if (s < 5 || r[a] !== 47)
        throw new TypeError("Invalid WebP");
      let l2 = t.getUint32(a + 1, true);
      return [(l2 & 16383) + 1, (l2 >>> 14 & 16383) + 1];
    }
    if (o === 1448097880) {
      if (s < 10)
        throw new TypeError("Invalid WebP");
      return [r[a + 4] + (r[a + 5] << 8) + (r[a + 6] << 16) + 1, r[a + 7] + (r[a + 8] << 8) + (r[a + 9] << 16) + 1];
    }
    i = u2 + s % 2;
  }
  throw new TypeError("Invalid WebP");
}
function du(e) {
  let t = new Uint8Array(e.slice(6, 10));
  return [t[0] | t[1] << 8, t[2] | t[3] << 8];
}
function pu(e) {
  let t = new DataView(e);
  return [t.getUint16(18, false), t.getUint16(22, false)];
}
var At = Ua(500);
var Hr = /* @__PURE__ */ new Map();
var Bd = [ei, Zn, ti, ri, no, Jn];
var Ud = /<svg[^>]*>/i;
var qd = /viewBox=['"]([^'"]+)['"]/;
var zd = /width=['"](\d*\.?\d+)['"]/;
var Gd = /height=['"](\d*\.?\d+)['"]/;
function jd(e) {
  let t = new Uint8Array(e), r = 32768, n = "";
  for (let i = 0; i < t.length; i += r) {
    let o = t.subarray(i, Math.min(i + r, t.length));
    n += String.fromCharCode(...o);
  }
  return btoa(n);
}
function Vd(e) {
  let t = atob(e), r = t.length, n = new Uint8Array(r);
  for (let i = 0; i < r; i++)
    n[i] = t.charCodeAt(i);
  return n.buffer;
}
function uu(e, t) {
  let r = t.match(Ud);
  if (!r)
    throw new Error(`Failed to parse SVG from ${e}`);
  let n = r[0], i = qd.exec(n), o = zd.exec(n), s = Gd.exec(n), a = i ? _r(i[1]) : null;
  if (!a && (!o || !s))
    throw new Error(`Failed to parse SVG from ${e}: missing "viewBox"`);
  let u2 = a ? [a[2], a[3]] : [+o[1], +s[1]], l2 = u2[0] / u2[1];
  return o && s ? [+o[1], +s[1]] : o ? [+o[1], +o[1] / l2] : s ? [+s[1] * l2, +s[1]] : [u2[0], u2[1]];
}
function lu(e) {
  let t, r = Hd(new Uint8Array(e));
  switch (r) {
    case ei:
    case Zn:
      t = pu(e);
      break;
    case ri:
      t = du(e);
      break;
    case ti:
      t = fu(e);
      break;
    case Jn:
      t = cu(e);
      break;
  }
  if (!Bd.includes(r))
    throw new Error(`Unsupported image type: ${r || "unknown"}`);
  return [`data:${r};base64,${jd(e)}`, t];
}
async function Or(e) {
  if (!e)
    throw new Error("Image source is not provided.");
  if (typeof e == "object") {
    let [o, s] = lu(e);
    return [o, ...s];
  }
  if ((e.startsWith('"') && e.endsWith('"') || e.startsWith("'") && e.endsWith("'")) && (e = e.slice(1, -1)), typeof window > "u" && !e.startsWith("http") && !e.startsWith("data:"))
    throw new Error(`Image source must be an absolute URL: ${e}`);
  if (e.startsWith("data:")) {
    let o;
    try {
      o = /data:(?<imageType>[a-z/+]+)(;[^;=]+=[^;=]+)*?(;(?<encodingType>[^;,]+))?,(?<dataString>.*)/g.exec(e).groups;
    } catch {
      return console.warn("Image data URI resolved without size:" + e), [e];
    }
    let { imageType: s, encodingType: a, dataString: u2 } = o;
    if (s === no) {
      let l2 = a === "base64" ? atob(u2) : decodeURIComponent(u2.replace(/ /g, "%20")), f = a === "base64" ? e : `data:image/svg+xml;base64,${btoa(l2)}`, c2 = uu(e, l2);
      return At.set(e, [f, ...c2]), [f, ...c2];
    } else if (a === "base64") {
      let l2, f = Vd(u2);
      switch (s) {
        case ei:
        case Zn:
          l2 = pu(f);
          break;
        case ri:
          l2 = du(f);
          break;
        case ti:
          l2 = fu(f);
          break;
        case Jn:
          l2 = cu(f);
          break;
      }
      return At.set(e, [e, ...l2]), [e, ...l2];
    } else
      return console.warn("Image data URI resolved without size:" + e), At.set(e, [e]), [e];
  }
  if (!globalThis.fetch)
    throw new Error("`fetch` is required to be polyfilled to load images.");
  if (Hr.has(e))
    return Hr.get(e);
  let t = At.get(e);
  if (t)
    return t;
  let r = e, i = (typeof window > "u" ? () => au(r) : () => fetch(r))().then((o) => {
    let s = o.headers.get("content-type");
    return s === "image/svg+xml" || s === "application/svg+xml" ? o.text() : o.arrayBuffer();
  }).then((o) => {
    if (typeof o == "string")
      try {
        let u2 = `data:image/svg+xml;base64,${btoa(o)}`, l2 = uu(r, o);
        return [u2, ...l2];
      } catch (u2) {
        throw new Error(`Failed to parse SVG image: ${u2.message}`);
      }
    let [s, a] = lu(o);
    return [s, ...a];
  }).then((o) => (At.set(r, o), o)).catch((o) => {
    if (o instanceof Error && o.message.includes("SSRF protection"))
      throw o;
    return console.error(`Can't load image ${r}: ` + o.message), At.set(r, []), [];
  });
  return Hr.set(r, i), i;
}
function Hd(e) {
  return [255, 216, 255].every((t, r) => e[r] === t) ? ti : [137, 80, 78, 71, 13, 10, 26, 10].every((t, r) => e[r] === t) ? Yd(e) ? Zn : ei : [71, 73, 70, 56].every((t, r) => e[r] === t) ? ri : [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80].every((t, r) => !t || e[r] === t) ? Jn : [60, 63, 120, 109, 108].every((t, r) => e[r] === t) ? no : [0, 0, 0, 0, 102, 116, 121, 112, 97, 118, 105, 102].every((t, r) => !t || e[r] === t) ? $d : null;
}
function Yd(e) {
  let t = new DataView(e.buffer), r, n, i = 8, o = false;
  for (; !o && r !== "IEND" && i < e.length; ) {
    n = t.getUint32(i);
    let s = e.subarray(i + 4, i + 8);
    r = String.fromCharCode(...s), o = r === "acTL", i += 12 + n;
  }
  return o;
}
var hu = { accentHeight: "accent-height", alignmentBaseline: "alignment-baseline", arabicForm: "arabic-form", baselineShift: "baseline-shift", capHeight: "cap-height", clipPath: "clip-path", clipRule: "clip-rule", colorInterpolation: "color-interpolation", colorInterpolationFilters: "color-interpolation-filters", colorProfile: "color-profile", colorRendering: "color-rendering", dominantBaseline: "dominant-baseline", enableBackground: "enable-background", fillOpacity: "fill-opacity", fillRule: "fill-rule", floodColor: "flood-color", floodOpacity: "flood-opacity", fontFamily: "font-family", fontSize: "font-size", fontSizeAdjust: "font-size-adjust", fontStretch: "font-stretch", fontStyle: "font-style", fontVariant: "font-variant", fontWeight: "font-weight", glyphName: "glyph-name", glyphOrientationHorizontal: "glyph-orientation-horizontal", glyphOrientationVertical: "glyph-orientation-vertical", horizAdvX: "horiz-adv-x", horizOriginX: "horiz-origin-x", href: "href", imageRendering: "image-rendering", letterSpacing: "letter-spacing", lightingColor: "lighting-color", markerEnd: "marker-end", markerMid: "marker-mid", markerStart: "marker-start", overlinePosition: "overline-position", overlineThickness: "overline-thickness", paintOrder: "paint-order", panose1: "panose-1", pointerEvents: "pointer-events", renderingIntent: "rendering-intent", shapeRendering: "shape-rendering", stopColor: "stop-color", stopOpacity: "stop-opacity", strikethroughPosition: "strikethrough-position", strikethroughThickness: "strikethrough-thickness", strokeDasharray: "stroke-dasharray", strokeDashoffset: "stroke-dashoffset", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin", strokeMiterlimit: "stroke-miterlimit", strokeOpacity: "stroke-opacity", strokeWidth: "stroke-width", textAnchor: "text-anchor", textDecoration: "text-decoration", textRendering: "text-rendering", underlinePosition: "underline-position", underlineThickness: "underline-thickness", unicodeBidi: "unicode-bidi", unicodeRange: "unicode-range", unitsPerEm: "units-per-em", vAlphabetic: "v-alphabetic", vHanging: "v-hanging", vIdeographic: "v-ideographic", vMathematical: "v-mathematical", vectorEffect: "vector-effect", vertAdvY: "vert-adv-y", vertOriginX: "vert-origin-x", vertOriginY: "vert-origin-y", wordSpacing: "word-spacing", writingMode: "writing-mode", xHeight: "x-height", xlinkActuate: "xlink:actuate", xlinkArcrole: "xlink:arcrole", xlinkHref: "xlink:href", xlinkRole: "xlink:role", xlinkShow: "xlink:show", xlinkTitle: "xlink:title", xlinkType: "xlink:type", xmlBase: "xml:base", xmlLang: "xml:lang", xmlSpace: "xml:space", xmlnsXlink: "xmlns:xlink" };
var Xd = /[\r\n%#()<>?[\\\]^`{|}"'&]/g;
function ni(e, t) {
  if (!e)
    return "";
  if (Array.isArray(e))
    return e.map((u2) => ni(u2, t)).join("");
  if (typeof e != "object")
    return Ba(e);
  let r = e.type;
  if (r === "text")
    throw new Error("<text> nodes are not currently supported, please convert them to <path>");
  let { children: n, style: i, ...o } = e.props || {}, s = (i == null ? void 0 : i.color) || t;
  if (r === nu)
    return ni(n, s);
  if (typeof r != "string")
    throw new Error("Only intrinsic elements are supported inside <svg>");
  let a = {};
  for (let [u2, l2] of Object.entries(o)) {
    let f = l2;
    typeof f == "string" && f.toLowerCase() === "currentcolor" && (f = s), (u2 === "href" || u2 === "xlinkHref") && r === "image" && (f = At.get(f)[0]);
    let c2 = hu[u2] || u2;
    a[c2] = f;
  }
  return i && (a.style = Object.entries(i).map(([u2, l2]) => `${ja(u2)}:${l2}`).join(";")), I(r, a, ni(n, s));
}
async function mu(e) {
  let t = /* @__PURE__ */ new Set(), r = (n) => {
    if (n && Sr(n)) {
      if (Array.isArray(n)) {
        n.forEach((i) => r(i));
        return;
      } else if (typeof n == "object")
        if (n.type === "image") {
          let i = n.props.href || n.props.xlinkHref;
          i && (t.has(i) || t.add(i));
        } else
          n.type === "img" && (t.has(n.props.src) || t.add(n.props.src));
      Array.isArray(n.props.children) ? n.props.children.map((i) => r(i)) : r(n.props.children);
    }
  };
  return r(e), Promise.all(Array.from(t).map((n) => Or(n)));
}
async function gu(e, t) {
  let { viewBox: r, viewbox: n, width: i, height: o, className: s, style: a, children: u2, ...l2 } = e.props || {};
  r ||= n, l2.xmlns = "http://www.w3.org/2000/svg";
  let f = (a == null ? void 0 : a.color) || t, c2 = _r(r), m2 = c2 ? c2[3] / c2[2] : null;
  i = i || m2 && o ? o / m2 : null, o = o || m2 && i ? i * m2 : null, l2.width = i, l2.height = o, r && (l2.viewBox = r);
  let h2 = {};
  for (let [y, x2] of Object.entries(l2)) {
    let w2 = hu[y] || y;
    h2[w2] = typeof x2 == "string" && x2.toLowerCase() === "currentcolor" ? f : x2;
  }
  return `data:image/svg+xml;utf8,${I("svg", h2, ni(u2, f)).replace(Xd, encodeURIComponent)}`;
}
var dt = "flex";
var bu = { p: { display: dt, marginTop: "1em", marginBottom: "1em" }, div: { display: dt }, blockquote: { display: dt, marginTop: "1em", marginBottom: "1em", marginLeft: 40, marginRight: 40 }, center: { display: dt, textAlign: "center" }, hr: { display: dt, marginTop: "0.5em", marginBottom: "0.5em", marginLeft: "auto", marginRight: "auto", borderWidth: 1, borderStyle: "solid" }, h1: { display: dt, fontSize: "2em", marginTop: "0.67em", marginBottom: "0.67em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, h2: { display: dt, fontSize: "1.5em", marginTop: "0.83em", marginBottom: "0.83em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, h3: { display: dt, fontSize: "1.17em", marginTop: "1em", marginBottom: "1em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, h4: { display: dt, marginTop: "1.33em", marginBottom: "1.33em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, h5: { display: dt, fontSize: "0.83em", marginTop: "1.67em", marginBottom: "1.67em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, h6: { display: dt, fontSize: "0.67em", marginTop: "2.33em", marginBottom: "2.33em", marginLeft: 0, marginRight: 0, fontWeight: "bold" }, u: { textDecoration: "underline" }, strong: { fontWeight: "bold" }, b: { fontWeight: "bold" }, i: { fontStyle: "italic" }, em: { fontStyle: "italic" }, code: { fontFamily: "monospace" }, kbd: { fontFamily: "monospace" }, pre: { display: dt, fontFamily: "monospace", whiteSpace: "pre", marginTop: "1em", marginBottom: "1em" }, mark: { backgroundColor: "yellow", color: "black" }, big: { fontSize: "larger" }, small: { fontSize: "smaller" }, s: { textDecoration: "line-through" } };
var Kd = /* @__PURE__ */ new Set(["color", "font", "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontFeatureSettings", "letterSpacing", "lineHeight", "textAlign", "textIndent", "textTransform", "textShadowOffset", "textShadowColor", "textShadowRadius", "WebkitTextStrokeWidth", "WebkitTextStrokeColor", "textDecorationLine", "textDecorationStyle", "textDecorationColor", "textDecorationSkipInk", "whiteSpace", "transform", "wordBreak", "tabSize", "opacity", "filter", "_viewportWidth", "_viewportHeight", "_inheritedClipPathId", "_inheritedMaskId", "_inheritedBackgroundClipTextPath", "_inheritedBackgroundClipTextHasBackground"]);
function io(e) {
  let t = {};
  for (let r in e)
    (Kd.has(r) || r.startsWith("--")) && (t[r] = e[r]);
  return t;
}
function Jd(e, t) {
  try {
    let r = new wt(e);
    switch (r.unit) {
      case "px":
        return { absolute: r.value };
      case "em":
        return { absolute: r.value * t };
      case "rem":
        return { absolute: r.value * 16 };
      case "%":
        return { relative: r.value };
      default:
        return {};
    }
  } catch {
    return {};
  }
}
function oo(e, t, r) {
  switch (e) {
    case "top":
      return { yRelative: 0 };
    case "left":
      return { xRelative: 0 };
    case "right":
      return { xRelative: 100 };
    case "bottom":
      return { yRelative: 100 };
    case "center":
      return {};
    default: {
      let n = Jd(e, t);
      return n.absolute ? { [r ? "xAbsolute" : "yAbsolute"]: n.absolute } : n.relative ? { [r ? "xRelative" : "yRelative"]: n.relative } : {};
    }
  }
}
function so(e, t) {
  if (typeof e == "number")
    return { xAbsolute: e };
  let r;
  try {
    r = (0, import_postcss_value_parser.default)(e).nodes.filter((n) => n.type === "word").map((n) => n.value);
  } catch {
    return {};
  }
  return r.length === 1 ? oo(r[0], t, true) : r.length === 2 ? ((r[0] === "top" || r[0] === "bottom" || r[1] === "left" || r[1] === "right") && r.reverse(), { ...oo(r[0], t, true), ...oo(r[1], t, false) }) : {};
}
function Yr(e, t) {
  let r = (0, import_css_to_react_native2.getPropertyName)(`mask-${t}`);
  return e[r] || e[`WebkitM${r.substring(1)}`];
}
function yu(e) {
  let t = e.maskImage || e.WebkitMaskImage, r = { position: Yr(e, "position") || "0% 0%", size: Yr(e, "size") || "100% 100%", repeat: Yr(e, "repeat") || "repeat", origin: Yr(e, "origin") || "border-box", clip: Yr(e, "origin") || "border-box" };
  return zt(t).filter((i) => i && i !== "none").reverse().map((i) => ({ image: i, ...r }));
}
var ep = { round: 1, squircle: 2, square: 1 / 0, bevel: 0, scoop: -1, notch: -1 / 0 };
function ao(e) {
  let t = e.trim().toLowerCase(), r = ep[t];
  if (typeof r < "u")
    return r;
  let n = t.match(/^superellipse\(\s*(-?infinity|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?)\s*\)$/);
  if (!n)
    throw new Error('Invalid corner shape value: "' + e + '".');
  if (n[1] === "infinity")
    return 1 / 0;
  if (n[1] === "-infinity")
    return -1 / 0;
  let i = Number(n[1]);
  if (!Number.isFinite(i))
    throw new Error('Invalid corner shape value: "' + e + '".');
  return i;
}
function ii(e, t = 4) {
  let r = e.match(/superellipse\([^)]*\)|[^\s]+/gi) || [];
  if (r.length < 1 || r.length > t)
    throw new Error('Invalid corner shape value: "' + e + '".');
  for (let n of r)
    ao(n);
  return r;
}
var vu = { brightness: 1, contrast: 1, grayscale: 1, invert: 1, opacity: 1, saturate: 1, sepia: 1 };
function xu(e, t, r = "black") {
  if (e === "none")
    return [];
  if (typeof e != "string")
    throw new Error('Invalid `backdropFilter` value: "' + e + '".');
  let n = zt(e, /\s/).filter(Boolean);
  if (!n.length)
    throw new Error('Invalid `backdropFilter` value: "' + e + '".');
  return n.map((i) => {
    let o = i.match(/^([a-z-]+)\((.*)\)$/i);
    if (!o)
      throw new Error("Invalid filter function in `backdropFilter`.");
    let s = o[1].toLowerCase(), a = o[2].trim();
    if (s === "blur") {
      let u2 = a ? oi(a, t, "blur()") : 0;
      if (u2 < 0)
        throw new Error("Invalid `blur()` radius in `backdropFilter`.");
      return { type: "blur", value: u2 };
    }
    if (s === "hue-rotate") {
      let u2 = a === "0" || !a ? 0 : ur(a);
      if (typeof u2 > "u")
        throw new Error("Invalid `hue-rotate()` angle in `backdropFilter`.");
      return { type: "hue-rotate", value: u2 };
    }
    if (s === "drop-shadow")
      return rp(a, t, r);
    if (s in vu) {
      let u2 = s, l2 = a ? np(a, `${u2}()`) : vu[u2], f = ["grayscale", "invert", "opacity", "sepia"].includes(u2) ? Math.min(l2, 1) : l2;
      return { type: u2, value: f };
    }
    throw new Error(`Unsupported \`${s}()\` in \`backdropFilter\`.`);
  });
}
function rp(e, t, r) {
  let n = zt(e, /\s/).filter(Boolean), i = r, o = [];
  for (let l2 of n)
    index_esm_default(l2) ? i = l2 : o.push(l2);
  if (o.length < 2 || o.length > 3)
    throw new Error("Invalid `drop-shadow()` value in `backdropFilter`.");
  let s = oi(o[0], t, "drop-shadow()"), a = oi(o[1], t, "drop-shadow()"), u2 = o[2] ? oi(o[2], t, "drop-shadow()") : 0;
  if (u2 < 0)
    throw new Error("Invalid `drop-shadow()` blur radius in `backdropFilter`.");
  return { type: "drop-shadow", offsetX: s, offsetY: a, blurRadius: u2, color: i };
}
function oi(e, t, r) {
  let n = X(e, t.fontSize, 0, t);
  if (typeof n > "u")
    throw new Error(`Invalid length \`${e}\` in \`${r}\` for \`backdropFilter\`.`);
  return n;
}
function np(e, t) {
  let r = e.match(/^([+-]?(?:\d+\.?\d*|\.\d+))%$/), n = r ? Number(r[1]) / 100 : Number(e);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`Invalid amount \`${e}\` in \`${t}\` for \`backdropFilter\`.`);
  return n;
}
function Su(e) {
  let t = {}, r = {};
  for (let n in e)
    n.startsWith("--") ? t[n] = String(e[n]) : r[n] = e[n];
  return { variables: t, remainingStyle: r };
}
function _u(e, t) {
  return { ...e, ...t };
}
function Kr(e, t, r = /* @__PURE__ */ new Set()) {
  if (typeof e != "string" || !e.includes("var("))
    return e;
  try {
    let n = (0, import_postcss_value_parser2.default)(e), i = false;
    if (n.walk((o) => {
      if (o.type === "function" && o.value === "var") {
        i = true;
        let s = ip(o);
        if (!s)
          return;
        let { varName: a, fallback: u2 } = s;
        if (r.has(a)) {
          console.warn(`Circular reference detected for CSS variable: ${a}`), u2 !== void 0 ? Xr(o, u2) : Xr(o, "initial");
          return;
        }
        let l2 = t[a];
        if (l2 !== void 0) {
          let f = new Set(r);
          f.add(a);
          let c2 = Kr(l2, t, f);
          Xr(o, String(c2));
        } else if (u2 !== void 0) {
          let f = Kr(u2, t, r);
          Xr(o, String(f));
        } else
          Xr(o, "initial");
      }
    }), i)
      return n.toString();
  } catch {
    console.warn(`Failed to parse CSS value for variable resolution: ${e}`);
  }
  return e;
}
function ip(e) {
  if (!e.nodes || e.nodes.length === 0)
    return null;
  let t, r = -1;
  for (let i = 0; i < e.nodes.length; i++) {
    let o = e.nodes[i];
    if (o.type === "word" && !t)
      t = o;
    else if (o.type === "div" && o.value === ",") {
      r = i;
      break;
    }
  }
  if (!t || t.type !== "word")
    return null;
  let n = t.value.trim();
  if (r !== -1 && r < e.nodes.length - 1) {
    let i = e.nodes.slice(r + 1), o = import_postcss_value_parser2.default.stringify(i).trim();
    return { varName: n, fallback: o };
  }
  return { varName: n };
}
function Xr(e, t) {
  e.type = "word", e.value = t, delete e.nodes;
}
var lp = /* @__PURE__ */ new Set(["flex", "flexGrow", "flexShrink", "flexBasis", "fontWeight", "lineHeight", "opacity", "scale", "scaleX", "scaleY"]);
var fp = /* @__PURE__ */ new Set(["lineHeight"]);
function cp(e, t, r, n) {
  return e === "textDecoration" && !r.includes(t.textDecorationColor) && (t.textDecorationColor = n), t;
}
function lr(e, t) {
  let r = Number(t);
  return isNaN(r) ? t : lp.has(e) ? fp.has(e) ? r : String(t) : r + "px";
}
function dp(e, t, r, n) {
  if (e === "zIndex")
    return console.warn("`z-index` is currently not supported."), { [e]: t };
  if (e === "lineHeight")
    return { lineHeight: lr(e, t) };
  if (e === "fontFamily")
    return { fontFamily: t.split(",").map((o) => o.trim().replace(/(^['"])|(['"]$)/g, "").toLocaleLowerCase()) };
  if (e === "borderRadius") {
    if (typeof t != "string" || !t.includes("/"))
      return;
    let [o, s] = t.split("/"), a = (0, import_css_to_react_native.getStylesForProperty)(e, o, true), u2 = (0, import_css_to_react_native.getStylesForProperty)(e, s, true);
    for (let l2 in a)
      u2[l2] = lr(e, a[l2]) + " " + lr(e, u2[l2]);
    return u2;
  }
  if (e === "cornerShape") {
    if (typeof t != "string")
      throw new Error('Invalid `cornerShape` value: "' + t + '".');
    let o = ii(t), s = o[0], a = o[1] || s, u2 = o[2] || s, l2 = o[3] || a;
    return { cornerTopLeftShape: s, cornerTopRightShape: a, cornerBottomRightShape: u2, cornerBottomLeftShape: l2 };
  }
  if (/^corner(TopLeft|TopRight|BottomRight|BottomLeft)Shape$/.test(e)) {
    if (typeof t != "string" || ii(t, 1).length !== 1)
      throw new Error("Invalid `" + e + '` value: "' + t + '".');
    return { [e]: t };
  }
  let i = e.match(/^corner(Top|Right|Bottom|Left)Shape$/);
  if (i) {
    if (typeof t != "string")
      throw new Error("Invalid `" + e + '` value: "' + t + '".');
    let o = ii(t, 2), s = o[0], a = o[1] || s, u2 = { Top: ["cornerTopLeftShape", "cornerTopRightShape"], Right: ["cornerTopRightShape", "cornerBottomRightShape"], Bottom: ["cornerBottomLeftShape", "cornerBottomRightShape"], Left: ["cornerTopLeftShape", "cornerBottomLeftShape"] }[i[1]];
    return { [u2[0]]: s, [u2[1]]: a };
  }
  if (/^border(Top|Right|Bottom|Left)?$/.test(e)) {
    let o = (0, import_css_to_react_native.getStylesForProperty)("border", t, true);
    o.borderWidth === 1 && !String(t).includes("1px") && (o.borderWidth = 3), o.borderColor === "black" && !String(t).includes("black") && (o.borderColor = r);
    let s = { Width: lr(e + "Width", o.borderWidth), Style: Ke(o.borderStyle, { solid: "solid", dashed: "dashed" }, "solid", e + "Style"), Color: o.borderColor }, a = {};
    for (let u2 of e === "border" ? ["Top", "Right", "Bottom", "Left"] : [e.slice(6)])
      for (let l2 in s)
        a["border" + u2 + l2] = s[l2];
    return a;
  }
  if (e === "boxShadow") {
    if (!t)
      throw new Error('Invalid `boxShadow` value: "' + t + '".');
    return { [e]: typeof t == "string" ? (0, import_css_box_shadow.parse)(t) : t };
  }
  if (e === "backdropFilter" || e === "WebkitBackdropFilter")
    return { _backdropFilters: xu(t, n, r) };
  if (e === "transform") {
    if (typeof t != "string")
      throw new Error("Invalid `transform` value.");
    let o = {}, s = t.replace(/(-?[\d.]+%)/g, (u2, l2) => {
      let f = ~~(Math.random() * 1e9);
      return o[f] = l2, f + "px";
    }), a = (0, import_css_to_react_native.getStylesForProperty)("transform", s, true);
    for (let u2 of a.transform)
      for (let l2 in u2)
        o[u2[l2]] && (u2[l2] = o[u2[l2]]);
    return a;
  }
  if (e === "background")
    return t = t.toString().trim(), /^(linear-gradient|radial-gradient|url|repeating-linear-gradient|repeating-radial-gradient)\(/.test(t) ? (0, import_css_to_react_native.getStylesForProperty)("backgroundImage", t, true) : (0, import_css_to_react_native.getStylesForProperty)("background", t, true);
  if (e === "textShadow") {
    t = t.toString().trim();
    let o = {}, s = zt(t);
    for (let a of s) {
      let u2 = (0, import_css_to_react_native.getStylesForProperty)("textShadow", a, true);
      for (let l2 in u2)
        o[l2] ? o[l2].push(u2[l2]) : o[l2] = [u2[l2]];
    }
    return o;
  }
  if (e === "WebkitTextStroke") {
    t = t.toString().trim();
    let o = t.split(" ");
    if (o.length !== 2)
      throw new Error("Invalid `WebkitTextStroke` value.");
    return { WebkitTextStrokeWidth: lr(e, o[0]), WebkitTextStrokeColor: lr(e, o[1]) };
  }
  if (e === "textDecorationSkipInk") {
    let o = t.toString().trim().toLowerCase();
    if (!["auto", "none", "all"].includes(o))
      throw new Error("Invalid `textDecorationSkipInk` value.");
    return { textDecorationSkipInk: o };
  }
}
function Tu(e) {
  return e === "transform" ? " Only absolute lengths such as `10px` are supported." : "";
}
var Eu = /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\.\d]+)\)/;
function Pu(e) {
  if (typeof e == "string" && Eu.test(e.trim()))
    return e.trim().replace(Eu, (t, r, n, i, o) => `rgba(${r}, ${n}, ${i}, ${o})`);
  if (typeof e == "object" && e !== null) {
    for (let t in e)
      e[t] = Pu(e[t]);
    return e;
  }
  return e;
}
function si(e, t) {
  let r = {}, n = {};
  for (let u2 in t)
    u2.startsWith("--") && (n[u2] = String(t[u2]));
  let i = {}, o = e;
  if (e) {
    let { variables: u2, remainingStyle: l2 } = Su(e);
    i = u2, o = l2;
  }
  let s = _u(n, i);
  for (let u2 in s)
    r[u2] = s[u2];
  if (o) {
    let u2 = o.color ? Kr(o.color, s) : void 0, l2 = hp(u2, t.color);
    r.color = l2;
    for (let f in o) {
      if (f.startsWith("_"))
        throw new Error(`Invalid style property: ${JSON.stringify(f)}`);
      if (f === "color")
        continue;
      let c2 = (0, import_css_to_react_native.getPropertyName)(f), m2 = Kr(o[f], s), h2 = gp(m2, l2);
      try {
        let g2 = dp(c2, h2, l2, t) || cp(c2, (0, import_css_to_react_native.getStylesForProperty)(c2, lr(c2, h2), true), h2, l2);
        Object.assign(r, g2);
      } catch (g2) {
        throw new Error(g2.message + (g2.message.includes(h2) ? `
  ` + Tu(c2) : `
  in CSS rule \`${c2}: ${h2}\`.${Tu(c2)}`));
      }
    }
  }
  if (r.backgroundImage) {
    let { backgrounds: u2 } = (0, import_css_background_parser.parseElementStyle)(r);
    r.backgroundImage = u2;
  }
  (r.maskImage || r.WebkitMaskImage) && (r.maskImage = yu(r));
  let a = pp(r.fontSize, t.fontSize);
  typeof r.fontSize < "u" && (r.fontSize = a), r.transformOrigin && (r.transformOrigin = so(r.transformOrigin, a));
  for (let u2 in r) {
    let l2 = r[u2];
    if (u2 === "lineHeight")
      typeof l2 == "string" && l2 !== "normal" && (l2 = r[u2] = X(l2, a, a, t, true) / a);
    else {
      if (typeof l2 == "string") {
        let f = X(l2, a, a, t);
        typeof f < "u" && (r[u2] = f), l2 = r[u2];
      }
      if (typeof l2 == "string" || typeof l2 == "object") {
        let f = Pu(l2);
        f && (r[u2] = f), l2 = r[u2];
      }
    }
    if (u2 === "opacity" && typeof l2 == "number" && (r.opacity = l2 * t.opacity), u2 === "transform") {
      let f = l2;
      for (let c2 of f) {
        let m2 = Object.keys(c2)[0], h2 = c2[m2], g2 = typeof h2 == "string" ? X(h2, a, a, t) ?? h2 : h2;
        c2[m2] = g2;
      }
    }
    if (u2 === "textShadowRadius") {
      let f = l2;
      r.textShadowRadius = f.map((c2) => X(c2, a, 0, t, false));
    }
    if (u2 === "textShadowOffset") {
      let f = l2;
      r.textShadowOffset = f.map(({ height: c2, width: m2 }) => ({ height: X(c2, a, 0, t, false), width: X(m2, a, 0, t, false) }));
    }
  }
  return r;
}
function pp(e, t) {
  if (typeof e == "number")
    return e;
  try {
    let r = new wt(e);
    switch (r.unit) {
      case "em":
        return r.value * t;
      case "rem":
        return r.value * 16;
    }
  } catch {
    return t;
  }
}
function ku(e) {
  if (e.startsWith("hsl")) {
    let t = index_esm_default(e), [r, n, i] = t.values;
    return `hsl(${[r, `${n}%`, `${i}%`].concat(t.alpha === 1 ? [] : [t.alpha]).join(",")})`;
  }
  return e;
}
function hp(e, t) {
  return e && e.toLowerCase() !== "currentcolor" ? ku(e) : ku(t);
}
function mp(e, t) {
  return e.replace(/currentcolor/gi, t);
}
function gp(e, t) {
  return Hn(e) && (e = mp(e, t)), e;
}
async function uo(e, t, r, n, i) {
  let o = await Qt(), s = Object.assign({}, r, si(bu[t], r), si(n, r));
  if (t === "img") {
    let [a, u2, l2] = await Or(i.src);
    if (u2 === void 0 && l2 === void 0) {
      if (i.width === void 0 || i.height === void 0)
        throw new Error("Image size cannot be determined. Please provide the width and height of the image.");
      u2 = parseInt(i.width), l2 = parseInt(i.height);
    }
    let f = l2 / u2, c2 = (s.borderLeftWidth || 0) + (s.borderRightWidth || 0) + (s.paddingLeft || 0) + (s.paddingRight || 0), m2 = (s.borderTopWidth || 0) + (s.borderBottomWidth || 0) + (s.paddingTop || 0) + (s.paddingBottom || 0), h2 = s.width || i.width, g2 = s.height || i.height, y = typeof h2 == "number" && typeof g2 == "number";
    y && (h2 -= c2, g2 -= m2), h2 === void 0 && g2 === void 0 ? (h2 = "100%", e.setAspectRatio(1 / f)) : h2 === void 0 ? typeof g2 == "number" ? h2 = g2 / f : e.setAspectRatio(1 / f) : g2 === void 0 && (typeof h2 == "number" ? g2 = h2 * f : e.setAspectRatio(1 / f)), s.width = y ? h2 + c2 : h2, s.height = y ? g2 + m2 : g2, s.__src = a, s.__naturalWidth = u2, s.__naturalHeight = l2;
  }
  if (t === "svg") {
    let a = i.viewBox || i.viewbox, u2 = _r(a), l2 = u2 ? u2[3] / u2[2] : null, { width: f, height: c2 } = i;
    typeof f > "u" && c2 ? l2 == null ? f = 0 : typeof c2 == "string" && c2.endsWith("%") ? f = parseInt(c2) / l2 + "%" : (c2 = X(c2, r.fontSize, 1, r), f = c2 / l2) : typeof c2 > "u" && f ? l2 == null ? f = 0 : typeof f == "string" && f.endsWith("%") ? c2 = parseInt(f) * l2 + "%" : (f = X(f, r.fontSize, 1, r), c2 = f * l2) : (typeof f < "u" && (f = X(f, r.fontSize, 1, r) || f), typeof c2 < "u" && (c2 = X(c2, r.fontSize, 1, r) || c2), f ||= u2 == null ? void 0 : u2[2], c2 ||= u2 == null ? void 0 : u2[3]), !s.width && f && (s.width = f), !s.height && c2 && (s.height = c2);
  }
  return e.setDisplay(Ke(s.display, { flex: o.DISPLAY_FLEX, block: o.DISPLAY_FLEX, contents: o.DISPLAY_CONTENTS, none: o.DISPLAY_NONE, "-webkit-box": o.DISPLAY_FLEX }, o.DISPLAY_FLEX, "display")), e.setAlignContent(Ke(s.alignContent, { stretch: o.ALIGN_STRETCH, center: o.ALIGN_CENTER, "flex-start": o.ALIGN_FLEX_START, "flex-end": o.ALIGN_FLEX_END, "space-between": o.ALIGN_SPACE_BETWEEN, "space-around": o.ALIGN_SPACE_AROUND, baseline: o.ALIGN_BASELINE, normal: o.ALIGN_AUTO }, o.ALIGN_AUTO, "alignContent")), e.setAlignItems(Ke(s.alignItems, { stretch: o.ALIGN_STRETCH, center: o.ALIGN_CENTER, "flex-start": o.ALIGN_FLEX_START, "flex-end": o.ALIGN_FLEX_END, baseline: o.ALIGN_BASELINE, normal: o.ALIGN_AUTO }, o.ALIGN_STRETCH, "alignItems")), e.setAlignSelf(Ke(s.alignSelf, { stretch: o.ALIGN_STRETCH, center: o.ALIGN_CENTER, "flex-start": o.ALIGN_FLEX_START, "flex-end": o.ALIGN_FLEX_END, baseline: o.ALIGN_BASELINE, normal: o.ALIGN_AUTO }, o.ALIGN_AUTO, "alignSelf")), e.setJustifyContent(Ke(s.justifyContent, { center: o.JUSTIFY_CENTER, "flex-start": o.JUSTIFY_FLEX_START, "flex-end": o.JUSTIFY_FLEX_END, "space-between": o.JUSTIFY_SPACE_BETWEEN, "space-around": o.JUSTIFY_SPACE_AROUND }, o.JUSTIFY_FLEX_START, "justifyContent")), e.setFlexDirection(Ke(s.flexDirection, { row: o.FLEX_DIRECTION_ROW, column: o.FLEX_DIRECTION_COLUMN, "row-reverse": o.FLEX_DIRECTION_ROW_REVERSE, "column-reverse": o.FLEX_DIRECTION_COLUMN_REVERSE }, o.FLEX_DIRECTION_ROW, "flexDirection")), e.setFlexWrap(Ke(s.flexWrap, { wrap: o.WRAP_WRAP, nowrap: o.WRAP_NO_WRAP, "wrap-reverse": o.WRAP_WRAP_REVERSE }, o.WRAP_NO_WRAP, "flexWrap")), typeof s.gap < "u" && e.setGap(o.GUTTER_ALL, s.gap), typeof s.rowGap < "u" && e.setGap(o.GUTTER_ROW, s.rowGap), typeof s.columnGap < "u" && e.setGap(o.GUTTER_COLUMN, s.columnGap), typeof s.flexBasis < "u" && e.setFlexBasis(Kt(s.flexBasis, "flexBasis")), e.setFlexGrow(typeof s.flexGrow > "u" ? 0 : s.flexGrow), e.setFlexShrink(typeof s.flexShrink > "u" ? 0 : s.flexShrink), typeof s.maxHeight < "u" && e.setMaxHeight(qt(s.maxHeight, "maxHeight")), typeof s.maxWidth < "u" && e.setMaxWidth(qt(s.maxWidth, "maxWidth")), typeof s.minHeight < "u" && e.setMinHeight(qt(s.minHeight, "minHeight")), typeof s.minWidth < "u" && e.setMinWidth(qt(s.minWidth, "minWidth")), e.setOverflow(Ke(s.overflow, { visible: o.OVERFLOW_VISIBLE, hidden: o.OVERFLOW_HIDDEN }, o.OVERFLOW_VISIBLE, "overflow")), e.setMargin(o.EDGE_TOP, Kt(s.marginTop || 0)), e.setMargin(o.EDGE_BOTTOM, Kt(s.marginBottom || 0)), e.setMargin(o.EDGE_LEFT, Kt(s.marginLeft || 0)), e.setMargin(o.EDGE_RIGHT, Kt(s.marginRight || 0)), e.setBorder(o.EDGE_TOP, s.borderTopWidth || 0), e.setBorder(o.EDGE_BOTTOM, s.borderBottomWidth || 0), e.setBorder(o.EDGE_LEFT, s.borderLeftWidth || 0), e.setBorder(o.EDGE_RIGHT, s.borderRightWidth || 0), e.setPadding(o.EDGE_TOP, s.paddingTop || 0), e.setPadding(o.EDGE_BOTTOM, s.paddingBottom || 0), e.setPadding(o.EDGE_LEFT, s.paddingLeft || 0), e.setPadding(o.EDGE_RIGHT, s.paddingRight || 0), e.setBoxSizing(Ke(s.boxSizing, { "border-box": o.BOX_SIZING_BORDER_BOX, "content-box": o.BOX_SIZING_CONTENT_BOX }, o.BOX_SIZING_BORDER_BOX, "boxSizing")), e.setPositionType(Ke(s.position, { absolute: o.POSITION_TYPE_ABSOLUTE, relative: o.POSITION_TYPE_RELATIVE, static: o.POSITION_TYPE_STATIC }, o.POSITION_TYPE_RELATIVE, "position")), typeof s.top < "u" && e.setPosition(o.EDGE_TOP, qt(s.top, "top")), typeof s.bottom < "u" && e.setPosition(o.EDGE_BOTTOM, qt(s.bottom, "bottom")), typeof s.left < "u" && e.setPosition(o.EDGE_LEFT, qt(s.left, "left")), typeof s.right < "u" && e.setPosition(o.EDGE_RIGHT, qt(s.right, "right")), typeof s.height < "u" ? e.setHeight(Kt(s.height, "height")) : e.setHeightAuto(), typeof s.width < "u" ? e.setWidth(Kt(s.width, "width")) : e.setWidthAuto(), [s, io(s)];
}
var Ou = [1, 0, 0, 1, 0, 0];
function bp(e, t, r) {
  let n = [...Ou];
  for (let i of e) {
    let o = Object.keys(i)[0], s = i[o];
    if (typeof s == "string")
      if (o === "translateX")
        s = parseFloat(s) / 100 * t, i[o] = s;
      else if (o === "translateY")
        s = parseFloat(s) / 100 * r, i[o] = s;
      else
        throw new Error(`Invalid transform: "${o}: ${s}".`);
    let a = s, u2 = [...Ou];
    switch (o) {
      case "translateX":
        u2[4] = a;
        break;
      case "translateY":
        u2[5] = a;
        break;
      case "scale":
        u2[0] = a, u2[3] = a;
        break;
      case "scaleX":
        u2[0] = a;
        break;
      case "scaleY":
        u2[3] = a;
        break;
      case "rotate": {
        let l2 = a * Math.PI / 180, f = Math.cos(l2), c2 = Math.sin(l2);
        u2[0] = f, u2[1] = c2, u2[2] = -c2, u2[3] = f;
        break;
      }
      case "skewX":
        u2[2] = Math.tan(a * Math.PI / 180);
        break;
      case "skewY":
        u2[1] = Math.tan(a * Math.PI / 180);
        break;
    }
    n = jr(u2, n);
  }
  e.splice(0, e.length), e.push(...n), e.__resolved = true;
}
function Qr({ left: e, top: t, width: r, height: n }, i, o, s) {
  let a;
  i.__resolved || bp(i, r, n);
  let u2 = i;
  if (o)
    a = u2;
  else {
    let l2 = (s == null ? void 0 : s.xAbsolute) ?? ((s == null ? void 0 : s.xRelative) ?? 50) * r / 100, f = (s == null ? void 0 : s.yAbsolute) ?? ((s == null ? void 0 : s.yRelative) ?? 50) * n / 100, c2 = e + l2, m2 = t + f;
    a = jr([1, 0, 0, 1, c2, m2], jr(u2, [1, 0, 0, 1, -c2, -m2])), u2.__parent && (a = jr(u2.__parent, a)), u2.splice(0, 6, ...a);
  }
  return `matrix(${a.map((l2) => l2.toFixed(2)).join(",")})`;
}
function Au({ left: e, top: t, width: r, height: n, isInheritingTransform: i }, o) {
  let s = "", a = 1;
  return o.transform && (s = Qr({ left: e, top: t, width: r, height: n }, o.transform, i, o.transformOrigin)), o.opacity !== void 0 && (a = +o.opacity), { matrix: s, opacity: a };
}
function lo({ id: e, content: t, filter: r, left: n, top: i, width: o, height: s, matrix: a, opacity: u2, image: l2, clipPathId: f, debug: c2, shape: m2, decorationShape: h2 }, g2) {
  let y = "";
  if (c2 && (y = I("rect", { x: n, y: i - s, width: o, height: s, fill: "transparent", stroke: "#575eff", "stroke-width": 1, transform: a || void 0, "clip-path": f ? `url(#${f})` : void 0 })), l2) {
    let P2 = { href: l2, x: n, y: i, width: o, height: s, transform: a || void 0, "clip-path": f ? `url(#${f})` : void 0, style: g2.filter ? `filter:${g2.filter}` : void 0 }, T = I("image", { ...P2, opacity: u2 !== 1 ? u2 : void 0 }) + (h2 || "");
    return [(r ? r + I("g", { filter: `url(#satori_s-${e})` }, T) : T) + y, ""];
  }
  let x2 = { x: n, y: i, width: o, height: s, "font-weight": g2.fontWeight, "font-style": g2.fontStyle, "font-size": g2.fontSize, "font-family": g2.fontFamily, "letter-spacing": g2.letterSpacing || void 0, transform: a || void 0, "clip-path": f ? `url(#${f})` : void 0, style: g2.filter ? `filter:${g2.filter}` : void 0, "stroke-width": g2.WebkitTextStrokeWidth ? `${g2.WebkitTextStrokeWidth}px` : void 0, stroke: g2.WebkitTextStrokeWidth ? g2.WebkitTextStrokeColor : void 0, "stroke-linejoin": g2.WebkitTextStrokeWidth ? "round" : void 0, "paint-order": g2.WebkitTextStrokeWidth ? "stroke" : void 0 }, w2 = I("text", { ...x2, fill: g2.color, opacity: u2 !== 1 ? u2 : void 0 }, (0, import_escape_html2.default)(t)) + (h2 || "");
  return [(r ? r + I("g", { filter: `url(#satori_s-${e})` }, w2) : w2) + y, m2 ? I("text", x2, (0, import_escape_html2.default)(t)) : ""];
}
function yp(e, t, r) {
  return e.replace(/([MA])([0-9.-]+),([0-9.-]+)/g, function(n, i, o, s) {
    return i + (parseFloat(o) + t) + "," + (parseFloat(s) + r);
  });
}
var ai = 1.1;
function Iu({ id: e, width: t, height: r }, n, i = false) {
  if (!n.shadowColor || !n.shadowOffset || typeof n.shadowRadius > "u")
    return "";
  let o = n.shadowColor.length, s = "", a = "", u2 = 0, l2 = t, f = 0, c2 = r;
  for (let m2 = 0; m2 < o; m2++) {
    let h2 = n.shadowRadius[m2] * n.shadowRadius[m2] / 4;
    if (u2 = Math.min(n.shadowOffset[m2].width - h2, u2), l2 = Math.max(n.shadowOffset[m2].width + h2 + t, l2), f = Math.min(n.shadowOffset[m2].height - h2, f), c2 = Math.max(n.shadowOffset[m2].height + h2 + r, c2), i) {
      let g2 = `satori_s-${e}-result-${m2}`;
      s += I("feGaussianBlur", { in: "SourceAlpha", stdDeviation: n.shadowRadius[m2] / 2, result: `${g2}-blur` }) + I("feOffset", { in: `${g2}-blur`, dx: n.shadowOffset[m2].width, dy: n.shadowOffset[m2].height, result: `${g2}-offset` }) + I("feFlood", { "flood-color": n.shadowColor[m2], "flood-opacity": 1, result: `${g2}-color` }) + I("feComposite", { in: `${g2}-color`, in2: `${g2}-offset`, operator: "in", result: o > 1 ? g2 : void 0 });
    } else
      s += I("feDropShadow", { dx: n.shadowOffset[m2].width, dy: n.shadowOffset[m2].height, stdDeviation: n.shadowRadius[m2] / 2, "flood-color": n.shadowColor[m2], "flood-opacity": 1, ...o > 1 ? { in: "SourceGraphic", result: `satori_s-${e}-result-${m2}` } : {} });
    o > 1 && (a = I("feMergeNode", { in: `satori_s-${e}-result-${m2}` }) + a);
  }
  return I("filter", { id: `satori_s-${e}`, x: (u2 / t * 100 * ai).toFixed(2) + "%", y: (f / r * 100 * ai).toFixed(2) + "%", width: ((l2 - u2) / t * 100 * ai).toFixed(2) + "%", height: ((c2 - f) / r * 100 * ai).toFixed(2) + "%" }, s + (a ? I("feMerge", {}, a) : ""));
}
function Cu({ width: e, height: t, shape: r, opacity: n, id: i }, o) {
  if (!o.boxShadow)
    return null;
  let s = "", a = "";
  for (let u2 = o.boxShadow.length - 1; u2 >= 0; u2--) {
    let l2 = "", f = o.boxShadow[u2];
    f.spreadRadius && f.inset && (f.spreadRadius = -f.spreadRadius);
    let c2 = f.blurRadius * f.blurRadius / 4 + (f.spreadRadius || 0), m2 = Math.min(-c2 - (f.inset ? f.offsetX : 0), 0), h2 = Math.max(c2 + e - (f.inset ? f.offsetX : 0), e), g2 = Math.min(-c2 - (f.inset ? f.offsetY : 0), 0), y = Math.max(c2 + t - (f.inset ? f.offsetY : 0), t), x2 = `satori_s-${i}-${u2}`, w2 = `satori_ms-${i}-${u2}`, P2 = f.spreadRadius ? r.replace('stroke-width="0"', `stroke-width="${f.spreadRadius * 2}"`) : r;
    l2 += I("mask", { id: w2, maskUnits: "userSpaceOnUse" }, I("rect", { x: 0, y: 0, width: o._viewportWidth || "100%", height: o._viewportHeight || "100%", fill: f.inset ? "#000" : "#fff" }) + P2.replace('fill="#fff"', f.inset ? 'fill="#fff"' : 'fill="#000"').replace('stroke="#fff"', ""));
    let T = P2.replace(/d="([^"]+)"/, (A, E) => 'd="' + yp(E, f.offsetX, f.offsetY) + '"').replace(/x="([^"]+)"/, (A, E) => 'x="' + (parseFloat(E) + f.offsetX) + '"').replace(/y="([^"]+)"/, (A, E) => 'y="' + (parseFloat(E) + f.offsetY) + '"');
    f.spreadRadius && f.spreadRadius < 0 && (l2 += I("mask", { id: w2 + "-neg", maskUnits: "userSpaceOnUse" }, T.replace('stroke="#fff"', 'stroke="#000"').replace(/stroke-width="[^"]+"/, `stroke-width="${-f.spreadRadius * 2}"`))), f.spreadRadius && f.spreadRadius < 0 && (T = I("g", { mask: `url(#${w2}-neg)` }, T)), l2 += I("defs", {}, I("filter", { id: x2, x: `${m2 / e * 100}%`, y: `${g2 / t * 100}%`, width: `${(h2 - m2) / e * 100}%`, height: `${(y - g2) / t * 100}%` }, I("feGaussianBlur", { stdDeviation: f.blurRadius / 2, result: "b" }) + I("feFlood", { "flood-color": f.color, in: "SourceGraphic", result: "f" }) + I("feComposite", { in: "f", in2: "b", operator: f.inset ? "out" : "in" }))) + I("g", { mask: `url(#${w2})`, filter: `url(#${x2})`, opacity: n }, T), f.inset ? a += l2 : s += l2;
  }
  return [s, a];
}
function vp(e, t, r, n, i, o) {
  let s = i / 2, a = Math.max(s, i * 1.25), u2 = [];
  for (let c2 of r) {
    if (c2.y2 < o + s || c2.y1 > n + s)
      continue;
    let m2 = Math.max(e, c2.x1 - a), h2 = Math.min(t, c2.x2 + a);
    if (m2 >= h2)
      continue;
    if (u2.length === 0) {
      u2.push([m2, h2]);
      continue;
    }
    let g2 = u2[u2.length - 1];
    m2 <= g2[1] ? g2[1] = Math.max(g2[1], h2) : u2.push([m2, h2]);
  }
  if (!u2.length)
    return [[e, t]];
  let l2 = [], f = e;
  for (let [c2, m2] of u2)
    if (c2 > f && l2.push([f, c2]), f = Math.max(f, m2), f >= t)
      break;
  return f < t && l2.push([f, t]), l2;
}
function fo({ width: e, left: t, top: r, ascender: n, clipPathId: i, matrix: o, glyphBoxes: s }, a) {
  let { textDecorationColor: u2, textDecorationStyle: l2, textDecorationLine: f, textDecorationSkipInk: c2, fontSize: m2, color: h2 } = a;
  if (!f || f === "none")
    return "";
  let g2 = Math.max(1, m2 * 0.1), y = f === "line-through" ? r + n * 0.7 : f === "underline" ? r + n * 1.1 : r, x2 = l2 === "dashed" ? `${g2 * 1.2} ${g2 * 2}` : l2 === "dotted" ? `0 ${g2 * 2}` : void 0, w2 = f === "underline" && (c2 || "auto") !== "none" && (s == null ? void 0 : s.length), P2 = r + n, T = w2 ? vp(t, t + e, s, y, g2, P2) : [[t, t + e]], A = l2 === "double" ? T.map(([_, R2]) => I("line", { x1: _, y1: y + g2 + 1, x2: R2, y2: y + g2 + 1, stroke: u2 || h2, "stroke-width": g2, "stroke-dasharray": x2, "stroke-linecap": l2 === "dotted" ? "round" : "square", transform: o })).join("") : "", E = T.map(([_, R2]) => I("line", { x1: _, y1: y, x2: R2, y2: y, stroke: u2 || h2, "stroke-width": g2, "stroke-dasharray": x2, "stroke-linecap": l2 === "dotted" ? "round" : "square", transform: o })).join("") + A;
  return i ? I("g", { "clip-path": `url(#${i})` }, E) : E;
}
function co(e) {
  return e = e.replace("U+", "0x"), String.fromCodePoint(Number(e));
}
var fr = co("U+0020");
var po = co("U+0009");
var Rr = co("U+2026");
function Lu(e, t, r) {
  let { fontSize: n, letterSpacing: i, fontFeatureSettings: o } = r, s = /* @__PURE__ */ new Map();
  function a(c2) {
    let m2 = s.get(c2);
    return m2 === void 0 && (m2 = e.measure(c2, { fontSize: n, letterSpacing: i, fontFeatureSettings: o }), s.set(c2, m2)), m2;
  }
  function u2(c2) {
    return a(c2);
  }
  function l2(c2) {
    let m2 = 0, h2 = "", g2 = () => {
      h2 && (m2 += a(h2), h2 = "");
    };
    for (let y of c2)
      t(y) ? (g2(), m2 += n) : h2 += y;
    return g2(), m2;
  }
  function f(c2) {
    return l2(De(c2, "grapheme"));
  }
  return { measureGrapheme: u2, measureGraphemeArray: l2, measureText: f };
}
function Mu(e, t, r) {
  let { textTransform: n, whiteSpace: i, wordBreak: o } = t;
  e = xp(e, n, r);
  let { content: s, shouldCollapseTabsAndSpaces: a, allowSoftWrap: u2 } = _p(e, i), { words: l2, requiredBreaks: f, allowBreakWord: c2 } = Sp(s, o), [m2, h2] = wp(t, u2);
  return { words: l2, requiredBreaks: f, allowSoftWrap: u2, allowBreakWord: c2, processedContent: s, shouldCollapseTabsAndSpaces: a, lineLimit: m2, blockEllipsis: h2 };
}
function xp(e, t, r) {
  return t === "uppercase" ? e = e.toLocaleUpperCase(r) : t === "lowercase" ? e = e.toLocaleLowerCase(r) : t === "capitalize" && (e = De(e, "word", r).map((n) => De(n, "grapheme", r).map((i, o) => o === 0 ? i.toLocaleUpperCase(r) : i).join("")).join("")), e;
}
function wp(e, t) {
  let { textOverflow: r, lineClamp: n, WebkitLineClamp: i, WebkitBoxOrient: o, overflow: s, display: a } = e;
  if (a === "block" && n) {
    let [u2, l2 = Rr] = Tp(n);
    if (u2)
      return [u2, l2];
  }
  return r === "ellipsis" && a === "-webkit-box" && o === "vertical" && qa(i) && i > 0 ? [i, Rr] : r === "ellipsis" && s === "hidden" && !t ? [1, Rr] : [1 / 0];
}
function Sp(e, t) {
  let r = ["break-all", "break-word"].includes(t), { words: n, requiredBreaks: i } = Ga(e, t);
  return { words: n, requiredBreaks: i, allowBreakWord: r };
}
function _p(e, t) {
  let r = ["pre", "pre-wrap", "pre-line"].includes(t), n = ["normal", "nowrap", "pre-line"].includes(t), i = !["pre", "nowrap"].includes(t);
  return r || (e = e.replace(/\n/g, fr)), n && (e = e.replace(/([ ]|\t)+/g, fr).replace(/^[ ]|[ ]$/g, "")), { content: e, shouldCollapseTabsAndSpaces: n, allowSoftWrap: i };
}
function Tp(e) {
  if (typeof e == "number")
    return [e];
  let t = /^(\d+)\s*"(.*)"$/, r = /^(\d+)\s*'(.*)'$/, n = t.exec(e), i = r.exec(e);
  if (n) {
    let o = +n[1], s = n[2];
    return [o, s];
  } else if (i) {
    let o = +i[1], s = i[2];
    return [o, s];
  }
  return [];
}
var Ep = /* @__PURE__ */ new Set([po]);
function kp(e) {
  return Ep.has(e);
}
function ho(e) {
  if (e === "transparent")
    return true;
  let t = index_esm_default(e);
  return t ? t.alpha === 0 : false;
}
function Fu(e) {
  if (!e)
    return false;
  let t = index_esm_default(e);
  if (!t)
    return false;
  let [r, n, i, o] = t.values;
  return r === 255 && n === 255 && i === 255 && (o === void 0 || o === 1);
}
async function* mo(e, t) {
  let r = await Qt(), { parentStyle: n, inheritedStyle: i, parent: o, font: s, id: a, isInheritingTransform: u2, debug: l2, embedFont: f, graphemeImages: c2, locale: m2, canLoadAdditionalAssets: h2 } = t, { textAlign: g2, textIndent: y = 0, lineHeight: x2, textWrap: w2, fontSize: P2, filter: T, tabSize: A = 8, letterSpacing: E, fontFeatureSettings: _, _inheritedBackgroundClipTextPath: R2, _inheritedBackgroundClipTextHasBackground: C, flexShrink: z } = n, { words: G, requiredBreaks: ie, allowSoftWrap: te, allowBreakWord: he, processedContent: de, shouldCollapseTabsAndSpaces: Me, lineLimit: Re, blockEllipsis: Oe } = Mu(e, n, m2), $e = Pp(r, g2);
  o.insertChild($e, o.getChildCount()), za(z) && o.setFlexShrink(1);
  let re = s.getEngine(P2, x2, n, m2), me = h2 ? De(de, "grapheme").filter((H) => !kp(H) && !re.has(H)) : [];
  yield me.map((H) => ({ word: H, locale: m2 })), me.length && (re = s.getEngine(P2, x2, n, m2));
  function rt(H) {
    return !!(c2 && Object.prototype.hasOwnProperty.call(c2, H) && c2[H]);
  }
  let { measureGrapheme: qe, measureGraphemeArray: Ae, measureText: ne } = Lu(re, rt, { fontSize: P2, letterSpacing: E, fontFeatureSettings: _ }), Q = Hn(A) ? X(A, P2, 1, n) : qe(fr) * A, we = (H, K2) => {
    if (H.length === 0)
      return { originWidth: 0, endingSpacesWidth: 0, text: H };
    let { index: ee, tabCount: J } = Op(H), ke = 0;
    if (J > 0) {
      let ye = H.slice(0, ee), ce = H.slice(ee + J), oe = ne(ye), ut = oe + K2;
      ke = (Q === 0 ? oe : (Math.floor(ut / Q) + J) * Q) + ne(ce);
    } else
      ke = ne(H);
    let fe = H.trimEnd() === H ? ke : ne(H.trimEnd());
    return { originWidth: ke, endingSpacesWidth: ke - fe, text: H };
  }, Z = [], j = [], Ee = [], Ie = [], Ce = [];
  function Fe(H) {
    let K2 = 0, ee = 0, J = -1, ke = 0, fe = 0, ye = 0, ce = 0;
    Z = [], Ee = [0], Ie = [], Ce = [];
    let oe = 0, ut = 0;
    for (; oe < G.length && K2 < Re; ) {
      let Y = G[oe], Rt = ie[oe], Ve = 0, { originWidth: He, endingSpacesWidth: st, text: Wt } = we(Y, fe);
      Y = Wt, Ve = He;
      let Ye = st;
      Rt && ye === 0 && (ye = re.height(Y));
      let $t = g2 === "justify", Se = oe && fe + Ve > H + Ye && te;
      if (he && Ve > H && (!fe || Se || Rt)) {
        let Je = De(Y, "grapheme");
        G.splice(oe, 1, ...Je), fe > 0 && (Z.push(fe - ut), j.push(ce), K2++, ke += ye, fe = 0, ye = 0, ce = 0, Ee.push(1), J = -1), ut = Ye;
        continue;
      }
      if (Rt || Se)
        Me && Y === fr && (Ve = 0), Z.push(fe - ut), j.push(ce), K2++, ke += ye, fe = Ve, ye = Ve ? Math.round(re.height(Y)) : 0, ce = Ve ? Math.round(re.baseline(Y)) : 0, Ee.push(1), J = -1, Rt || (ee = Math.max(ee, H));
      else {
        fe += Ve;
        let Je = Math.round(re.height(Y));
        Je > ye && (ye = Je, ce = Math.round(re.baseline(Y))), $t && Ee[Ee.length - 1]++;
      }
      $t && J++, ee = Math.max(ee, fe);
      let lt = fe - Ve;
      if (Ve === 0)
        Ce.push({ y: ke, x: lt, width: 0, line: K2, lineIndex: J, isImage: false });
      else {
        let Je = De(Y, "word");
        for (let ft = 0; ft < Je.length; ft++) {
          let vt = Je[ft], Xe = 0, ct = false;
          rt(vt) ? (Xe = P2, ct = true) : !f && vt.length > 1 ? Xe = ne(vt) : Xe = qe(vt), Ie.push(vt), Ce.push({ y: ke, x: lt, width: Xe, line: K2, lineIndex: J, isImage: ct }), lt += Xe, ft < Je.length - 1 && E > 0 && (lt += E);
        }
      }
      oe++, ut = Ye;
    }
    return fe && (K2 < Re && (ke += ye), K2++, Z.push(fe), j.push(ce)), { width: ee, height: ke };
  }
  let le = { width: 0, height: 0 };
  $e.setMeasureFunc((H) => {
    let { width: K2, height: ee } = Fe(H);
    if (w2 === "balance") {
      let ke = K2 / 2, fe = K2, ye = K2;
      for (; ke + 1 < fe; ) {
        ye = (ke + fe) / 2;
        let { height: oe } = Fe(ye);
        oe > ee ? ke = ye : fe = ye;
      }
      Fe(fe);
      let ce = Math.ceil(fe);
      return le = { width: ce, height: ee }, { width: ce, height: ee };
    }
    if (w2 === "pretty" && Z[Z.length - 1] < K2 / 3) {
      let ye = K2 * 0.9, ce = Fe(ye);
      if (ce.height <= ee * 1.3)
        return le = { width: K2, height: ce.height }, { width: K2, height: ce.height };
    }
    let J = Math.ceil(K2);
    return le = { width: J, height: ee }, { width: J, height: ee };
  });
  let [Qe, nt] = yield, Ne = "", be = "", Ge = i._inheritedClipPathId, Tt = i._inheritedMaskId, { left: Dr, top: Wr, width: Ft, height: $r } = $e.getComputedLayout(), Br = typeof y == "string" ? X(y, P2, Ft, n, true) || 0 : y, or = o.getComputedWidth() - o.getComputedPadding(r.EDGE_LEFT) - o.getComputedPadding(r.EDGE_RIGHT) - o.getComputedBorder(r.EDGE_LEFT) - o.getComputedBorder(r.EDGE_RIGHT), Et = Qe + Dr, kt = nt + Wr, { matrix: it, opacity: Nt } = Au({ left: Dr, top: Wr, width: Ft, height: $r, isInheritingTransform: u2 }, n), je = "";
  if (n.textShadowOffset) {
    let { textShadowColor: H, textShadowOffset: K2, textShadowRadius: ee } = n;
    je = Iu({ width: le.width, height: le.height, id: a }, { shadowColor: H, shadowOffset: K2, shadowRadius: ee }, ho(n.color) || C && Fu(n.color)), je = I("defs", {}, je);
  }
  let ot = "", Dt = "", yr = "", Pt = -1, ze = {}, Ot = {}, Be = null, vr = 0;
  for (let H = 0; H < Ie.length; H++) {
    let K2 = Ce[H], ee = Ce[H + 1];
    if (!K2)
      continue;
    let J = Ie[H], ke = null, fe = false, ye = c2 && Object.prototype.hasOwnProperty.call(c2, J) ? c2[J] : null, ce = K2.y, oe = K2.x, ut = K2.width, Y = K2.line, Rt = n.textDecorationLine === "underline" && (n.textDecorationSkipInk || "auto") !== "none";
    if (Y === Pt)
      continue;
    let Ve = false;
    if (Y === 0 && Br !== 0 && (oe += Br), Z.length > 1) {
      let Se = Ft - Z[Y];
      if (g2 === "right" || g2 === "end")
        oe += Se;
      else if (g2 === "center")
        oe += Se / 2;
      else if (g2 === "justify" && Y < Z.length - 1) {
        let Pe = Ee[Y], lt = Pe > 1 ? Se / (Pe - 1) : 0;
        oe += lt * K2.lineIndex, Ve = true;
      }
      f && (oe = Math.round(oe));
    }
    let He = j[Y], st = re.baseline(J), Wt = re.height(J), Ye = He - st, $t = (Se) => !Rt || n.textDecorationLine !== "underline" ? void 0 : { underlineY: kt + Se + Ye + st + st * 0.1, strokeWidth: Math.max(1, P2 * 0.1) };
    if (ze[Y] || (ze[Y] = { left: oe, top: kt + ce + Ye, ascender: st, width: Ve ? Ft : Z[Y] }), Re !== 1 / 0) {
      let vt = function(Xe, ct) {
        let Ur = De(ct, "grapheme", m2), xr = "", Bn = 0;
        for (let qr of Ur) {
          let sr = Xe + Ae([xr + qr]);
          if (xr && sr + Pe > or)
            break;
          xr += qr, Bn = sr;
        }
        return { subset: xr, resolvedWidth: Bn };
      }, Se = Oe, Pe = qe(Oe);
      Pe > or && (Se = Rr, Pe = qe(Se));
      let lt = qe(fr), Je = Y < Z.length - 1;
      if (Y + 1 === Re && (Je || Z[Y] > or)) {
        if (oe + ut + Pe + lt > or) {
          let { subset: Xe, resolvedWidth: ct } = vt(oe, J);
          J = Xe + Se, Pt = Y, ze[Y].width = Math.max(0, ct - ze[Y].left), fe = true;
        } else if (ee && ee.line !== Y)
          if (g2 === "center") {
            let { subset: Xe, resolvedWidth: ct } = vt(oe, J);
            J = Xe + Se, Pt = Y, ze[Y].width = Math.max(0, ct - ze[Y].left), fe = true;
          } else {
            let Xe = Ie[H + 1], { subset: ct, resolvedWidth: Ur } = vt(ut + oe, Xe);
            J = J + ct + Se, Pt = Y, ze[Y].width = Math.max(0, Ur - ze[Y].left), fe = true;
          }
      }
    }
    if (ye)
      ce += 0;
    else if (f) {
      if (!J.includes(po) && !Wa.includes(J) && Ie[H + 1] && ee && !ee.isImage && ce === ee.y && !fe) {
        Be === null && (vr = oe), Be = Be === null ? J : Be + J;
        continue;
      }
      let Se = Be === null ? J : Be + J, Pe = Be === null ? oe : vr, lt = K2.width + oe - Pe, Je = $t(ce), ft = re.getSVG(Se.replace(/(\t)+/g, ""), { fontSize: P2, left: Et + Pe, top: kt + ce + st + Ye, letterSpacing: E, fontFeatureSettings: _ }, Je);
      ke = ft.path, Rt && ft.boxes && ft.boxes.length && (Ot[Y] || (Ot[Y] = [])).push(...ft.boxes), Be = null, l2 && (yr += I("rect", { x: Et + Pe, y: kt + ce + Ye, width: lt, height: Wt, fill: "transparent", stroke: "#575eff", "stroke-width": 1, transform: it || void 0, "clip-path": Ge ? `url(#${Ge})` : void 0 }) + I("line", { x1: Et + oe, x2: Et + oe + K2.width, y1: kt + ce + Ye + st, y2: kt + ce + Ye + st, stroke: "#14c000", "stroke-width": 1, transform: it || void 0, "clip-path": Ge ? `url(#${Ge})` : void 0 }));
    } else if (ce += st + Ye, Rt && !ye) {
      let Se = $t(ce), Pe = re.getSVG(J.replace(/(\t)+/g, ""), { fontSize: P2, left: Et + oe, top: kt + ce, letterSpacing: E, fontFeatureSettings: _ }, Se);
      Pe.boxes && Pe.boxes.length && (Ot[Y] || (Ot[Y] = [])).push(...Pe.boxes);
    }
    if (ke !== null)
      Dt += ke + " ";
    else {
      let [Se, Pe] = lo({ content: J, filter: je, id: a, left: Et + oe, top: kt + ce, width: ut, height: Wt, matrix: it, opacity: Nt, image: ye, clipPathId: Ge, debug: l2, shape: !!R2 }, n);
      Ne += Se, be += Pe;
    }
    if (fe)
      break;
  }
  if (n.textDecorationLine && (ot = Object.entries(ze).map(([H, K2]) => {
    if (!K2)
      return "";
    let ee = Ot[H] || [];
    return fo({ left: Et + K2.left, top: K2.top, width: K2.width, ascender: K2.ascender, clipPathId: Ge, matrix: it, glyphBoxes: ee }, n);
  }).join("")), Dt) {
    let H = (!ho(n.color) || je) && Nt !== 0 ? I("path", { fill: je && (ho(n.color) || C && Fu(n.color)) ? "black" : n.color, d: Dt, transform: it || void 0, [i.WebkitTextStrokeWidth || T || je ? "opacity" : "fill-opacity"]: Nt !== 1 ? Nt : void 0, style: T ? `filter:${T}` : void 0, "stroke-width": i.WebkitTextStrokeWidth ? `${i.WebkitTextStrokeWidth}px` : void 0, stroke: i.WebkitTextStrokeWidth ? i.WebkitTextStrokeColor : void 0, "stroke-linejoin": i.WebkitTextStrokeWidth ? "round" : void 0, "paint-order": i.WebkitTextStrokeWidth ? "stroke" : void 0 }) : "", K2 = H ? I("g", { mask: Tt ? `url(#${Tt})` : void 0, "clip-path": Ge ? `url(#${Ge})` : void 0 }, H) : "";
    R2 && (be = I("path", { d: Dt, transform: it || void 0 })), Ne += (je ? je + I("g", { filter: `url(#satori_s-${a})` }, K2 + ot) : K2 + ot) + yr;
  } else
    ot && (Ne += je ? I("g", { filter: `url(#satori_s-${a})` }, ot) : ot);
  return be && (n._inheritedBackgroundClipTextPath.value += be), Ne;
}
function Pp(e, t) {
  let r = e.Node.create();
  return r.setAlignItems(e.ALIGN_BASELINE), r.setJustifyContent(Ke(t, { left: e.JUSTIFY_FLEX_START, right: e.JUSTIFY_FLEX_END, center: e.JUSTIFY_CENTER, justify: e.JUSTIFY_SPACE_BETWEEN, start: e.JUSTIFY_FLEX_START, end: e.JUSTIFY_FLEX_END }, e.JUSTIFY_FLEX_START, "textAlign")), r;
}
function Op(e) {
  let t = /(\t)+/.exec(e);
  return t ? { index: t.index, tabCount: t[0].length } : { index: null, tabCount: 0 };
}
function ui(e, t, r, n, i) {
  let o = [], s = t.at(-1), a = s && s.offset && s.offset.unit === "%" && n ? +s.offset.value : 100;
  for (let c2 of t) {
    let { color: m2 } = c2;
    if (!o.length && (o.push({ offset: 0, color: m2 }), !c2.offset || c2.offset.value === "0"))
      continue;
    let h2 = typeof c2.offset > "u" ? void 0 : c2.offset.unit === "%" ? +c2.offset.value / a : Number(X(`${c2.offset.value}${c2.offset.unit}`, r.fontSize, e, r, true)) / e;
    o.push({ offset: h2, color: m2 });
  }
  o.length || o.push({ offset: 0, color: "transparent" });
  let u2 = o[o.length - 1];
  u2.offset !== 1 && (typeof u2.offset > "u" ? u2.offset = 1 : n ? o[o.length - 1] = { offset: 1, color: u2.color } : o.push({ offset: 1, color: u2.color }));
  let l2 = 0, f = 1;
  for (let c2 = 0; c2 < o.length; c2++)
    if (typeof o[c2].offset > "u") {
      for (f < c2 && (f = c2); typeof o[f].offset > "u"; )
        f++;
      o[c2].offset = (o[f].offset - o[l2].offset) / (f - l2) * (c2 - l2) + o[l2].offset;
    } else
      l2 = c2;
  return i === "mask" ? o.map((c2) => {
    let m2 = index_esm_default(c2.color);
    return m2 ? m2.alpha === 0 ? { ...c2, color: "rgba(0, 0, 0, 1)" } : { ...c2, color: `rgba(255, 255, 255, ${m2.alpha})` } : c2;
  }) : o;
}
function Du({ id: e, width: t, height: r, repeatX: n, repeatY: i }, o, s, a, u2, l2) {
  let f = P(o), [c2, m2] = s, h2 = o.startsWith("repeating"), g2, y, x2;
  if (f.orientation.type === "directional")
    g2 = Cp(f.orientation.value), y = Math.sqrt(Math.pow((g2.x2 - g2.x1) * c2, 2) + Math.pow((g2.y2 - g2.y1) * m2, 2));
  else if (f.orientation.type === "angular") {
    let { length: E, ..._ } = Lp(ur(`${f.orientation.value.value}${f.orientation.value.unit}`) / 180 * Math.PI, c2, m2);
    y = E, g2 = _;
  }
  x2 = h2 ? Mp(f.stops, y, g2, u2) : g2;
  let w2 = ui(h2 ? Ip(f.stops, y) : y, f.stops, u2, h2, l2), P2 = `satori_bi${e}`, T = `satori_pattern_${e}`, A = I("pattern", { id: T, x: a[0] / t, y: a[1] / r, width: n ? c2 / t : "1", height: i ? m2 / r : "1", patternUnits: "objectBoundingBox" }, I("linearGradient", { id: P2, ...x2, spreadMethod: h2 ? "repeat" : "pad" }, w2.map((E) => I("stop", { offset: (E.offset ?? 0) * 100 + "%", "stop-color": E.color })).join("")) + I("rect", { x: 0, y: 0, width: c2, height: m2, fill: `url(#${P2})` }));
  return [T, A];
}
function Ip(e, t) {
  let r = e[e.length - 1], { offset: n } = r;
  return n ? n.unit === "%" ? Number(n.value) / 100 * t : Number(n.value) : t;
}
function Cp(e) {
  let t = 0, r = 0, n = 0, i = 0;
  return e.includes("top") ? r = 1 : e.includes("bottom") && (i = 1), e.includes("left") ? t = 1 : e.includes("right") && (n = 1), !t && !n && !r && !i && (r = 1), { x1: t, y1: r, x2: n, y2: i };
}
function Lp(e, t, r) {
  let n = Math.pow(r / t, 2);
  e = (e % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  let i, o, s, a, u2, l2, f, c2, m2 = (h2) => {
    if (h2 === 0) {
      i = 0, o = r, s = 0, a = 0, u2 = r;
      return;
    } else if (h2 === Math.PI / 2) {
      i = 0, o = 0, s = t, a = 0, u2 = t;
      return;
    }
    if (h2 > 0 && h2 < Math.PI / 2) {
      i = (n * t / 2 / Math.tan(h2) - r / 2) / (Math.tan(h2) + n / Math.tan(h2)), o = Math.tan(h2) * i + r, s = Math.abs(t / 2 - i) + t / 2, a = r / 2 - Math.abs(o - r / 2), u2 = Math.sqrt(Math.pow(s - i, 2) + Math.pow(a - o, 2)), f = (t / 2 / Math.tan(h2) - r / 2) / (Math.tan(h2) + 1 / Math.tan(h2)), c2 = Math.tan(h2) * f + r, u2 = 2 * Math.sqrt(Math.pow(t / 2 - f, 2) + Math.pow(r / 2 - c2, 2));
      return;
    } else if (h2 > Math.PI / 2 && h2 < Math.PI) {
      i = (r / 2 + n * t / 2 / Math.tan(h2)) / (Math.tan(h2) + n / Math.tan(h2)), o = Math.tan(h2) * i, s = Math.abs(t / 2 - i) + t / 2, a = r / 2 + Math.abs(o - r / 2), f = (t / 2 / Math.tan(h2) + r / 2) / (Math.tan(h2) + 1 / Math.tan(h2)), c2 = Math.tan(h2) * f, u2 = 2 * Math.sqrt(Math.pow(t / 2 - f, 2) + Math.pow(r / 2 - c2, 2));
      return;
    } else
      h2 >= Math.PI && (m2(h2 - Math.PI), l2 = i, i = s, s = l2, l2 = o, o = a, a = l2);
  };
  return m2(e), { x1: i / t, y1: o / r, x2: s / t, y2: a / r, length: u2 };
}
function Mp(e, t, r, n) {
  let { x1: i, x2: o, y1: s, y2: a } = r, u2 = e[0].offset ? e[0].offset.unit === "%" ? Number(e[0].offset.value) / 100 : X(`${e[0].offset.value}${e[0].offset.unit}`, n.fontSize, t, n, true) / t : 0, l2 = e.at(-1).offset ? e.at(-1).offset.unit === "%" ? Number(e.at(-1).offset.value) / 100 : X(`${e.at(-1).offset.value}${e.at(-1).offset.unit}`, n.fontSize, t, n, true) / t : 1, f = (o - i) * u2 + i, c2 = (a - s) * u2 + s, m2 = (o - i) * l2 + i, h2 = (a - s) * l2 + s;
  return { x1: f, y1: c2, x2: m2, y2: h2 };
}
function $u({ id: e, width: t, height: r, repeatX: n, repeatY: i }, o, s, a, u2, l2) {
  var he;
  let { shape: f, stops: c2, position: m2, size: h2, repeating: g2 } = K(o), [y, x2] = s, w2 = y / 2, P2 = x2 / 2, T = Dp(m2.x, m2.y, y, x2, u2.fontSize, u2);
  w2 = T.x, P2 = T.y;
  let A = Np(t, c2, g2, u2), E = ui(A, c2, u2, g2, l2), _ = `satori_radial_${e}`, R2 = `satori_pattern_${e}`, C = `satori_mask_${e}`, z = $p(f, h2, u2.fontSize, { x: w2, y: P2 }, [y, x2], u2, g2), G = Wp(f, u2.fontSize, c2, [y, x2], u2, g2, z), ie = I("pattern", { id: R2, x: a[0] / t, y: a[1] / r, width: n ? y / t : "1", height: i ? x2 / r : "1", patternUnits: "objectBoundingBox" }, I("radialGradient", { id: _, ...G }, E.map((de) => I("stop", { offset: de.offset || 0, "stop-color": de.color })).join("")) + I("mask", { id: C }, I("rect", { x: 0, y: 0, width: y, height: x2, fill: "#fff" })) + I("rect", { x: 0, y: 0, width: y, height: x2, fill: ((he = E.at(-1)) == null ? void 0 : he.color) || "transparent" }) + I(f, { cx: w2, cy: P2, width: y, height: x2, ...z, fill: `url(#${_})`, mask: `url(#${C})` }));
  return [R2, ie];
}
function Np(e, t, r, n) {
  if (!r)
    return e;
  let i = t.at(-1);
  return !i || !i.offset || i.offset.unit === "%" ? e : X(`${i.offset.value}${i.offset.unit}`, +n.fontSize, e, n, true);
}
function Dp(e, t, r, n, i, o) {
  let s = { x: r / 2, y: n / 2 };
  return e.type === "keyword" ? Object.assign(s, Wu(e.value, r, n, "x")) : s.x = X(`${e.value.value}${e.value.unit}`, i, r, o, true) ?? r / 2, t.type === "keyword" ? Object.assign(s, Wu(t.value, r, n, "y")) : s.y = X(`${t.value.value}${t.value.unit}`, i, n, o, true) ?? n / 2, s;
}
function Wu(e, t, r, n) {
  switch (e) {
    case "center":
      return { [n]: n === "x" ? t / 2 : r / 2 };
    case "left":
      return { x: 0 };
    case "top":
      return { y: 0 };
    case "right":
      return { x: t };
    case "bottom":
      return { y: r };
  }
}
function Wp(e, t, r, [n, i], o, s, a) {
  let { r: u2, rx: l2, ratio: f = 1 } = a;
  if (!s)
    return { spreadMethod: "pad" };
  let c2 = r.at(-1), m2 = e === "circle" ? u2 * 2 : l2 * 2;
  return { spreadMethod: "repeat", cx: "50%", cy: "50%", r: c2.offset.unit === "%" ? `${Number(c2.offset.value) * Math.min(i / n, 1) / f}%` : Number(X(`${c2.offset.value}${c2.offset.unit}`, t, n, o, true) / m2) };
}
function $p(e, t, r, n, i, o, s) {
  let [a, u2] = i, { x: l2, y: f } = n, c2 = {}, m2 = 0, h2 = 0;
  if (Bp(t)) {
    if (t.some((g2) => g2.value.value.startsWith("-")))
      throw new Error("disallow setting negative values to the size of the shape. Check https://w3c.github.io/csswg-drafts/css-images/#valdef-rg-size-length-0");
    return e === "circle" ? Object.assign(c2, { r: Number(X(`${t[0].value.value}${t[0].value.unit}`, r, a, o, true)) }) : Object.assign(c2, { rx: Number(X(`${t[0].value.value}${t[0].value.unit}`, r, a, o, true)), ry: Number(X(`${t[1].value.value}${t[1].value.unit}`, r, u2, o, true)) }), li(c2, a, u2, l2, f, s, e), c2;
  }
  switch (t[0].value) {
    case "farthest-corner":
      m2 = Math.max(Math.abs(a - l2), Math.abs(l2)), h2 = Math.max(Math.abs(u2 - f), Math.abs(f));
      break;
    case "closest-corner":
      m2 = Math.min(Math.abs(a - l2), Math.abs(l2)), h2 = Math.min(Math.abs(u2 - f), Math.abs(f));
      break;
    case "farthest-side":
      return e === "circle" ? c2.r = Math.max(Math.abs(a - l2), Math.abs(l2), Math.abs(u2 - f), Math.abs(f)) : (c2.rx = Math.max(Math.abs(a - l2), Math.abs(l2)), c2.ry = Math.max(Math.abs(u2 - f), Math.abs(f))), li(c2, a, u2, l2, f, s, e), c2;
    case "closest-side":
      return e === "circle" ? c2.r = Math.min(Math.abs(a - l2), Math.abs(l2), Math.abs(u2 - f), Math.abs(f)) : (c2.rx = Math.min(Math.abs(a - l2), Math.abs(l2)), c2.ry = Math.min(Math.abs(u2 - f), Math.abs(f))), li(c2, a, u2, l2, f, s, e), c2;
  }
  return e === "circle" ? c2.r = Math.sqrt(m2 * m2 + h2 * h2) : Object.assign(c2, Bu(m2, h2)), li(c2, a, u2, l2, f, s, e), c2;
}
function li(e, t, r, n, i, o, s) {
  if (o)
    if (s === "ellipse") {
      let a = Math.max(Math.abs(t - n), Math.abs(n)), u2 = Math.max(Math.abs(r - i), Math.abs(i)), { rx: l2, ry: f } = Bu(a, u2);
      e.ratio = Math.max(l2 / e.rx, f / e.ry), e.ratio > 1 && (e.rx *= e.ratio, e.ry *= e.ratio);
    } else {
      let a = Math.max(Math.abs(t - n), Math.abs(n)), u2 = Math.max(Math.abs(r - i), Math.abs(i)), l2 = Math.sqrt(a * a + u2 * u2);
      e.ratio = l2 / e.r, e.ratio > 1 && (e.r = l2);
    }
}
function Bu(e, t) {
  let r = t !== 0 ? e / t : 1;
  if (e === 0)
    return { rx: 0, ry: 0 };
  {
    let n = Math.sqrt(e * e + t * t * r * r) / r;
    return { ry: n, rx: n * r };
  }
}
function Bp(e) {
  return !e.some((t) => t.type === "keyword");
}
function bo(e, t) {
  return typeof e == "string" && e.endsWith("%") ? t * parseFloat(e) / 100 : +e;
}
function Up(e, t, r, n, i) {
  if (!n || !i)
    return [t, r];
  if (e === "cover") {
    let o = t / n, s = r / i, a = Math.max(o, s);
    return [n * a, i * a];
  }
  if (e === "contain") {
    let o = t / n, s = r / i, a = Math.min(o, s);
    return [n * a, i * a];
  }
  if (e === "auto" || e.includes("auto")) {
    let o = e.split(" "), s = o[0] || "auto", a = o[1] || o[0] || "auto", u2 = n, l2 = i;
    if (s === "auto" && a !== "auto") {
      let f = bo(a, r);
      l2 = f, u2 = n / i * f;
    } else if (a === "auto" && s !== "auto") {
      let f = bo(s, t);
      u2 = f, l2 = i / n * f;
    }
    return [u2, l2];
  }
  return [t, r];
}
function go(e, { x: t, y: r, defaultX: n, defaultY: i }) {
  return (e ? e.split(" ").map((o) => {
    try {
      let s = new wt(o);
      return s.type === "length" || s.type === "number" ? s.value : s.value + s.unit;
    } catch {
      return null;
    }
  }).filter((o) => o !== null) : [n, i]).map((o, s) => bo(o, [t, r][s]));
}
async function Jr({ id: e, width: t, height: r, left: n, top: i }, { image: o, size: s, position: a, repeat: u2 }, l2, f) {
  u2 = u2 || "repeat", f = f || "background";
  let c2 = u2 === "repeat-x" || u2 === "repeat", m2 = u2 === "repeat-y" || u2 === "repeat", h2 = s && (s === "cover" || s === "contain" || s === "auto" || s.includes("auto")), g2 = o.startsWith("linear-gradient(") || o.startsWith("repeating-linear-gradient(") || o.startsWith("radial-gradient(") || o.startsWith("repeating-radial-gradient("), y = h2 && g2 ? [t, r] : h2 ? [0, 0] : go(s, { x: t, y: r, defaultX: t, defaultY: r }), x2 = go(a, { x: t, y: r, defaultX: 0, defaultY: 0 });
  if (o.startsWith("linear-gradient(") || o.startsWith("repeating-linear-gradient("))
    return Du({ id: e, width: t, height: r, repeatX: c2, repeatY: m2 }, o, y, x2, l2, f);
  if (o.startsWith("radial-gradient(") || o.startsWith("repeating-radial-gradient("))
    return $u({ id: e, width: t, height: r, repeatX: c2, repeatY: m2 }, o, y, x2, l2, f);
  if (o.startsWith("url(")) {
    let [w2, P2, T] = await Or(o.slice(4, -1)), A, E;
    if (h2) {
      let [_, R2] = Up(s, t, r, P2, T);
      A = _, E = R2;
    } else {
      let _ = go(s, { x: t, y: r, defaultX: 0, defaultY: 0 });
      A = f === "mask" ? P2 || _[0] : _[0] || P2, E = f === "mask" ? T || _[1] : _[1] || T;
    }
    return [`satori_bi${e}`, I("pattern", { id: `satori_bi${e}`, patternContentUnits: "userSpaceOnUse", patternUnits: "userSpaceOnUse", x: x2[0] + n, y: x2[1] + i, width: c2 ? A : "100%", height: m2 ? E : "100%" }, I("image", { x: 0, y: 0, width: A, height: E, preserveAspectRatio: "none", href: w2 }))];
  }
  if (index_esm_default(o)) {
    let w2 = index_esm_default(o), [P2, T, A, E] = w2.values, R2 = `rgba(${P2},${T},${A},${E !== void 0 ? E : 1})`;
    return [`satori_bi${e}`, I("pattern", { id: `satori_bi${e}`, patternContentUnits: "userSpaceOnUse", patternUnits: "userSpaceOnUse", x: n, y: i, width: t, height: r }, I("rect", { x: 0, y: 0, width: t, height: r, fill: R2 }))];
  }
  throw new Error(`Invalid background image: "${o}"`);
}
function qp([e, t]) {
  return Math.round(e * 1e3) === 0 && Math.round(t * 1e3) === 0 ? 0 : Math.round(e * t / Math.sqrt(e * e + t * t) * 1e3) / 1e3;
}
function fi(e, t, r) {
  return r < e + t && (r / 2 < e && r / 2 < t ? e = t = r / 2 : r / 2 < e ? e = r - t : r / 2 < t && (t = r - e)), [e, t];
}
function ci(e) {
  e[0] = e[1] = Math.min(e[0], e[1]);
}
function di(e, t, r, n, i) {
  if (typeof e == "string") {
    let o = e.split(" ").map((a) => a.trim()), s = !o[1] && !o[0].endsWith("%");
    return o[1] = o[1] || o[0], [s, [Math.min(X(o[0], n, t, i, true), t), Math.min(X(o[1], n, r, i, true), r)]];
  }
  return typeof e == "number" ? [true, [Math.min(e, t), Math.min(e, r)]] : [true, void 0];
}
var pi = (e) => e && e[0] !== 0 && e[1] !== 0;
function hi(e) {
  return typeof e != "string" ? 1 : ao(e);
}
function mi(e, t, r, n, i) {
  if (i === 1 / 0)
    return [e, r, t];
  if (i === -1 / 0)
    return [e, n, t];
  if (i === 0)
    return [e, [(e[0] + t[0]) / 2, (e[1] + t[1]) / 2], t];
  let o = i < 0 ? r : n, s = Math.pow(2, 1 - Math.abs(i));
  if (s === 0)
    return i > 0 ? [e, r, t] : [e, n, t];
  let a = [], u2 = 16;
  for (let l2 = 0; l2 <= u2; l2++) {
    let f = Math.PI * l2 / u2 / 2, c2 = Math.pow(Math.sin(f), s), m2 = Math.pow(Math.cos(f), s);
    a.push([o[0] + (t[0] - o[0]) * c2 + (e[0] - o[0]) * m2, o[1] + (t[1] - o[1]) * c2 + (e[1] - o[1]) * m2]);
  }
  return a;
}
function cr(e) {
  return `${Math.round(e[0] * 1e3) / 1e3},${Math.round(e[1] * 1e3) / 1e3}`;
}
function qu(e, t, r, n) {
  return Math.min(1, r / (e[0] + t[0] || r), n / (e[1] + t[1] || n));
}
function zp(e, t, r, n, i, o, s) {
  s != null && s.every(Boolean) && (s = void 0);
  let a = e + r, u2 = t + n, [l2, f, c2, m2] = i, h2 = [mi([e, t + l2[1]], [e + l2[0], t], [e, t], [e + l2[0], t + l2[1]], o[0]), mi([a - f[0], t], [a, t + f[1]], [a, t], [a - f[0], t + f[1]], o[1]), mi([a, u2 - c2[1]], [a - c2[0], u2], [a, u2], [a - c2[0], u2 - c2[1]], o[2]), mi([e + m2[0], u2], [e, u2 - m2[1]], [e, u2], [e + m2[0], u2 - m2[1]], o[3])];
  if (s) {
    let y = s.indexOf(true);
    if (y === -1)
      throw new Error("Invalid `partialSides`.");
    for (; s[(y + 3) % 4]; )
      y = (y + 3) % 4;
    let x2 = h2[y], w2 = Math.floor(x2.length / 2), P2 = `M${cr(x2[w2])}`, T = y;
    do {
      let A = h2[T], E = Math.floor(A.length / 2);
      for (let C = E + 1; C < A.length; C++)
        P2 += ` L${cr(A[C])}`;
      let _ = h2[(T + 1) % 4];
      P2 += ` L${cr(_[0])}`;
      let R2 = Math.floor(_.length / 2);
      for (let C = 1; C <= R2; C++)
        P2 += ` L${cr(_[C])}`;
      T = (T + 1) % 4;
    } while (s[T] && T !== y);
    return P2;
  }
  let g2 = `M${cr(h2[0][h2[0].length - 1])}`;
  for (let y = 0; y < 4; y++) {
    let x2 = h2[(y + 1) % 4];
    g2 += ` L${cr(x2[0])}`;
    for (let w2 = 1; w2 < x2.length; w2++)
      g2 += ` L${cr(x2[w2])}`;
  }
  return g2 + " Z";
}
function zu({ id: e, borderRadiusPath: t, borderType: r, left: n, top: i, width: o, height: s }, a) {
  let u2 = `satori_brc-${e}`;
  return [I("clipPath", { id: u2 }, I(r, { x: n, y: i, width: o, height: s, d: t || void 0 })), u2];
}
function Zt({ left: e, top: t, width: r, height: n }, i, o) {
  let { borderTopLeftRadius: s, borderTopRightRadius: a, borderBottomLeftRadius: u2, borderBottomRightRadius: l2, fontSize: f } = i, c2 = [hi(i.cornerTopLeftShape), hi(i.cornerTopRightShape), hi(i.cornerBottomRightShape), hi(i.cornerBottomLeftShape)], m2, h2, g2, y;
  if ([m2, s] = di(s, r, n, f, i), [h2, a] = di(a, r, n, f, i), [g2, u2] = di(u2, r, n, f, i), [y, l2] = di(l2, r, n, f, i), !o && !pi(s) && !pi(a) && !pi(u2) && !pi(l2))
    return "";
  if (s ||= [0, 0], a ||= [0, 0], u2 ||= [0, 0], l2 ||= [0, 0], [s[0], a[0]] = fi(s[0], a[0], r), [u2[0], l2[0]] = fi(u2[0], l2[0], r), [s[1], u2[1]] = fi(s[1], u2[1], n), [a[1], l2[1]] = fi(a[1], l2[1], n), m2 && ci(s), h2 && ci(a), g2 && ci(u2), y && ci(l2), c2.some((E) => E < 0)) {
    let E = Math.min(qu(s, l2, r, n), qu(a, u2, r, n));
    if (E < 1)
      for (let _ of [s, a, l2, u2])
        _[0] *= E, _[1] *= E;
  }
  if (c2.some((E) => E !== 1))
    return zp(e, t, r, n, [s, a, l2, u2], c2, o);
  let x2 = [];
  x2[0] = [a, a], x2[1] = [l2, [-l2[0], l2[1]]], x2[2] = [u2, [-u2[0], -u2[1]]], x2[3] = [s, [s[0], -s[1]]];
  let w2 = `h${r - s[0] - a[0]} a${x2[0][0]} 0 0 1 ${x2[0][1]}`, P2 = `v${n - a[1] - l2[1]} a${x2[1][0]} 0 0 1 ${x2[1][1]}`, T = `h${l2[0] + u2[0] - r} a${x2[2][0]} 0 0 1 ${x2[2][1]}`, A = `v${u2[1] + s[1] - n} a${x2[3][0]} 0 0 1 ${x2[3][1]}`;
  if (o) {
    let _ = function(he) {
      let de = qp([s, a, l2, u2][he]);
      return he === 0 ? [[e + s[0] - de, t + s[1] - de], [e + s[0], t]] : he === 1 ? [[e + r - a[0] + de, t + a[1] - de], [e + r, t + a[1]]] : he === 2 ? [[e + r - l2[0] + de, t + n - l2[1] + de], [e + r - l2[0], t + n]] : [[e + u2[0] - de, t + n - u2[1] + de], [e, t + n - u2[1]]];
    }, E = o.indexOf(false);
    if (!o.includes(true))
      throw new Error("Invalid `partialSides`.");
    if (E === -1)
      E = 0;
    else
      for (; !o[E]; )
        E = (E + 1) % 4;
    let R2 = "", C = _(E), z = `M${C[0]} A${x2[(E + 3) % 4][0]} 0 0 1 ${C[1]}`, G = 0;
    for (; G < 4 && o[(E + G) % 4]; G++)
      R2 += z + " ", z = [w2, P2, T, A][(E + G) % 4];
    let ie = (E + G) % 4;
    R2 += z.split(" ")[0];
    let te = _(ie);
    return R2 += ` A${x2[(ie + 3) % 4][0]} 0 0 1 ${te[0]}`, R2;
  }
  return `M${e + s[0]},${t} ${w2} ${P2} ${T} ${A}`;
}
function Gu(e, t, r) {
  return r[e + "Width"] === r[t + "Width"] && r[e + "Style"] === r[t + "Style"] && r[e + "Color"] === r[t + "Color"];
}
function ju({ id: e, currentClipPathId: t, borderPath: r, borderType: n, left: i, top: o, width: s, height: a }, u2) {
  if (!(u2.borderTopWidth || u2.borderRightWidth || u2.borderBottomWidth || u2.borderLeftWidth))
    return null;
  let f = `satori_bc-${e}`;
  return [I("clipPath", { id: f, "clip-path": t ? `url(#${t})` : void 0 }, I(n, { x: i, y: o, width: s, height: a, d: r || void 0 })), f];
}
function Zr({ left: e, top: t, width: r, height: n, props: i, asContentMask: o, maskBorderOnly: s }, a) {
  let u2 = ["borderTop", "borderRight", "borderBottom", "borderLeft"];
  if (!o && !u2.some((h2) => a[h2 + "Width"]))
    return "";
  let l2 = "", f = 0;
  for (; f > 0 && Gu(u2[f], u2[(f + 3) % 4], a); )
    f = (f + 3) % 4;
  let c2 = [false, false, false, false], m2 = [];
  for (let h2 = 0; h2 < 4; h2++) {
    let g2 = (f + h2) % 4, y = (f + h2 + 1) % 4, x2 = u2[g2], w2 = u2[y];
    if (c2[g2] = true, m2 = [a[x2 + "Width"], a[x2 + "Style"], a[x2 + "Color"], x2], !Gu(x2, w2, a)) {
      let P2 = (m2[0] || 0) + (o && !s && a[x2.replace("border", "padding")] || 0);
      P2 && (l2 += I("path", { width: r, height: n, ...i, fill: "none", stroke: o ? "#000" : m2[2], "stroke-width": P2 * 2, "stroke-dasharray": !o && m2[1] === "dashed" ? P2 * 2 + " " + P2 : void 0, d: Zt({ left: e, top: t, width: r, height: n }, a, c2) })), c2 = [false, false, false, false];
    }
  }
  if (c2.some(Boolean)) {
    let h2 = (m2[0] || 0) + (o && !s && a[m2[3].replace("border", "padding")] || 0);
    h2 && (l2 += I("path", { width: r, height: n, ...i, fill: "none", stroke: o ? "#000" : m2[2], "stroke-width": h2 * 2, "stroke-dasharray": !o && m2[1] === "dashed" ? h2 * 2 + " " + h2 : void 0, d: Zt({ left: e, top: t, width: r, height: n }, a, c2) }));
  }
  return l2;
}
function yo({ id: e, left: t, top: r, width: n, height: i, matrix: o, borderOnly: s }, a) {
  let u2 = (a.borderLeftWidth || 0) + (s ? 0 : a.paddingLeft || 0), l2 = (a.borderTopWidth || 0) + (s ? 0 : a.paddingTop || 0), f = (a.borderRightWidth || 0) + (s ? 0 : a.paddingRight || 0), c2 = (a.borderBottomWidth || 0) + (s ? 0 : a.paddingBottom || 0), m2 = { x: t + u2, y: r + l2, width: n - u2 - f, height: i - l2 - c2 };
  return I("mask", { id: e }, I("rect", { ...m2, fill: "#fff", transform: a.overflow === "hidden" && a.transform && o ? o : void 0, mask: a._inheritedMaskId ? `url(#${a._inheritedMaskId})` : void 0 }) + Zr({ left: t, top: r, width: n, height: i, props: { transform: o || void 0 }, asContentMask: true, maskBorderOnly: s }, a));
}
var wo = { left: 0, "x-start": 0, center: 0.5, right: 1, "x-end": 1 };
var So = { top: 0, "y-start": 0, center: 0.5, bottom: 1, "y-end": 1 };
function It(e) {
  return Math.round(e * 1e3) / 1e3;
}
function Hu(e, t, r, n) {
  let i = e.match(/^shape\((.*)\)$/s);
  if (!i)
    return null;
  let o = zt(i[1]), s = o.shift();
  if (!s)
    throw new Error("Invalid `shape()` value.");
  let a = s.match(/^(?:(nonzero|evenodd)\s+)?from\s+(.+)$/);
  if (!a)
    throw new Error("Invalid `shape()` starting point.");
  let u2 = a[1] || "nonzero", l2 = _o(Vu(a[2]), t, r, n), f = l2, c2 = `M${It(l2[0])},${It(l2[1])}`;
  for (let m2 of o) {
    let h2 = Vu(m2), g2 = h2.shift();
    if (g2 === "close") {
      if (h2.length)
        throw new Error("Invalid `close` command in `shape()`.");
      c2 += " Z", l2 = f;
      continue;
    }
    if (g2 === "move" || g2 === "line") {
      let y = vo(h2, l2, t, r, n);
      c2 += ` ${g2 === "move" ? "M" : "L"}${It(y[0])},${It(y[1])}`, l2 = y, g2 === "move" && (f = y);
      continue;
    }
    if (g2 === "hline" || g2 === "vline") {
      let y = g2 === "hline" ? 0 : 1, x2 = h2.shift(), w2 = h2.shift();
      if (x2 !== "to" && x2 !== "by" || !w2 || h2.length)
        throw new Error(`Invalid \`${g2}\` command in \`shape()\`.`);
      let P2 = y === 0 ? t : r, T = y === 0 ? wo : So, A = x2 === "to" && w2 in T ? T[w2] * P2 : er(w2, P2, n);
      l2 = [...l2], l2[y] = x2 === "by" ? l2[y] + A : A, c2 += ` ${y === 0 ? "H" : "V"}${It(l2[y])}`;
      continue;
    }
    if (g2 === "curve" || g2 === "smooth") {
      let y = h2.indexOf("with"), x2 = y === -1 ? h2 : h2.slice(0, y), w2 = y === -1 ? [] : h2.slice(y + 1), P2 = x2[0], T = vo(x2, l2, t, r, n);
      if (g2 === "curve" && y === -1)
        throw new Error("A `curve` command requires a control point.");
      let A = Gp(w2).map((E) => jp(E, l2, T, t, r, n));
      if (g2 === "curve")
        if (A.length === 1)
          c2 += ` Q${Vt(A[0])} ${Vt(T)}`;
        else if (A.length === 2)
          c2 += ` C${Vt(A[0])} ${Vt(A[1])} ${Vt(T)}`;
        else
          throw new Error("A `curve` command accepts one or two control points.");
      else if (!A.length)
        c2 += ` T${Vt(T)}`;
      else if (A.length === 1)
        c2 += ` S${Vt(A[0])} ${Vt(T)}`;
      else
        throw new Error("A `smooth` command accepts at most one control point.");
      l2 = T;
      continue;
    }
    if (g2 === "arc") {
      let y = h2.findIndex((C) => ["of", "cw", "ccw", "large", "small", "rotate"].includes(C)), x2 = y === -1 ? h2 : h2.slice(0, y), w2 = y === -1 ? [] : h2.slice(y), P2 = vo(x2, l2, t, r, n), T = 0, A = 0, E = 0, _ = 0, R2 = 0;
      for (let C = 0; C < w2.length; C++) {
        let z = w2[C];
        if (z === "of") {
          let G = w2[++C];
          if (!G)
            throw new Error("Invalid `arc` radius in `shape()`.");
          let ie = w2[C + 1], te = ie && !["cw", "ccw", "large", "small", "rotate"].includes(ie);
          if (te && C++, te)
            T = er(G, t, n), A = er(ie, r, n);
          else {
            let he = Math.sqrt(t * t + r * r) / Math.sqrt(2);
            T = A = er(G, he, n);
          }
        } else if (z === "cw" || z === "ccw")
          R2 = z === "cw" ? 1 : 0;
        else if (z === "large" || z === "small")
          _ = z === "large" ? 1 : 0;
        else if (z === "rotate") {
          let G = w2[++C];
          if (!G)
            throw new Error("Invalid `arc` rotation in `shape()`.");
          let ie = ur(G);
          if (typeof ie > "u")
            throw new Error("Invalid `arc` rotation in `shape()`.");
          E = ie;
        } else
          throw new Error("Invalid `arc` option in `shape()`.");
      }
      c2 += ` A${It(Math.abs(T))},${It(Math.abs(A))} ${It(E)} ${_} ${R2} ${Vt(P2)}`, l2 = P2;
      continue;
    }
    throw new Error(`Unsupported \`${g2}\` command in \`shape()\`.`);
  }
  return { type: "path", d: c2, "fill-rule": u2 };
}
function Vu(e) {
  return e.trim().replace(/\//g, " / ").split(/\s+/).filter(Boolean);
}
function Gp(e) {
  if (!e.length)
    return [];
  let t = e.indexOf("/");
  return t === -1 ? [e] : [e.slice(0, t), e.slice(t + 1)];
}
function vo(e, t, r, n, i) {
  let o = e[0];
  if (o !== "to" && o !== "by")
    throw new Error("A `shape()` command must use `to` or `by`.");
  let s = _o(e.slice(1), r, n, i);
  return o === "by" ? [t[0] + s[0], t[1] + s[1]] : s;
}
function jp(e, t, r, n, i, o) {
  let s = e.indexOf("from"), a = s === -1 ? e : e.slice(0, s), u2 = s === -1 ? void 0 : e[s + 1];
  if (s !== -1 && (s + 2 !== e.length || !u2))
    throw new Error("Invalid control point reference in `shape()`.");
  let l2 = _o(a, n, i, o, true);
  return u2 === "start" || !u2 && !Vp(e) ? [t[0] + l2[0], t[1] + l2[1]] : u2 === "end" ? [r[0] + l2[0], r[1] + l2[1]] : l2;
}
function _o(e, t, r, n, i = false) {
  if (!e.length || e.length > 4)
    throw new Error("Invalid position in `shape()`.");
  let o, s, a = [...e];
  for (let u2 = 0; u2 < a.length; u2++) {
    let l2 = a[u2];
    if (l2 === "left" || l2 === "right" || l2 === "x-start" || l2 === "x-end") {
      let f = a[u2 + 1];
      if (f && !xo(f)) {
        let c2 = er(f, t, n);
        o = l2 === "left" || l2 === "x-start" ? c2 : t - c2, u2++;
      } else
        o = wo[l2] * t;
    } else if (l2 === "top" || l2 === "bottom" || l2 === "y-start" || l2 === "y-end") {
      let f = a[u2 + 1];
      if (f && !xo(f)) {
        let c2 = er(f, r, n);
        s = l2 === "top" || l2 === "y-start" ? c2 : r - c2, u2++;
      } else
        s = So[l2] * r;
    } else if (l2 === "center")
      if (o === void 0)
        o = t / 2;
      else if (s === void 0)
        s = r / 2;
      else
        throw new Error("Invalid position in `shape()`.");
    else if (o === void 0)
      o = er(l2, t, n);
    else if (s === void 0)
      s = er(l2, r, n);
    else
      throw new Error("Invalid position in `shape()`.");
  }
  return !i && e.length === 1 && s === void 0 && (s = r / 2), [o ?? (i ? 0 : t / 2), s ?? (i ? 0 : r / 2)];
}
function xo(e) {
  return e in wo || e in So;
}
function Vp(e) {
  return e.some(xo);
}
function er(e, t, r) {
  let n = X(e, r.fontSize, t, r, true);
  if (typeof n > "u")
    throw new Error(`Invalid length \`${e}\` in \`shape()\`.`);
  return n;
}
function Vt(e) {
  return `${It(e[0])},${It(e[1])}`;
}
var Ar = { circle: /circle\((.+)\)/, ellipse: /ellipse\((.+)\)/, path: /path\((.+)\)/, polygon: /polygon\((.+)\)/, inset: /inset\((.+)\)/, shape: /shape\((.+)\)/ };
function Qu({ width: e, height: t }, r, n) {
  function i(f) {
    let c2 = f.match(Ar.circle);
    if (!c2)
      return null;
    let [, m2] = c2, [h2, g2 = ""] = m2.split("at").map((w2) => w2.trim()), { x: y, y: x2 } = Ku(g2, e, t);
    return { type: "circle", r: X(h2, n.fontSize, Math.sqrt(Math.pow(e, 2) + Math.pow(t, 2)) / Math.sqrt(2), n, true), cx: X(y, n.fontSize, e, n, true), cy: X(x2, n.fontSize, t, n, true) };
  }
  function o(f) {
    let c2 = f.match(Ar.ellipse);
    if (!c2)
      return null;
    let [, m2] = c2, [h2, g2 = ""] = m2.split("at").map((T) => T.trim()), [y, x2] = h2.split(" "), { x: w2, y: P2 } = Ku(g2, e, t);
    return { type: "ellipse", rx: X(y || "50%", n.fontSize, e, n, true), ry: X(x2 || "50%", n.fontSize, t, n, true), cx: X(w2, n.fontSize, e, n, true), cy: X(P2, n.fontSize, t, n, true) };
  }
  function s(f) {
    let c2 = f.match(Ar.path);
    if (!c2)
      return null;
    let [m2, h2] = Xu(c2[1]);
    return { type: "path", d: h2, "fill-rule": m2 };
  }
  function a(f) {
    let c2 = f.match(Ar.polygon);
    if (!c2)
      return null;
    let [m2, h2] = Xu(c2[1]);
    return { type: "polygon", "fill-rule": m2, points: h2.split(",").map((g2) => g2.split(" ").map((y, x2) => X(y, n.fontSize, x2 === 0 ? e : t, n, true)).join(" ")).join(",") };
  }
  function u2(f) {
    let c2 = f.match(Ar.inset);
    if (!c2)
      return null;
    let [m2, h2] = (c2[1].includes("round") ? c2[1] : `${c2[1].trim()} round 0`).split("round"), g2 = (0, import_css_to_react_native3.getStylesForProperty)("borderRadius", h2, true), y = Object.values(g2).map((E) => String(E)).map((E, _) => X(E, n.fontSize, _ === 0 || _ === 2 ? t : e, n, true) || 0), x2 = Object.values((0, import_css_to_react_native3.getStylesForProperty)("margin", m2, true)).map((E) => String(E)).map((E, _) => X(E, n.fontSize, _ === 0 || _ === 2 ? t : e, n, true) || 0), w2 = x2[3], P2 = x2[0], T = e - (x2[1] + x2[3]), A = t - (x2[0] + x2[2]);
    return y.some((E) => E > 0) ? { type: "path", d: Zt({ left: w2, top: P2, width: T, height: A }, { ...r, ...g2 }) } : { type: "rect", x: w2, y: P2, width: T, height: A };
  }
  function l2(f) {
    return Ar.shape.test(f) ? Hu(f, e, t, n) : null;
  }
  return { parseCircle: i, parseEllipse: o, parsePath: s, parsePolygon: a, parseInset: u2, parseShape: l2 };
}
function Xu(e) {
  let [, t = "nonzero", r] = e.replace(/('|")/g, "").match(/^(nonzero|evenodd)?,?(.+)/) || [];
  return [t, r];
}
function Ku(e, t, r) {
  let n = e.split(" "), i = { x: n[0] || "50%", y: n[1] || "50%" };
  return n.forEach((o) => {
    o === "top" ? i.y = 0 : o === "bottom" ? i.y = r : o === "left" ? i.x = 0 : o === "right" ? i.x = t : o === "center" && (i.x = t / 2, i.y = r / 2);
  }), i;
}
function gi(e) {
  return `satori_cp-${e}`;
}
function Ju(e) {
  return `url(#${gi(e)})`;
}
function Zu(e, t, r) {
  if (t.clipPath === "none")
    return "";
  let n = Qu(e, t, r), i = t.clipPath, o = { type: "" };
  for (let s of Object.keys(n))
    if (o = n[s](i), o)
      break;
  if (o) {
    let { type: s, ...a } = o;
    return I("clipPath", { id: gi(e.id), "clip-path": e.currentClipPath, transform: `translate(${e.left}, ${e.top})` }, I(s, a));
  }
  return "";
}
function To({ left: e, top: t, width: r, height: n, path: i, matrix: o, id: s, currentClipPath: a, src: u2 }, l2, f) {
  let c2 = "", m2 = l2.clipPath && l2.clipPath !== "none" ? Zu({ left: e, top: t, width: r, height: n, path: i, id: s, matrix: o, currentClipPath: a, src: u2 }, l2, f) : "";
  if (l2.overflow !== "hidden" && !u2)
    c2 = "";
  else {
    let g2 = m2 ? `satori_ocp-${s}` : gi(s);
    c2 = I("clipPath", { id: g2, "clip-path": a }, I(i ? "path" : "rect", { x: e, y: t, width: r, height: n, d: i || void 0, transform: l2.overflow === "hidden" && l2.transform && o ? o : void 0 }));
  }
  let h2 = yo({ id: `satori_om-${s}`, left: e, top: t, width: r, height: n, matrix: o, borderOnly: !u2 }, l2);
  return m2 + c2 + h2;
}
var Hp = (e) => `satori_mi-${e}`;
async function Eo(e, t, r) {
  if (!t.maskImage)
    return ["", ""];
  let { left: n, top: i, width: o, height: s, id: a } = e, u2 = t.maskImage, l2 = u2.length;
  if (!l2)
    return ["", ""];
  let f = Hp(a), c2 = "";
  for (let m2 = 0; m2 < l2; m2++) {
    let h2 = u2[m2], [g2, y] = await Jr({ id: `${f}-${m2}`, left: n, top: i, width: o, height: s }, h2, r, "mask");
    c2 += y + I("rect", { x: n, y: i, width: o, height: s, fill: `url(#${g2})` });
  }
  return c2 = I("mask", { id: f }, c2), [f, c2];
}
function el({ id: e, left: t, top: r, width: n, height: i, path: o, type: s, matrix: a, currentClipPath: u2, mask: l2, filters: f }) {
  if (!f.length)
    return ["", ""];
  let c2 = `satori_bf-${e}`, m2 = `satori_bfc-${e}`, h2 = Xp(f), g2 = "BackgroundImage", y = "";
  f.forEach((P2, T) => {
    let A = `${c2}-${T}`;
    y += Yp(P2, g2, A), g2 = A;
  });
  let x2 = I("filter", { id: c2, x: t - h2.left, y: r - h2.top, width: n + h2.left + h2.right, height: i + h2.top + h2.bottom, filterUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" }, y) + I("clipPath", { id: m2, "clip-path": u2 }, I(s, { x: t, y: r, width: n, height: i, d: o || void 0, transform: a || void 0 })), w2 = I(s, { x: t, y: r, width: n, height: i, d: o || void 0, fill: "#000", transform: a || void 0, filter: `url(#${c2})`, "clip-path": `url(#${m2})`, mask: l2 });
  return [x2, w2];
}
function Yp(e, t, r) {
  if (e.type === "blur")
    return I("feGaussianBlur", { in: t, stdDeviation: e.value, result: r });
  if (e.type === "hue-rotate")
    return I("feColorMatrix", { in: t, type: "hueRotate", values: e.value, result: r });
  if (e.type === "saturate" || e.type === "grayscale")
    return I("feColorMatrix", { in: t, type: "saturate", values: e.type === "grayscale" ? 1 - e.value : e.value, result: r });
  if (e.type === "sepia") {
    let s = e.value, a = 1 - s;
    return I("feColorMatrix", { in: t, type: "matrix", values: [a + 0.393 * s, 0.769 * s, 0.189 * s, 0, 0, 0.349 * s, a + 0.686 * s, 0.168 * s, 0, 0, 0.272 * s, 0.534 * s, a + 0.131 * s, 0, 0, 0, 0, 0, 1, 0].join(" "), result: r });
  }
  if (e.type === "drop-shadow") {
    let s = `${r}-input`;
    return I("feComposite", { in: t, in2: "SourceAlpha", operator: "in", result: s }) + I("feDropShadow", { in: s, dx: e.offsetX, dy: e.offsetY, stdDeviation: e.blurRadius, "flood-color": e.color, result: r });
  }
  let n = e.value, i = e.type === "brightness" ? { slope: n } : e.type === "contrast" ? { slope: n, intercept: 0.5 - 0.5 * n } : e.type === "invert" ? { slope: 1 - 2 * n, intercept: n } : { slope: n }, o = e.type === "opacity" ? ["A"] : ["R", "G", "B"];
  return I("feComponentTransfer", { in: t, result: r }, o.map((s) => I(`feFunc${s}`, { type: "linear", ...i })).join(""));
}
function Xp(e) {
  let t = 0, r = 0, n = 0, i = 0;
  for (let o of e)
    if (o.type === "blur") {
      let s = o.value * 3;
      t = Math.max(t, s), r = Math.max(r, s), n = Math.max(n, s), i = Math.max(i, s);
    } else if (o.type === "drop-shadow") {
      let s = o.blurRadius * 3;
      t = Math.max(t, s - o.offsetX), r = Math.max(r, s - o.offsetY), n = Math.max(n, s + o.offsetX), i = Math.max(i, s + o.offsetY);
    }
  return { left: t, top: r, right: n, bottom: i };
}
function Kp(e, t, r) {
  let n = e.toLowerCase().trim().split(/\s+/), i = (u2, l2) => ({ left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" })[u2] || u2, o, s;
  if (n.length === 1) {
    let u2 = n[0];
    u2 === "left" || u2 === "center" || u2 === "right" ? (o = i(u2, "x"), s = "50%") : u2 === "top" || u2 === "bottom" ? (o = "50%", s = i(u2, "y")) : (o = u2, s = "50%");
  } else {
    let u2 = n[0], l2 = n[1];
    u2 === "top" || u2 === "bottom" ? (s = i(u2, "y"), l2 === "left" || l2 === "right" || l2 === "center" ? o = i(l2, "x") : (o = "50%", s = u2 === "top" || u2 === "bottom" ? i(u2, "y") : l2)) : (o = i(u2, "x"), s = i(l2, "y"));
  }
  let a = (u2, l2) => {
    try {
      if (u2.endsWith("%"))
        return l2 * parseFloat(u2) / 100;
      let f = new wt(u2);
      return f.type === "length" || f.type === "number" ? f.value : 0;
    } catch {
      return 0;
    }
  };
  return [a(o, t), a(s, r)];
}
async function en({ id: e, left: t, top: r, width: n, height: i, isInheritingTransform: o, src: s, debug: a }, u2, l2) {
  if (u2.display === "none")
    return "";
  let f = !!s, c2 = "rect", m2 = "", h2 = "", g2 = [], y = 1, x2 = "";
  u2.backgroundColor && g2.push(u2.backgroundColor), u2.opacity !== void 0 && (y = +u2.opacity), u2.transform && (m2 = Qr({ left: t, top: r, width: n, height: i }, u2.transform, o, u2.transformOrigin));
  let w2 = "";
  if (u2.backgroundImage) {
    let re = [];
    for (let me = 0; me < u2.backgroundImage.length; me++) {
      let rt = u2.backgroundImage[me], qe = await Jr({ id: e + "_" + me, width: n, height: i, left: t, top: r }, rt, l2);
      qe && re.unshift(qe);
    }
    for (let me of re)
      g2.push(`url(#${me[0]})`), h2 += me[1], me[2] && (w2 += me[2]);
  }
  let [P2, T] = await Eo({ id: e, left: t, top: r, width: n, height: i }, u2, l2);
  h2 += T;
  let A = P2 ? `url(#${P2})` : u2._inheritedMaskId ? `url(#${u2._inheritedMaskId})` : void 0, E = Zt({ left: t, top: r, width: n, height: i }, u2);
  E && (c2 = "path");
  let _ = u2._inheritedClipPathId;
  a && (x2 = I("rect", { x: t, y: r, width: n, height: i, fill: "transparent", stroke: "#ff5757", "stroke-width": 1, transform: m2 || void 0, "clip-path": _ ? `url(#${_})` : void 0 }));
  let { backgroundClip: R2, filter: C } = u2, z = R2 === "text" ? `url(#satori_bct-${e})` : _ ? `url(#${_})` : u2.clipPath ? Ju(e) : void 0, G = To({ left: t, top: r, width: n, height: i, path: E, id: e, matrix: m2, currentClipPath: z, src: s }, u2, l2), [ie, te] = el({ id: e, left: t, top: r, width: n, height: i, path: E, type: c2, matrix: m2 || void 0, currentClipPath: z, mask: A, filters: u2._backdropFilters || [] });
  h2 += ie;
  let he = y !== 1 && !f && g2.length === 1 && !te && !w2 && !C && !A && !u2.boxShadow && !(u2.borderTopWidth || u2.borderRightWidth || u2.borderBottomWidth || u2.borderLeftWidth), de = g2.map((re) => I(c2, { x: t, y: r, width: n, height: i, fill: re, "fill-opacity": he ? y : void 0, d: E || void 0, transform: m2 || void 0, "clip-path": u2.transform ? void 0 : z, style: C ? `filter:${C}` : void 0, mask: u2.transform ? void 0 : A })).join(""), Me = ju({ id: e, left: t, top: r, width: n, height: i, currentClipPathId: _, borderPath: E, borderType: c2 }, u2), Re;
  if (f) {
    let re = (u2.borderLeftWidth || 0) + (u2.paddingLeft || 0), me = (u2.borderTopWidth || 0) + (u2.paddingTop || 0), rt = (u2.borderRightWidth || 0) + (u2.paddingRight || 0), qe = (u2.borderBottomWidth || 0) + (u2.paddingBottom || 0), Ae = n - re - rt, ne = i - me - qe, Q = (u2.objectPosition || "center").toString(), [we, Z] = Kp(Q, Ae, ne), j = u2.__naturalWidth || Ae, Ee = u2.__naturalHeight || ne, Ie, Ce = Ae, Fe = ne, le = t + re, Qe = r + me;
    if (u2.objectFit === "contain") {
      let nt = Ae / j, Ne = ne / Ee, be = Math.min(nt, Ne);
      Ce = j * be, Fe = Ee * be, le = t + re + we - Ce * we / Ae, Qe = r + me + Z - Fe * Z / ne, Ie = "none";
    } else if (u2.objectFit === "cover") {
      let nt = Ae / j, Ne = ne / Ee, be = Math.max(nt, Ne);
      Ce = j * be, Fe = Ee * be, le = t + re + we - Ce * we / Ae, Qe = r + me + Z - Fe * Z / ne, Ie = "none";
    } else if (u2.objectFit === "fill")
      Ie = "none";
    else if (u2.objectFit === "scale-down")
      if (j && Ee) {
        let nt = Ae / j, Ne = ne / Ee, be = Math.min(nt, Ne);
        if (be >= 1)
          Ce = j, Fe = Ee, Ie = "none", le = t + re + we - Ce * we / Ae, Qe = r + me + Z - Fe * Z / ne;
        else {
          let Ge = be;
          Ce = j * Ge, Fe = Ee * Ge, le = t + re + we - Ce * we / Ae, Qe = r + me + Z - Fe * Z / ne, Ie = "none";
        }
      } else {
        let nt = Ae / j, Ne = ne / Ee, be = Math.min(nt, Ne);
        Ce = j * be, Fe = Ee * be, le = t + re + we - Ce * we / Ae, Qe = r + me + Z - Fe * Z / ne, Ie = "none";
      }
    else
      Ie = "none";
    u2.transform && (Re = zu({ id: e, borderRadiusPath: E, borderType: c2, left: t, top: r, width: n, height: i }, u2)), de += I("image", { x: le, y: Qe, width: Ce, height: Fe, href: s, preserveAspectRatio: Ie, transform: m2 || void 0, style: C ? `filter:${C}` : void 0, "clip-path": u2.transform ? Re ? `url(#${Re[1]})` : void 0 : `url(#satori_cp-${e})`, mask: u2.transform ? void 0 : P2 ? `url(#${P2})` : `url(#satori_om-${e})` });
  }
  if (Me) {
    h2 += Me[0];
    let re = Me[1];
    de += Zr({ left: t, top: r, width: n, height: i, props: { transform: m2 || void 0, "clip-path": `url(#${re})` } }, u2);
  }
  let Oe = Cu({ width: n, height: i, id: e, opacity: y, shape: I(c2, { x: t, y: r, width: n, height: i, fill: "#fff", stroke: "#fff", "stroke-width": 0, d: E || void 0, transform: m2 || void 0, "clip-path": z, mask: A }) }, u2), $e = te + (w2 || de);
  return u2.transform && (z || A) && ($e = I("g", { "clip-path": z || void 0, mask: A || void 0 }, $e)), y !== 1 && !he && ($e = I("g", { opacity: y }, $e)), (h2 ? I("defs", {}, h2) : "") + (Oe ? Oe[0] : "") + (Re ? Re[0] : "") + G + $e + (Oe ? Oe[1] : "") + x2;
}
var rl = String.raw;
var tl = rl`\p{Emoji}(?:\p{EMod}|[\u{E0020}-\u{E007E}]+\u{E007F}|\uFE0F?\u20E3?)`;
var nl = () => new RegExp(rl`\p{RI}{2}|(?![#*\d](?!\uFE0F?\u20E3))${tl}(?:\u200D${tl})*`, "gu");
var Qp = new RegExp(nl(), "u");
var ko = { emoji: Qp, symbol: /\p{Symbol}/u, math: /\p{Math}/u };
var Po = { "ja-JP": /\p{scx=Hira}|\p{scx=Kana}|\p{scx=Han}|[\u3000]|[\uFF00-\uFFEF]/u, "ko-KR": /\p{scx=Hangul}/u, "zh-CN": /\p{scx=Han}/u, "zh-TW": /\p{scx=Han}/u, "zh-HK": /\p{scx=Han}/u, "th-TH": /\p{scx=Thai}/u, "bn-IN": /\p{scx=Bengali}/u, "ar-AR": /\p{scx=Arabic}/u, "ta-IN": /\p{scx=Tamil}/u, "ml-IN": /\p{scx=Malayalam}/u, "he-IL": /\p{scx=Hebrew}/u, "te-IN": /\p{scx=Telugu}/u, devanagari: /\p{scx=Devanagari}/u, kannada: /\p{scx=Kannada}/u };
var bi = Object.keys({ ...Po, ...ko });
function il(e) {
  return bi.includes(e);
}
function ol(e, t) {
  for (let n of Object.keys(ko))
    if (ko[n].test(e))
      return [n];
  let r = Object.keys(Po).filter((n) => Po[n].test(e));
  if (r.length === 0)
    return ["unknown"];
  if (t) {
    let n = r.findIndex((i) => i === t);
    n !== -1 && (r.splice(n, 1), r.unshift(t));
  }
  return r;
}
function sl(e) {
  if (e)
    return bi.find((t) => t.toLowerCase().startsWith(e.toLowerCase()));
}
async function* tn(e, t) {
  var ne;
  let r = await Qt(), { id: n, inheritedStyle: i, parent: o, font: s, debug: a, locale: u2, embedFont: l2 = true, graphemeImages: f, canLoadAdditionalAssets: c2, getTwStyles: m2 } = t;
  if (e === null || typeof e > "u")
    return yield, yield, "";
  if (!Sr(e) || Fa(e.type)) {
    let Q;
    if (!Sr(e))
      Q = mo(String(e), t), yield (await Q.next()).value;
    else {
      if (Ma(e.type))
        throw new Error("Class component is not supported.");
      let Z;
      ji(e.type) ? Z = e.type.render : Z = e.type, Q = tn(await Z(e.props), t), yield (await Q.next()).value;
    }
    await Q.next();
    let we = yield;
    return (await Q.next(we)).value;
  }
  let { type: h2, props: g2 } = e, y = h2;
  if (g2 && Na(g2))
    throw new Error("dangerouslySetInnerHTML property is not supported. See documentation for more information https://github.com/vercel/satori#jsx.");
  let { style: x2, children: w2, tw: P2, lang: T = u2 } = g2 || {}, A = sl(T);
  if (P2) {
    let Q = m2(P2, x2);
    x2 = Object.assign(Q, x2);
  }
  let E = r.Node.create();
  o.insertChild(E, o.getChildCount());
  let [_, R2] = await uo(E, y, i, x2, g2), C = _.transform === i.transform;
  if (C || (_.transform.__parent = i.transform), (_.overflow === "hidden" || _.clipPath && _.clipPath !== "none") && (R2._inheritedClipPathId = `satori_cp-${n}`, R2._inheritedMaskId = `satori_om-${n}`), _.maskImage && (R2._inheritedMaskId = `satori_mi-${n}`), _.backgroundClip === "text") {
    let Q = { value: "" };
    R2._inheritedBackgroundClipTextPath = Q, _._inheritedBackgroundClipTextPath = Q, _.backgroundImage && (R2._inheritedBackgroundClipTextHasBackground = "true", _._inheritedBackgroundClipTextHasBackground = "true");
  }
  let z = Da(w2), G = [], ie = 0, te = [];
  for (let Q of z) {
    let we = tn(Q, { id: n + "-" + ie++, parentStyle: _, inheritedStyle: R2, isInheritingTransform: true, parent: E, font: s, embedFont: l2, debug: a, graphemeImages: f, canLoadAdditionalAssets: c2, locale: A, getTwStyles: m2, onNodeDetected: t.onNodeDetected });
    c2 ? te.push(...(await we.next()).value || []) : await we.next(), G.push(we);
  }
  yield te;
  for (let Q of G)
    await Q.next();
  let [he, de] = yield, { left: Me, top: Re, width: Oe, height: $e } = E.getComputedLayout();
  Me += he, Re += de;
  let re = "", me = "", rt = "", { children: qe, ...Ae } = g2;
  if ((ne = t.onNodeDetected) == null || ne.call(t, { left: Me, top: Re, width: Oe, height: $e, type: y, props: Ae, key: e.key, textContent: Sr(qe) ? void 0 : qe }), y === "img") {
    let Q = _.__src;
    me = await en({ id: n, left: Me, top: Re, width: Oe, height: $e, src: Q, isInheritingTransform: C, debug: a }, _, R2);
  } else if (y === "svg") {
    let Q = _.color, we = await gu(e, Q);
    me = await en({ id: n, left: Me, top: Re, width: Oe, height: $e, src: we, isInheritingTransform: C, debug: a }, _, R2);
  } else {
    let Q = x2 == null ? void 0 : x2.display;
    if (y === "div" && w2 && typeof w2 != "string" && Q !== "flex" && Q !== "none" && Q !== "contents")
      throw new Error('Expected <div> to have explicit "display: flex", "display: contents", or "display: none" if it has more than one child node.');
    me = await en({ id: n, left: Me, top: Re, width: Oe, height: $e, isInheritingTransform: C, debug: a }, _, R2);
  }
  for (let Q of G)
    re += (await Q.next([Me, Re])).value;
  return _._inheritedBackgroundClipTextPath && (rt += I("clipPath", { id: `satori_bct-${n}`, "clip-path": _._inheritedClipPathId ? `url(#${_._inheritedClipPathId})` : void 0 }, _._inheritedBackgroundClipTextPath.value)), rt + me + re;
}
var pt = null;
var yi = null;
var Oo = /* @__PURE__ */ new WeakMap();
var Ro = typeof FinalizationRegistry == "function" ? new FinalizationRegistry((e) => e.destroy()) : null;
async function al() {
  if (!pt) {
    if (yi) {
      await yi;
      return;
    }
    yi = (async () => {
      if (pt = await import_harfbuzzjs.default, !pt || typeof pt.createBlob != "function")
        throw new Error("HarfBuzz module loaded but API is not available");
    })(), await yi;
  }
}
function Zp(e) {
  if (!pt)
    throw new Error("HarfBuzz not initialized. Call initHarfBuzz() first.");
  if (Oo.has(e))
    return Oo.get(e);
  let t = e._rawFontData;
  if (!t)
    throw new Error("Font does not have _rawFontData. Make sure to store the original ArrayBuffer when loading fonts.");
  let r = pt.createBlob(new Uint8Array(t)), n = pt.createFace(r, 0), i = pt.createFont(n);
  n.destroy(), r.destroy();
  let o = e.unitsPerEm;
  return i.setScale(o, o), Oo.set(e, i), Ro == null || Ro.register(e, i), i;
}
function ul(e, t, r = {}) {
  if (!pt)
    throw new Error("HarfBuzz not initialized");
  if (!t || t.length === 0)
    return [];
  let { features: n, language: i, script: o, direction: s } = r, a = Zp(e), u2 = pt.createBuffer();
  try {
    u2.addText(t), u2.guessSegmentProperties(), i && u2.setLanguage(i), o && u2.setScript(o), s && u2.setDirection(s);
    let l2;
    if (n && Object.keys(n).length > 0) {
      let c2 = [];
      for (let [m2, h2] of Object.entries(n))
        typeof h2 == "boolean" ? c2.push(h2 ? `+${m2}` : `-${m2}`) : c2.push(`${m2}=${h2}`);
      l2 = c2.join(",");
    }
    return l2 ? pt.shape(a, u2, l2) : pt.shape(a, u2), u2.json(a);
  } finally {
    u2.destroy();
  }
}
function ll(e) {
  if (!e || e === "normal")
    return {};
  let t = {}, r = e.split(",").map((n) => n.trim());
  for (let n of r) {
    let i = n.match(/["']([a-z0-9]{4})["']\s*(?:(on|off|[0-9]+))?/i);
    if (i) {
      let o = i[1], s = i[2];
      if (!s || s === "on" || s === "1")
        t[o] = true;
      else if (s === "off" || s === "0")
        t[o] = false;
      else {
        let a = parseInt(s, 10);
        isNaN(a) || (t[o] = a);
      }
    }
  }
  return t;
}
var th = 256;
function rh(e) {
  return /^\s$/.test(e);
}
function nh(e, t) {
  if (!e)
    return [];
  let r = De(e, "grapheme"), n = [], i = "", o = null;
  for (let s of r) {
    let a;
    rh(s) && o !== null && o.charToGlyphIndex(s) ? a = o : a = t(s), o === null ? (o = a, i = s) : a === o ? i += s : (n.push([i, o]), i = s, o = a);
  }
  return i && o && n.push([i, o]), n;
}
function ih(e) {
  let t = new DataView(e), r = t.getUint16(12), n = t.getUint32(16), i = new ArrayBuffer(n), o = new DataView(i), s = new Uint8Array(i);
  o.setUint32(0, t.getUint32(4)), o.setUint16(4, r);
  let a = Math.floor(Math.log2(r)), u2 = (1 << a) * 16;
  o.setUint16(6, u2), o.setUint16(8, a), o.setUint16(10, r * 16 - u2);
  let l2 = 12 + r * 16;
  for (let f = 0; f < r; f++) {
    let c2 = 44 + f * 20, m2 = t.getUint32(c2), h2 = t.getUint32(c2 + 4), g2 = t.getUint32(c2 + 8), y = t.getUint32(c2 + 12), x2 = t.getUint32(c2 + 16), w2 = 12 + f * 16;
    if (o.setUint32(w2, m2), o.setUint32(w2 + 4, x2), o.setUint32(w2 + 8, l2), o.setUint32(w2 + 12, y), g2 < y) {
      let P2 = new Uint8Array(e, h2 + 2, g2 - 2), T = new Uint8Array(y);
      inflateSync2(P2, T), s.set(T, l2);
    } else
      s.set(new Uint8Array(e, h2, y), l2);
    l2 += y + 3 & -4;
  }
  return i;
}
var fl3 = "unknown";
function oh(e) {
  let t = [], r = [0, 0], n = [0, 0], i = (o, s) => {
    let a = o[0];
    for (let u2 = 1; u2 <= s; u2++) {
      let l2 = u2 / s, f = sh(o, l2);
      t.push({ from: a, to: f }), a = f;
    }
    n = o[o.length - 1];
  };
  for (let o of e) {
    if (o.type === "M") {
      r = n = [o.x, o.y];
      continue;
    }
    if (o.type === "L") {
      let s = [o.x, o.y];
      t.push({ from: n, to: s }), n = s;
      continue;
    }
    if (o.type === "Q") {
      i([n, [o.x1, o.y1], [o.x, o.y]], 12);
      continue;
    }
    if (o.type === "C") {
      i([n, [o.x1, o.y1], [o.x2, o.y2], [o.x, o.y]], 16);
      continue;
    }
    o.type === "Z" && (t.push({ from: n, to: r }), n = r);
  }
  return t;
}
function sh(e, t) {
  let r = e;
  for (; r.length > 1; ) {
    let n = [];
    for (let i = 0; i < r.length - 1; i++)
      n.push([r[i][0] + (r[i + 1][0] - r[i][0]) * t, r[i][1] + (r[i + 1][1] - r[i][1]) * t]);
    r = n;
  }
  return r[0];
}
function ah(e, t) {
  if (!t)
    return [];
  let r = t.strokeWidth, n = t.underlineY - r * 0.25, i = t.underlineY + r * 2.5, o = oh(e);
  if (!o.length)
    return [];
  let s = i - n, a = Math.max(12, Math.ceil(s / 0.25)), u2 = s / a, l2 = n + u2 / 2, f = /* @__PURE__ */ new Set();
  for (let T = 0; T < a; T++) {
    let A = l2 + u2 * T, E = [];
    for (let _ of o) {
      let [R2, C] = _.from, [z, G] = _.to;
      if (C === G)
        continue;
      let ie = Math.min(C, G), te = Math.max(C, G);
      if (A < ie || A >= te)
        continue;
      let he = (A - C) / (G - C), de = R2 + (z - R2) * he;
      E.push(de);
    }
    if (E.length) {
      E.sort((_, R2) => _ - R2);
      for (let _ = 0; _ < E.length - 1; _ += 2) {
        let R2 = Math.min(E[_], E[_ + 1]), C = Math.max(E[_], E[_ + 1]), z = Math.floor(R2), G = Math.ceil(C);
        for (let ie = z; ie < G; ie++)
          f.add(ie);
      }
    }
  }
  if (!f.size)
    return [];
  let c2 = Array.from(f.values()).sort((T, A) => T - A), m2 = [], h2 = c2[0], g2 = c2[0];
  for (let T = 1; T < c2.length; T++) {
    let A = c2[T];
    A > g2 + 1 && (m2.push([h2, g2 + 1]), h2 = A), g2 = A;
  }
  m2.push([h2, g2 + 1]);
  let y = [], x2 = r * 0.6, w2 = m2[0][0], P2 = m2[m2.length - 1][1];
  for (let [T, A] of m2) {
    let E = Math.min(T, w2) - x2, _ = Math.max(A, P2) + x2;
    y.push({ x1: E, x2: _, y1: n, y2: i });
  }
  return y;
}
function uh(e, t, [r, n], [i, o]) {
  if (r !== i)
    return r ? !i || r === e ? -1 : i === e ? 1 : e === 400 && r === 500 || e === 500 && r === 400 ? -1 : e === 400 && i === 500 || e === 500 && i === 400 ? 1 : e < 400 ? r < e && i < e ? i - r : r < e ? -1 : i < e ? 1 : r - i : e < r && e < i ? r - i : e < r ? -1 : e < i ? 1 : i - r : 1;
  if (n !== o) {
    if (n === t)
      return -1;
    if (o === t)
      return 1;
  }
  return -1;
}
var Ao = /* @__PURE__ */ new WeakMap();
var rn = class {
  constructor(t) {
    this.fonts = /* @__PURE__ */ new Map();
    this.shapedRunCache = /* @__PURE__ */ new Map();
    this.addFonts(t);
  }
  get({ name: t, weight: r, style: n }) {
    if (!this.fonts.has(t))
      return null;
    r === "normal" && (r = 400), r === "bold" && (r = 700), typeof r == "string" && (r = Number.parseInt(r, 10));
    let i = [...this.fonts.get(t)], o = i[0];
    for (let s = 1; s < i.length; s++) {
      let [, a, u2] = o, [, l2, f] = i[s];
      uh(r, n, [a, u2], [l2, f]) > 0 && (o = i[s]);
    }
    return o[0];
  }
  addFonts(t) {
    t.length && this.fonts.size && this.shapedRunCache.clear();
    for (let r of t) {
      let { name: n, data: i, lang: o } = r;
      if (o && !il(o))
        throw new Error(`Invalid value for props \`lang\`: "${o}". The value must be one of the following: ${bi.join(", ")}.`);
      let s = o ?? fl3, a;
      if (Ao.has(i))
        a = Ao.get(i);
      else {
        let l2 = "buffer" in i ? i.buffer.slice(i.byteOffset, i.byteOffset + i.byteLength) : i;
        a = opentype_module_default.parse(l2, { lowMemory: true });
        let f = new Uint8Array(l2), c2 = f[0] === 119 && f[1] === 79 && f[2] === 70 && f[3] === 70;
        a._rawFontData = c2 ? ih(l2) : l2;
        let m2 = a.charToGlyphIndex;
        a.charToGlyphIndex = (h2) => {
          let g2 = m2.call(a, h2);
          return g2 === 0 && a._trackBrokenChars && a._trackBrokenChars.push(h2), g2;
        }, Ao.set(i, a);
      }
      this.defaultFont || (this.defaultFont = a);
      let u2 = `${n.toLowerCase()}_${s}`;
      this.fonts.has(u2) || this.fonts.set(u2, []), this.fonts.get(u2).push([a, r.weight, r.style]);
    }
  }
  getEngine(t = 16, r = "normal", { fontFamily: n = "sans-serif", fontWeight: i = 400, fontStyle: o = "normal" }, s) {
    if (!this.fonts.size)
      throw new Error("No fonts are loaded. At least one font is required to calculate the layout.");
    n = (Array.isArray(n) ? n : [n]).map((_) => _.toLowerCase());
    let a = [];
    n.forEach((_) => {
      let R2 = this.get({ name: _, weight: i, style: o });
      if (R2) {
        a.push(R2);
        return;
      }
      let C = this.get({ name: _ + "_unknown", weight: i, style: o });
      if (C) {
        a.push(C);
        return;
      }
    });
    let u2 = Array.from(this.fonts.keys()), l2 = [], f = [], c2 = [];
    for (let _ of u2)
      if (!n.includes(_))
        if (s) {
          let R2 = lh(_);
          R2 ? R2 === s ? l2.push(this.get({ name: _, weight: i, style: o })) : f.push(this.get({ name: _, weight: i, style: o })) : c2.push(this.get({ name: _, weight: i, style: o }));
        } else
          c2.push(this.get({ name: _, weight: i, style: o }));
    let m2 = /* @__PURE__ */ new Map(), h2 = (_, R2 = true) => {
      let C = [...a, ...c2, ...l2, ...R2 ? f : []];
      if (typeof _ > "u")
        return R2 ? C[C.length - 1] : void 0;
      let z = _.charCodeAt(0);
      if (m2.has(z))
        return m2.get(z);
      let G = C.find((ie, te) => !!ie.charToGlyphIndex(_) || R2 && te === C.length - 1);
      return G && m2.set(z, G), G;
    }, g2 = (_, R2 = false) => {
      var z, G;
      return ((R2 ? (G = (z = _.tables) == null ? void 0 : z.os2) == null ? void 0 : G.sTypoAscender : 0) || _.ascender) / _.unitsPerEm * t;
    }, y = (_, R2 = false) => {
      var z, G;
      return ((R2 ? (G = (z = _.tables) == null ? void 0 : z.os2) == null ? void 0 : G.sTypoDescender : 0) || _.descender) / _.unitsPerEm * t;
    }, x2 = (_, R2 = false) => {
      var C, z;
      if (typeof r == "string" && r === "normal") {
        let G = (R2 ? (z = (C = _.tables) == null ? void 0 : C.os2) == null ? void 0 : z.sTypoLineGap : 0) || 0;
        return g2(_, R2) - y(_, R2) + G / _.unitsPerEm * t;
      } else if (typeof r == "number")
        return t * r;
    }, w2 = (_) => h2(_, false), P2 = this.shapedRunCache, T = `${n.join(",")}|${i}|${o}|${s || ""}`, A = (_, R2) => {
      let C = `${T}\0${R2 || ""}\0${_}`, z = P2.get(C);
      if (z !== void 0)
        return P2.delete(C), P2.set(C, z), z;
      let G = R2 ? ll(R2) : {}, ie = nh(_, h2).map(([te, he]) => [te, he, ul(he, te, { features: G })]);
      if (P2.size >= th) {
        let te = P2.keys().next().value;
        te !== void 0 && P2.delete(te);
      }
      return P2.set(C, ie), ie;
    };
    return { has: (_) => {
      if (_ === `
`)
        return true;
      let R2 = w2(_);
      if (!R2)
        return false;
      for (let C of De(_, "grapheme"))
        if (!R2.charToGlyphIndex(C))
          return false;
      return true;
    }, baseline: (_, R2 = typeof _ > "u" ? a[0] : h2(_)) => {
      let C = g2(R2), z = y(R2), G = C - z;
      return C + (x2(R2) - G) / 2;
    }, height: (_, R2 = typeof _ > "u" ? a[0] : h2(_)) => x2(R2), measure: (_, R2) => this.measure(_, R2, A), getSVG: (_, R2, C) => this.getSVG(_, R2, A, C) };
  }
  patchFontFallbackResolver(t, r) {
    let n = [];
    t._trackBrokenChars = n;
    let i = t.stringToGlyphs;
    return t.stringToGlyphs = (o, ...s) => {
      let a = i.call(t, o, ...s);
      for (let u2 = 0; u2 < a.length; u2++)
        if (a[u2].unicode === void 0) {
          let l2 = n.shift(), f = r(l2);
          if (f !== t) {
            let c2 = f.charToGlyph(l2), m2 = t.unitsPerEm / f.unitsPerEm, h2 = new opentype_module_default.Path();
            h2.unitsPerEm = t.unitsPerEm, h2.commands = c2.path.commands.map((y) => {
              let x2 = { ...y };
              for (let w2 in x2)
                typeof x2[w2] == "number" && (x2[w2] *= m2);
              return x2;
            });
            let g2 = new opentype_module_default.Glyph({ ...c2, advanceWidth: c2.advanceWidth * m2, xMin: c2.xMin * m2, xMax: c2.xMax * m2, yMin: c2.yMin * m2, yMax: c2.yMax * m2, path: h2 });
            a[u2] = g2;
          }
        }
      return a;
    }, () => {
      t.stringToGlyphs = i, t._trackBrokenChars = void 0;
    };
  }
  measure(t, { fontSize: r, letterSpacing: n = 0, fontFeatureSettings: i }, o) {
    let s = o(t, i), a = 0, u2 = 0;
    for (let [, f, c2] of s) {
      let m2 = 0;
      for (let h2 of c2)
        m2 += h2.ax;
      a += m2 / f.unitsPerEm * r, u2 += c2.length;
    }
    let l2 = n * Math.max(0, u2 - 1);
    return a + l2;
  }
  getSVG(t, { fontSize: r, top: n, left: i, letterSpacing: o = 0, fontFeatureSettings: s }, a, u2) {
    if (r === 0)
      return { path: "", boxes: [] };
    let l2 = a(t.replace(/\n/g, ""), s), f = [], c2 = i, m2 = n, h2 = false, g2 = new opentype_module_default.Path();
    for (let [, y, x2] of l2) {
      let w2 = r / y.unitsPerEm;
      for (let P2 = 0; P2 < x2.length; P2++) {
        let T = x2[P2];
        h2 && (c2 += o);
        let A = y.glyphs.get(T.g);
        if (A && A.path) {
          let E = c2 + T.dx * w2, _ = m2 + T.dy * w2, R2 = A.getPath(E, _, r, {}), C = u2 ? ah(R2.commands, u2) : [];
          C.length && f.push(...C), g2.extend(R2);
        }
        c2 += T.ax * w2, h2 = true;
      }
    }
    return { path: g2.toPathData(1), boxes: f };
  }
};
function lh(e) {
  let t = e.split("_"), r = t[t.length - 1];
  return r === fl3 ? void 0 : r;
}
function Io({ width: e, height: t, content: r }) {
  return I("svg", { width: e, height: t, viewBox: `0 0 ${e} ${t}`, xmlns: "http://www.w3.org/2000/svg", "enable-background": r.includes('in="BackgroundImage"') ? "new" : void 0 }, r);
}
var Gc = od(wc());
var Xy = ["ios", "android", "windows", "macos", "web"];
function _c(e) {
  return Xy.includes(e);
}
var Ky = ["portrait", "landscape"];
function Tc(e) {
  return Ky.includes(e);
}
var Sc;
(function(e) {
  e.fontSize = "fontSize", e.lineHeight = "lineHeight";
})(Sc || (Sc = {}));
var ue;
(function(e) {
  e.rem = "rem", e.em = "em", e.px = "px", e.percent = "%", e.vw = "vw", e.vh = "vh", e.none = "<no-css-unit>";
})(ue || (ue = {}));
function na(e) {
  return typeof e == "string";
}
function ia(e) {
  return typeof e == "object";
}
var oa;
function k(e) {
  return { kind: "complete", style: e };
}
function We(e, t = {}) {
  let { fractions: r } = t;
  if (r && e.includes("/")) {
    let [o = "", s = ""] = e.split("/", 2), a = We(o), u2 = We(s);
    return !a || !u2 ? null : [a[0] / u2[0], u2[1]];
  }
  let n = parseFloat(e);
  if (Number.isNaN(n))
    return null;
  let i = e.match(/(([a-z]{2,}|%))$/);
  if (!i)
    return [n, ue.none];
  switch (i == null ? void 0 : i[1]) {
    case "rem":
      return [n, ue.rem];
    case "px":
      return [n, ue.px];
    case "em":
      return [n, ue.em];
    case "%":
      return [n, ue.percent];
    case "vw":
      return [n, ue.vw];
    case "vh":
      return [n, ue.vh];
    default:
      return null;
  }
}
function Xt(e, t, r = {}) {
  let n = Lt(t, r);
  return n === null ? null : k({ [e]: n });
}
function Di(e, t, r) {
  let n = Lt(t);
  return n !== null && (r[e] = n), r;
}
function kc(e, t) {
  let r = Lt(t);
  return r === null ? null : { [e]: r };
}
function Lt(e, t = {}) {
  if (e === void 0)
    return null;
  let r = We(String(e), t);
  return r ? ir(...r, t) : null;
}
function ir(e, t, r = {}) {
  let { isNegative: n, device: i } = r;
  switch (t) {
    case ue.rem:
      return e * 16 * (n ? -1 : 1);
    case ue.px:
      return e * (n ? -1 : 1);
    case ue.percent:
      return `${n ? "-" : ""}${e}%`;
    case ue.none:
      return e * (n ? -1 : 1);
    case ue.vw:
      return i != null && i.windowDimensions ? i.windowDimensions.width * (e / 100) : (tt("`vw` CSS unit requires configuration with `useDeviceContext()`"), null);
    case ue.vh:
      return i != null && i.windowDimensions ? i.windowDimensions.height * (e / 100) : (tt("`vh` CSS unit requires configuration with `useDeviceContext()`"), null);
    default:
      return null;
  }
}
function sa(e) {
  let t = We(e);
  if (!t)
    return null;
  let [r, n] = t;
  switch (n) {
    case ue.rem:
      return r * 16;
    case ue.px:
      return r;
    default:
      return null;
  }
}
var Qy = { t: "Top", tr: "TopRight", tl: "TopLeft", b: "Bottom", br: "BottomRight", bl: "BottomLeft", l: "Left", r: "Right", x: "Horizontal", y: "Vertical" };
function aa(e) {
  return Qy[e ?? ""] || "All";
}
function ua(e) {
  let t = "All";
  return [e.replace(/^-(t|b|r|l|tr|tl|br|bl)(-|$)/, (n, i) => (t = aa(i), "")), t];
}
function gr(e, t = {}) {
  if (e.includes("/")) {
    let r = Ec(e, { ...t, fractions: true });
    if (r)
      return r;
  }
  return e[0] === "[" && (e = e.slice(1, -1)), Ec(e, t);
}
function yt(e, t, r = {}) {
  let n = gr(t, r);
  return n === null ? null : k({ [e]: n });
}
function Ec(e, t = {}) {
  if (e === "px")
    return 1;
  let r = We(e, t);
  if (!r)
    return null;
  let [n, i] = r;
  return t.fractions && (i = ue.percent, n *= 100), i === ue.none && (n = n / 4, i = ue.rem), ir(n, i, t);
}
function Jy(...e) {
  console.warn(...e);
}
function Zy(...e) {
}
var tt = typeof process > "u" || ((oa = process == null ? void 0 : process.env) === null || oa === void 0 ? void 0 : oa.JEST_WORKER_ID) === void 0 ? Jy : Zy;
var ev = [["aspect-square", k({ aspectRatio: 1 })], ["aspect-video", k({ aspectRatio: 16 / 9 })], ["items-center", k({ alignItems: "center" })], ["items-start", k({ alignItems: "flex-start" })], ["items-end", k({ alignItems: "flex-end" })], ["items-baseline", k({ alignItems: "baseline" })], ["items-stretch", k({ alignItems: "stretch" })], ["justify-start", k({ justifyContent: "flex-start" })], ["justify-end", k({ justifyContent: "flex-end" })], ["justify-center", k({ justifyContent: "center" })], ["justify-between", k({ justifyContent: "space-between" })], ["justify-around", k({ justifyContent: "space-around" })], ["justify-evenly", k({ justifyContent: "space-evenly" })], ["content-start", k({ alignContent: "flex-start" })], ["content-end", k({ alignContent: "flex-end" })], ["content-between", k({ alignContent: "space-between" })], ["content-around", k({ alignContent: "space-around" })], ["content-stretch", k({ alignContent: "stretch" })], ["content-center", k({ alignContent: "center" })], ["self-auto", k({ alignSelf: "auto" })], ["self-start", k({ alignSelf: "flex-start" })], ["self-end", k({ alignSelf: "flex-end" })], ["self-center", k({ alignSelf: "center" })], ["self-stretch", k({ alignSelf: "stretch" })], ["self-baseline", k({ alignSelf: "baseline" })], ["direction-inherit", k({ direction: "inherit" })], ["direction-ltr", k({ direction: "ltr" })], ["direction-rtl", k({ direction: "rtl" })], ["hidden", k({ display: "none" })], ["flex", k({ display: "flex" })], ["flex-row", k({ flexDirection: "row" })], ["flex-row-reverse", k({ flexDirection: "row-reverse" })], ["flex-col", k({ flexDirection: "column" })], ["flex-col-reverse", k({ flexDirection: "column-reverse" })], ["flex-wrap", k({ flexWrap: "wrap" })], ["flex-wrap-reverse", k({ flexWrap: "wrap-reverse" })], ["flex-nowrap", k({ flexWrap: "nowrap" })], ["flex-auto", k({ flexGrow: 1, flexShrink: 1, flexBasis: "auto" })], ["flex-initial", k({ flexGrow: 0, flexShrink: 1, flexBasis: "auto" })], ["flex-none", k({ flexGrow: 0, flexShrink: 0, flexBasis: "auto" })], ["overflow-hidden", k({ overflow: "hidden" })], ["overflow-visible", k({ overflow: "visible" })], ["overflow-scroll", k({ overflow: "scroll" })], ["absolute", k({ position: "absolute" })], ["relative", k({ position: "relative" })], ["italic", k({ fontStyle: "italic" })], ["not-italic", k({ fontStyle: "normal" })], ["oldstyle-nums", Mn("oldstyle-nums")], ["small-caps", Mn("small-caps")], ["lining-nums", Mn("lining-nums")], ["tabular-nums", Mn("tabular-nums")], ["proportional-nums", Mn("proportional-nums")], ["font-thin", k({ fontWeight: "100" })], ["font-100", k({ fontWeight: "100" })], ["font-extralight", k({ fontWeight: "200" })], ["font-200", k({ fontWeight: "200" })], ["font-light", k({ fontWeight: "300" })], ["font-300", k({ fontWeight: "300" })], ["font-normal", k({ fontWeight: "normal" })], ["font-400", k({ fontWeight: "400" })], ["font-medium", k({ fontWeight: "500" })], ["font-500", k({ fontWeight: "500" })], ["font-semibold", k({ fontWeight: "600" })], ["font-600", k({ fontWeight: "600" })], ["font-bold", k({ fontWeight: "bold" })], ["font-700", k({ fontWeight: "700" })], ["font-extrabold", k({ fontWeight: "800" })], ["font-800", k({ fontWeight: "800" })], ["font-black", k({ fontWeight: "900" })], ["font-900", k({ fontWeight: "900" })], ["include-font-padding", k({ includeFontPadding: true })], ["remove-font-padding", k({ includeFontPadding: false })], ["max-w-none", k({ maxWidth: "99999%" })], ["text-left", k({ textAlign: "left" })], ["text-center", k({ textAlign: "center" })], ["text-right", k({ textAlign: "right" })], ["text-justify", k({ textAlign: "justify" })], ["text-auto", k({ textAlign: "auto" })], ["underline", k({ textDecorationLine: "underline" })], ["line-through", k({ textDecorationLine: "line-through" })], ["no-underline", k({ textDecorationLine: "none" })], ["uppercase", k({ textTransform: "uppercase" })], ["lowercase", k({ textTransform: "lowercase" })], ["capitalize", k({ textTransform: "capitalize" })], ["normal-case", k({ textTransform: "none" })], ["w-auto", k({ width: "auto" })], ["h-auto", k({ height: "auto" })], ["shadow-sm", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowRadius: 1, shadowOpacity: 0.025, elevation: 1 })], ["shadow", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowRadius: 1, shadowOpacity: 0.075, elevation: 2 })], ["shadow-md", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowRadius: 3, shadowOpacity: 0.125, elevation: 3 })], ["shadow-lg", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8, elevation: 8 })], ["shadow-xl", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowOpacity: 0.19, shadowRadius: 20, elevation: 12 })], ["shadow-2xl", k({ shadowOffset: { width: 1, height: 1 }, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 30, elevation: 16 })], ["shadow-none", k({ shadowOffset: { width: 0, height: 0 }, shadowColor: "#000", shadowRadius: 0, shadowOpacity: 0, elevation: 0 })]];
var la = ev;
function Mn(e) {
  return { kind: "dependent", complete(t) {
    (!t.fontVariant || !Array.isArray(t.fontVariant)) && (t.fontVariant = []), t.fontVariant.push(e);
  } };
}
var Fn = class {
  constructor(t) {
    this.ir = new Map(la), this.styles = /* @__PURE__ */ new Map(), this.prefixes = /* @__PURE__ */ new Map(), this.ir = new Map([...la, ...t ?? []]);
  }
  getStyle(t) {
    return this.styles.get(t);
  }
  setStyle(t, r) {
    this.styles.set(t, r);
  }
  getIr(t) {
    return this.ir.get(t);
  }
  setIr(t, r) {
    this.ir.set(t, r);
  }
  getPrefixMatch(t) {
    return this.prefixes.get(t);
  }
  setPrefixMatch(t, r) {
    this.prefixes.set(t, r);
  }
};
function fa(e, t, r = {}) {
  let n = t == null ? void 0 : t[e];
  if (!n)
    return yt("fontSize", e, r);
  if (typeof n == "string")
    return Xt("fontSize", n);
  let i = {}, [o, s] = n, a = kc("fontSize", o);
  if (a && (i = a), typeof s == "string")
    return k(Di("lineHeight", Pc(s, i), i));
  let { lineHeight: u2, letterSpacing: l2 } = s;
  return u2 && Di("lineHeight", Pc(u2, i), i), l2 && Di("letterSpacing", l2, i), k(i);
}
function Pc(e, t) {
  let r = We(e);
  if (r) {
    let [n, i] = r;
    if ((i === ue.none || i === ue.em) && typeof t.fontSize == "number")
      return t.fontSize * n;
  }
  return e;
}
function ca(e, t) {
  var r;
  let n = (r = t == null ? void 0 : t[e]) !== null && r !== void 0 ? r : e.startsWith("[") ? e.slice(1, -1) : e, i = We(n);
  if (!i)
    return null;
  let [o, s] = i;
  if (s === ue.none)
    return { kind: "dependent", complete(u2) {
      if (typeof u2.fontSize != "number")
        return "relative line-height utilities require that font-size be set";
      u2.lineHeight = u2.fontSize * o;
    } };
  let a = ir(o, s);
  return a !== null ? k({ lineHeight: a }) : null;
}
function da(e, t, r, n, i) {
  let o = "";
  if (n[0] === "[")
    o = n.slice(1, -1);
  else {
    let l2 = i == null ? void 0 : i[n];
    if (l2)
      o = l2;
    else {
      let f = gr(n);
      return f && typeof f == "number" ? Oc(f, ue.px, t, e) : null;
    }
  }
  if (o === "auto")
    return Rc(t, e, "auto");
  let s = We(o);
  if (!s)
    return null;
  let [a, u2] = s;
  return r && (a = -a), Oc(a, u2, t, e);
}
function Oc(e, t, r, n) {
  let i = ir(e, t);
  return i === null ? null : Rc(r, n, i);
}
function Rc(e, t, r) {
  switch (e) {
    case "All":
      return { kind: "complete", style: { [`${t}Top`]: r, [`${t}Right`]: r, [`${t}Bottom`]: r, [`${t}Left`]: r } };
    case "Bottom":
    case "Top":
    case "Left":
    case "Right":
      return { kind: "complete", style: { [`${t}${e}`]: r } };
    case "Vertical":
      return { kind: "complete", style: { [`${t}Top`]: r, [`${t}Bottom`]: r } };
    case "Horizontal":
      return { kind: "complete", style: { [`${t}Left`]: r, [`${t}Right`]: r } };
    default:
      return null;
  }
}
function pa(e) {
  if (!e)
    return {};
  let t = Object.entries(e).reduce((i, [o, s]) => {
    let a = [0, 1 / 0, 0], u2 = typeof s == "string" ? { min: s } : s, l2 = u2.min ? sa(u2.min) : 0;
    l2 === null ? tt(`invalid screen config value: ${o}->min: ${u2.min}`) : a[0] = l2;
    let f = u2.max ? sa(u2.max) : 1 / 0;
    return f === null ? tt(`invalid screen config value: ${o}->max: ${u2.max}`) : a[1] = f, i[o] = a, i;
  }, {}), r = Object.values(t);
  r.sort((i, o) => {
    let [s, a] = i, [u2, l2] = o;
    return a === 1 / 0 || l2 === 1 / 0 ? s - u2 : a - l2;
  });
  let n = 0;
  return r.forEach((i) => i[2] = n++), t;
}
function ha(e, t) {
  let r = t == null ? void 0 : t[e];
  if (!r)
    return null;
  if (typeof r == "string")
    return k({ fontFamily: r });
  let n = r[0];
  return n ? k({ fontFamily: n }) : null;
}
function br(e, t, r) {
  if (!r)
    return null;
  let n;
  t.includes("/") && ([t = "", n] = t.split("/", 2));
  let i = "";
  if (t.startsWith("[#") || t.startsWith("[rgb") ? i = t.slice(1, -1) : i = Cc(t, r), !i)
    return null;
  if (n) {
    let o = Number(n);
    if (!Number.isNaN(o))
      return i = Ac(i, o / 100), k({ [Wi[e].color]: i });
  }
  return { kind: "dependent", complete(o) {
    let s = Wi[e].opacity, a = o[s];
    typeof a == "number" && (i = Ac(i, a)), o[Wi[e].color] = i;
  } };
}
function Nn(e, t) {
  let r = parseInt(t, 10);
  if (Number.isNaN(r))
    return null;
  let n = r / 100;
  return { kind: "complete", style: { [Wi[e].opacity]: n } };
}
function Ac(e, t) {
  return e.startsWith("#") ? e = tv(e) : e.startsWith("rgb(") && (e = e.replace(/^rgb\(/, "rgba(").replace(/\)$/, ", 1)")), e.replace(/, ?\d*\.?(\d+)\)$/, `, ${t})`);
}
function Ic(e) {
  for (let t in e)
    t.startsWith("__opacity_") && delete e[t];
}
var Wi = { bg: { opacity: "__opacity_bg", color: "backgroundColor" }, text: { opacity: "__opacity_text", color: "color" }, border: { opacity: "__opacity_border", color: "borderColor" }, borderTop: { opacity: "__opacity_border", color: "borderTopColor" }, borderBottom: { opacity: "__opacity_border", color: "borderBottomColor" }, borderLeft: { opacity: "__opacity_border", color: "borderLeftColor" }, borderRight: { opacity: "__opacity_border", color: "borderRightColor" }, shadow: { opacity: "__opacity_shadow", color: "shadowColor" }, tint: { opacity: "__opacity_tint", color: "tintColor" } };
function tv(e) {
  let t = e;
  e = e.replace(rv, (s, a, u2, l2) => a + a + u2 + u2 + l2 + l2);
  let r = nv.exec(e);
  if (!r)
    return tt(`invalid config hex color value: ${t}`), "rgba(0, 0, 0, 1)";
  let n = parseInt(r[1], 16), i = parseInt(r[2], 16), o = parseInt(r[3], 16);
  return `rgba(${n}, ${i}, ${o}, 1)`;
}
function Cc(e, t) {
  let r = t[e];
  if (na(r))
    return r;
  if (ia(r) && na(r.DEFAULT))
    return r.DEFAULT;
  let [n = "", ...i] = e.split("-");
  for (; n !== e; ) {
    let o = t[n];
    if (ia(o))
      return Cc(i.join("-"), o);
    if (i.length === 0)
      return "";
    n = `${n}-${i.shift()}`;
  }
  return "";
}
var rv = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
var nv = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
function Mc(e, t) {
  let [r, n] = ua(e);
  if (r.match(/^(-?(\d)+)?$/))
    return iv(r, n, t == null ? void 0 : t.borderWidth);
  if (r = r.replace(/^-/, ""), ["dashed", "solid", "dotted"].includes(r))
    return k({ borderStyle: r });
  let o = "border";
  switch (n) {
    case "Bottom":
      o = "borderBottom";
      break;
    case "Top":
      o = "borderTop";
      break;
    case "Left":
      o = "borderLeft";
      break;
    case "Right":
      o = "borderRight";
      break;
  }
  let s = br(o, r, t == null ? void 0 : t.borderColor);
  if (s)
    return s;
  let a = `border${n === "All" ? "" : n}Width`;
  r = r.replace(/^-/, "");
  let u2 = r.slice(1, -1), l2 = yt(a, u2);
  return typeof (l2 == null ? void 0 : l2.style[a]) != "number" ? null : l2;
}
function iv(e, t, r) {
  if (!r)
    return null;
  e = e.replace(/^-/, "");
  let i = r[e === "" ? "DEFAULT" : e];
  if (i === void 0)
    return null;
  let o = `border${t === "All" ? "" : t}Width`;
  return Xt(o, i);
}
function Fc(e, t) {
  if (!t)
    return null;
  let [r, n] = ua(e);
  r = r.replace(/^-/, ""), r === "" && (r = "DEFAULT");
  let i = `border${n === "All" ? "" : n}Radius`, o = t[r];
  if (o)
    return Lc(Xt(i, o));
  let s = yt(i, r);
  return typeof (s == null ? void 0 : s.style[i]) != "number" ? null : Lc(s);
}
function Lc(e) {
  if ((e == null ? void 0 : e.kind) !== "complete")
    return e;
  let t = e.style.borderTopRadius;
  t !== void 0 && (e.style.borderTopLeftRadius = t, e.style.borderTopRightRadius = t, delete e.style.borderTopRadius);
  let r = e.style.borderBottomRadius;
  r !== void 0 && (e.style.borderBottomLeftRadius = r, e.style.borderBottomRightRadius = r, delete e.style.borderBottomRadius);
  let n = e.style.borderLeftRadius;
  n !== void 0 && (e.style.borderBottomLeftRadius = n, e.style.borderTopLeftRadius = n, delete e.style.borderLeftRadius);
  let i = e.style.borderRightRadius;
  return i !== void 0 && (e.style.borderBottomRightRadius = i, e.style.borderTopRightRadius = i, delete e.style.borderRightRadius), e;
}
function Fr(e, t, r, n) {
  let i = null;
  e === "inset" && (t = t.replace(/^(x|y)-/, (a, u2) => (i = u2 === "x" ? "x" : "y", "")));
  let o = n == null ? void 0 : n[t];
  if (o) {
    let a = Lt(o, { isNegative: r });
    if (a !== null)
      return Nc(e, i, a);
  }
  let s = gr(t, { isNegative: r });
  return s !== null ? Nc(e, i, s) : null;
}
function Nc(e, t, r) {
  if (e !== "inset")
    return k({ [e]: r });
  switch (t) {
    case null:
      return k({ top: r, left: r, right: r, bottom: r });
    case "y":
      return k({ top: r, bottom: r });
    case "x":
      return k({ left: r, right: r });
  }
}
function Dn(e, t, r) {
  var n;
  t = t.replace(/^-/, "");
  let i = t === "" ? "DEFAULT" : t, o = Number((n = r == null ? void 0 : r[i]) !== null && n !== void 0 ? n : t);
  return Number.isNaN(o) ? null : k({ [`flex${e}`]: o });
}
function Dc(e, t) {
  var r, n;
  if (e = (t == null ? void 0 : t[e]) || e, ["min-content", "revert", "unset"].includes(e))
    return null;
  if (e.match(/^\d+(\.\d+)?$/))
    return k({ flexGrow: Number(e), flexBasis: "0%" });
  let i = e.match(/^(\d+)\s+(\d+)$/);
  if (i)
    return k({ flexGrow: Number(i[1]), flexShrink: Number(i[2]) });
  if (i = e.match(/^(\d+)\s+([^ ]+)$/), i) {
    let o = Lt((r = i[2]) !== null && r !== void 0 ? r : "");
    return o ? k({ flexGrow: Number(i[1]), flexBasis: o }) : null;
  }
  if (i = e.match(/^(\d+)\s+(\d+)\s+(.+)$/), i) {
    let o = Lt((n = i[3]) !== null && n !== void 0 ? n : "");
    return o ? k({ flexGrow: Number(i[1]), flexShrink: Number(i[2]), flexBasis: o }) : null;
  }
  return null;
}
function ma(e, t, r = {}, n) {
  let i = n == null ? void 0 : n[t];
  return i !== void 0 ? Xt(e, i, r) : yt(e, t, r);
}
function Wn(e, t, r = {}, n) {
  let i = Lt(n == null ? void 0 : n[t], r);
  return i ? k({ [e]: i }) : (t === "screen" && (t = e.includes("Width") ? "100vw" : "100vh"), yt(e, t, r));
}
function Wc(e, t, r) {
  let n = r == null ? void 0 : r[e];
  if (n) {
    let i = We(n, { isNegative: t });
    if (!i)
      return null;
    let [o, s] = i;
    if (s === ue.em)
      return ov(o);
    if (s === ue.percent)
      return tt("percentage-based letter-spacing configuration currently unsupported, switch to `em`s, or open an issue if you'd like to see support added."), null;
    let a = ir(o, s, { isNegative: t });
    return a !== null ? k({ letterSpacing: a }) : null;
  }
  return yt("letterSpacing", e, { isNegative: t });
}
function ov(e) {
  return { kind: "dependent", complete(t) {
    let r = t.fontSize;
    if (typeof r != "number" || Number.isNaN(r))
      return "tracking-X relative letter spacing classes require font-size to be set";
    t.letterSpacing = Math.round((e * r + Number.EPSILON) * 100) / 100;
  } };
}
function $c(e, t) {
  let r = t == null ? void 0 : t[e];
  if (r) {
    let i = We(String(r));
    if (i)
      return k({ opacity: i[0] });
  }
  let n = We(e);
  return n ? k({ opacity: n[0] / 100 }) : null;
}
function Bc(e) {
  let t = parseInt(e, 10);
  return Number.isNaN(t) ? null : { kind: "complete", style: { shadowOpacity: t / 100 } };
}
function Uc(e) {
  if (e.includes("/")) {
    let [r = "", n = ""] = e.split("/", 2), i = ga(r), o = ga(n);
    return i === null || o === null ? null : { kind: "complete", style: { shadowOffset: { width: i, height: o } } };
  }
  let t = ga(e);
  return t === null ? null : { kind: "complete", style: { shadowOffset: { width: t, height: t } } };
}
function ga(e) {
  let t = gr(e);
  return typeof t == "number" ? t : null;
}
var Nr = class {
  constructor(t, r = {}, n, i, o) {
    var s, a, u2, l2, f, c2;
    this.config = r, this.cache = n, this.position = 0, this.isNull = false, this.isNegative = false, this.context = {}, this.context.device = i;
    let m2 = t.trim().split(":"), h2 = [];
    m2.length === 1 ? this.string = t : (this.string = (s = m2.pop()) !== null && s !== void 0 ? s : "", h2 = m2), this.char = this.string[0];
    let g2 = pa((a = this.config.theme) === null || a === void 0 ? void 0 : a.screens);
    for (let y of h2)
      if (g2[y]) {
        let x2 = (u2 = g2[y]) === null || u2 === void 0 ? void 0 : u2[2];
        x2 !== void 0 && (this.order = ((l2 = this.order) !== null && l2 !== void 0 ? l2 : 0) + x2);
        let w2 = (f = i.windowDimensions) === null || f === void 0 ? void 0 : f.width;
        if (w2) {
          let [P2, T] = (c2 = g2[y]) !== null && c2 !== void 0 ? c2 : [0, 0];
          (w2 <= P2 || w2 > T) && (this.isNull = true);
        } else
          this.isNull = true;
      } else
        _c(y) ? this.isNull = y !== o : Tc(y) ? i.windowDimensions ? (i.windowDimensions.width > i.windowDimensions.height ? "landscape" : "portrait") !== y ? this.isNull = true : this.incrementOrder() : this.isNull = true : y === "retina" ? i.pixelDensity === 2 ? this.incrementOrder() : this.isNull = true : y === "dark" ? i.colorScheme !== "dark" ? this.isNull = true : this.incrementOrder() : this.handlePossibleArbitraryBreakpointPrefix(y) || (this.isNull = true);
  }
  parse() {
    if (this.isNull)
      return { kind: "null" };
    let t = this.cache.getIr(this.rest);
    if (t)
      return t;
    this.parseIsNegative();
    let r = this.parseUtility();
    return r ? this.order !== void 0 ? { kind: "ordered", order: this.order, styleIr: r } : r : { kind: "null" };
  }
  parseUtility() {
    var t, r, n, i, o;
    let s = this.config.theme, a = null;
    switch (this.char) {
      case "m":
      case "p": {
        let u2 = this.peekSlice(1, 3).match(/^(t|b|r|l|x|y)?-/);
        if (u2) {
          let l2 = this.char === "m" ? "margin" : "padding";
          this.advance(((r = (t = u2[0]) === null || t === void 0 ? void 0 : t.length) !== null && r !== void 0 ? r : 0) + 1);
          let f = aa(u2[1]), c2 = da(l2, f, this.isNegative, this.rest, (n = this.config.theme) === null || n === void 0 ? void 0 : n[l2]);
          if (c2)
            return c2;
        }
      }
    }
    if (this.consumePeeked("h-") && (a = ma("height", this.rest, this.context, s == null ? void 0 : s.height), a) || this.consumePeeked("w-") && (a = ma("width", this.rest, this.context, s == null ? void 0 : s.width), a) || this.consumePeeked("min-w-") && (a = Wn("minWidth", this.rest, this.context, s == null ? void 0 : s.minWidth), a) || this.consumePeeked("min-h-") && (a = Wn("minHeight", this.rest, this.context, s == null ? void 0 : s.minHeight), a) || this.consumePeeked("max-w-") && (a = Wn("maxWidth", this.rest, this.context, s == null ? void 0 : s.maxWidth), a) || this.consumePeeked("max-h-") && (a = Wn("maxHeight", this.rest, this.context, s == null ? void 0 : s.maxHeight), a) || this.consumePeeked("leading-") && (a = ca(this.rest, s == null ? void 0 : s.lineHeight), a) || this.consumePeeked("text-") && (a = fa(this.rest, s == null ? void 0 : s.fontSize, this.context), a || (a = br("text", this.rest, s == null ? void 0 : s.textColor), a) || this.consumePeeked("opacity-") && (a = Nn("text", this.rest), a)) || this.consumePeeked("font-") && (a = ha(this.rest, s == null ? void 0 : s.fontFamily), a) || this.consumePeeked("aspect-") && (this.consumePeeked("ratio-") && tt("`aspect-ratio-{ratio}` is deprecated, use `aspect-{ratio}` instead"), a = Xt("aspectRatio", this.rest, { fractions: true }), a) || this.consumePeeked("tint-") && (a = br("tint", this.rest, s == null ? void 0 : s.colors), a) || this.consumePeeked("bg-") && (a = br("bg", this.rest, s == null ? void 0 : s.backgroundColor), a || this.consumePeeked("opacity-") && (a = Nn("bg", this.rest), a)) || this.consumePeeked("border") && (a = Mc(this.rest, s), a || this.consumePeeked("-opacity-") && (a = Nn("border", this.rest), a)) || this.consumePeeked("rounded") && (a = Fc(this.rest, s == null ? void 0 : s.borderRadius), a) || this.consumePeeked("bottom-") && (a = Fr("bottom", this.rest, this.isNegative, s == null ? void 0 : s.inset), a) || this.consumePeeked("top-") && (a = Fr("top", this.rest, this.isNegative, s == null ? void 0 : s.inset), a) || this.consumePeeked("left-") && (a = Fr("left", this.rest, this.isNegative, s == null ? void 0 : s.inset), a) || this.consumePeeked("right-") && (a = Fr("right", this.rest, this.isNegative, s == null ? void 0 : s.inset), a) || this.consumePeeked("inset-") && (a = Fr("inset", this.rest, this.isNegative, s == null ? void 0 : s.inset), a) || this.consumePeeked("flex-") && (this.consumePeeked("grow") ? a = Dn("Grow", this.rest, s == null ? void 0 : s.flexGrow) : this.consumePeeked("shrink") ? a = Dn("Shrink", this.rest, s == null ? void 0 : s.flexShrink) : a = Dc(this.rest, s == null ? void 0 : s.flex), a) || this.consumePeeked("grow") && (a = Dn("Grow", this.rest, s == null ? void 0 : s.flexGrow), a) || this.consumePeeked("shrink") && (a = Dn("Shrink", this.rest, s == null ? void 0 : s.flexShrink), a) || this.consumePeeked("shadow-color-opacity-") && (a = Nn("shadow", this.rest), a) || this.consumePeeked("shadow-opacity-") && (a = Bc(this.rest), a) || this.consumePeeked("shadow-offset-") && (a = Uc(this.rest), a) || this.consumePeeked("shadow-radius-") && (a = yt("shadowRadius", this.rest), a) || this.consumePeeked("shadow-") && (a = br("shadow", this.rest, s == null ? void 0 : s.colors), a))
      return a;
    if (this.consumePeeked("elevation-")) {
      let u2 = parseInt(this.rest, 10);
      if (!Number.isNaN(u2))
        return k({ elevation: u2 });
    }
    if (this.consumePeeked("opacity-") && (a = $c(this.rest, s == null ? void 0 : s.opacity), a) || this.consumePeeked("tracking-") && (a = Wc(this.rest, this.isNegative, s == null ? void 0 : s.letterSpacing), a))
      return a;
    if (this.consumePeeked("z-")) {
      let u2 = Number((o = (i = s == null ? void 0 : s.zIndex) === null || i === void 0 ? void 0 : i[this.rest]) !== null && o !== void 0 ? o : this.rest);
      if (!Number.isNaN(u2))
        return k({ zIndex: u2 });
    }
    return tt(`\`${this.rest}\` unknown or invalid utility`), null;
  }
  handlePossibleArbitraryBreakpointPrefix(t) {
    var r;
    if (t[0] !== "m")
      return false;
    let n = t.match(/^(min|max)-(w|h)-\[([^\]]+)\]$/);
    if (!n)
      return false;
    if (!(!((r = this.context.device) === null || r === void 0) && r.windowDimensions))
      return this.isNull = true, true;
    let i = this.context.device.windowDimensions, [, o = "", s = "", a = ""] = n, u2 = s === "w" ? i.width : i.height, l2 = We(a, this.context);
    if (l2 === null)
      return this.isNull = true, true;
    let [f, c2] = l2;
    return c2 !== "px" && (this.isNull = true), (o === "min" ? u2 >= f : u2 <= f) ? this.incrementOrder() : this.isNull = true, true;
  }
  advance(t = 1) {
    this.position += t, this.char = this.string[this.position];
  }
  get rest() {
    return this.peekSlice(0, this.string.length);
  }
  peekSlice(t, r) {
    return this.string.slice(this.position + t, this.position + r);
  }
  consumePeeked(t) {
    return this.peekSlice(0, t.length) === t ? (this.advance(t.length), true) : false;
  }
  parseIsNegative() {
    this.char === "-" && (this.advance(), this.isNegative = true, this.context.isNegative = true);
  }
  incrementOrder() {
    var t;
    this.order = ((t = this.order) !== null && t !== void 0 ? t : 0) + 1;
  }
};
function qc(e) {
  let t = [], r = null;
  return e.forEach((n) => {
    if (typeof n == "string")
      t = [...t, ...ba(n)];
    else if (Array.isArray(n))
      t = [...t, ...n.flatMap(ba)];
    else if (typeof n == "object" && n !== null)
      for (let [i, o] of Object.entries(n))
        typeof o == "boolean" ? t = [...t, ...o ? ba(i) : []] : r ? r[i] = o : r = { [i]: o };
  }), [t.filter(Boolean).filter(sv), r];
}
function ba(e) {
  return e.trim().split(/\s+/);
}
function sv(e, t, r) {
  return r.indexOf(e) === t;
}
function zc(e) {
  var t;
  return (t = e == null ? void 0 : e.reduce((r, n) => ({ ...r, ...av(n.handler) }), {})) !== null && t !== void 0 ? t : {};
}
function av(e) {
  let t = {};
  return e({ addUtilities: (r) => {
    t = r;
  }, ...uv }), t;
}
function Mt(e) {
  throw new Error(`tailwindcss plugin function argument object prop "${e}" not implemented`);
}
var uv = { addComponents: Mt, addBase: Mt, addVariant: Mt, e: Mt, prefix: Mt, theme: Mt, variants: Mt, config: Mt, corePlugins: Mt, matchUtilities: Mt, postcss: null };
function jc(e, t) {
  let r = (0, Gc.default)(lv(e)), n = {}, i = zc(r.plugins), o = {}, s = Object.entries(i).map(([g2, y]) => typeof y == "string" ? (o[g2] = y, [g2, { kind: "null" }]) : [g2, k(y)]).filter(([, g2]) => g2.kind !== "null");
  function a() {
    return [n.windowDimensions ? `w${n.windowDimensions.width}` : false, n.windowDimensions ? `h${n.windowDimensions.height}` : false, n.fontScale ? `fs${n.fontScale}` : false, n.colorScheme === "dark" ? "dark" : false, n.pixelDensity === 2 ? "retina" : false].filter(Boolean).join("--") || "default";
  }
  let u2 = a(), l2 = {};
  function f() {
    let g2 = l2[u2];
    if (g2)
      return g2;
    let y = new Fn(s);
    return l2[u2] = y, y;
  }
  function c2(...g2) {
    let y = f(), x2 = {}, w2 = [], P2 = [], [T, A] = qc(g2), E = T.join(" "), _ = y.getStyle(E);
    if (_)
      return { ..._, ...A || {} };
    for (let R2 of T) {
      let C = y.getIr(R2);
      if (!C && R2 in o) {
        let G = c2(o[R2]);
        y.setIr(R2, k(G)), x2 = { ...x2, ...G };
        continue;
      }
      switch (C = new Nr(R2, r, y, n, t).parse(), C.kind) {
        case "complete":
          x2 = { ...x2, ...C.style }, y.setIr(R2, C);
          break;
        case "dependent":
          w2.push(C);
          break;
        case "ordered":
          P2.push(C);
          break;
        case "null":
          y.setIr(R2, C);
          break;
      }
    }
    if (P2.length > 0) {
      P2.sort((R2, C) => R2.order - C.order);
      for (let R2 of P2)
        switch (R2.styleIr.kind) {
          case "complete":
            x2 = { ...x2, ...R2.styleIr.style };
            break;
          case "dependent":
            w2.push(R2.styleIr);
            break;
        }
    }
    if (w2.length > 0) {
      for (let R2 of w2) {
        let C = R2.complete(x2);
        C && tt(C);
      }
      Ic(x2);
    }
    return E !== "" && y.setStyle(E, x2), A && (x2 = { ...x2, ...A }), x2;
  }
  function m2(g2) {
    let y = c2(g2.split(/\s+/g).map((x2) => x2.replace(/^(bg|text|border)-/, "")).map((x2) => `bg-${x2}`).join(" "));
    return typeof y.backgroundColor == "string" ? y.backgroundColor : void 0;
  }
  let h2 = (g2, ...y) => {
    let x2 = "";
    return g2.forEach((w2, P2) => {
      var T;
      x2 += w2 + ((T = y[P2]) !== null && T !== void 0 ? T : "");
    }), c2(x2);
  };
  return h2.style = c2, h2.color = m2, h2.prefixMatch = (...g2) => {
    let y = g2.sort().join(":"), x2 = f(), w2 = x2.getPrefixMatch(y);
    if (w2 !== void 0)
      return w2;
    let A = new Nr(`${y}:flex`, r, x2, n, t).parse().kind !== "null";
    return x2.setPrefixMatch(y, A), A;
  }, h2.setWindowDimensions = (g2) => {
    n.windowDimensions = g2, u2 = a();
  }, h2.setFontScale = (g2) => {
    n.fontScale = g2, u2 = a();
  }, h2.setPixelDensity = (g2) => {
    n.pixelDensity = g2, u2 = a();
  }, h2.setColorScheme = (g2) => {
    n.colorScheme = g2, u2 = a();
  }, h2;
}
function lv(e) {
  return { ...e, content: ["_no_warnings_please"] };
}
var cv = { handler: ({ addUtilities: e }) => {
  e({ "shadow-sm": { boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)" }, shadow: { boxShadow: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)" }, "shadow-md": { boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)" }, "shadow-lg": { boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)" }, "shadow-xl": { boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)" }, "shadow-2xl": { boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)" }, "shadow-inner": { boxShadow: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)" }, "shadow-none": { boxShadow: "0 0 #0000" } });
} };
function dv(e) {
  return jc({ ...e, plugins: [...(e == null ? void 0 : e.plugins) ?? [], cv] }, "web");
}
var $i;
function ya({ width: e, height: t, config: r }) {
  return $i || ($i = dv(r)), $i.setWindowDimensions({ width: +e, height: +t }), $i;
}
var va = /* @__PURE__ */ new WeakMap();
var Vc = /* @__PURE__ */ new WeakMap();
var pv = 0;
var hv = 8;
var $n = /* @__PURE__ */ new Map();
function mv(e) {
  let t = "";
  for (let r of e) {
    let n = Vc.get(r.data);
    n === void 0 && (n = ++pv, Vc.set(r.data, n)), t += `${n}:${r.name}:${r.weight ?? ""}:${r.style ?? ""}:${r.lang ?? ""};`;
  }
  return t;
}
function gv(e) {
  if (va.has(e))
    return va.get(e);
  let t = mv(e), r = $n.get(t);
  if (!r) {
    if (r = new rn(e), $n.size >= hv) {
      let n = $n.keys().next().value;
      n !== void 0 && $n.delete(n);
    }
    $n.set(t, r);
  }
  return va.set(e, r), r;
}
async function Yc(e, t) {
  let [r] = await Promise.all([Qt(), al()]);
  if (!r || !r.Node)
    throw new Error("Satori is not initialized: expect `yoga` to be loaded, got " + r);
  t.fonts = t.fonts || [];
  let n = gv(t.fonts), i = "width" in t ? t.width : void 0, o = "height" in t ? t.height : void 0, s = bv(r, t.pointScaleFactor);
  i && s.setWidth(i), o && s.setHeight(o), s.setFlexDirection(r.FLEX_DIRECTION_ROW), s.setFlexWrap(r.WRAP_WRAP), s.setAlignContent(r.ALIGN_AUTO), s.setAlignItems(r.ALIGN_FLEX_START), s.setJustifyContent(r.JUSTIFY_FLEX_START), s.setOverflow(r.OVERFLOW_HIDDEN);
  let a = Object.assign(/* @__PURE__ */ Object.create(null), t.graphemeImages), u2 = /* @__PURE__ */ new Set();
  At.clear(), Hr.clear(), await mu(e);
  let l2 = tn(e, { id: "id", parentStyle: {}, inheritedStyle: { fontSize: 16, fontWeight: "normal", fontFamily: "serif", fontStyle: "normal", lineHeight: "normal", color: "black", opacity: 1, whiteSpace: "normal", _viewportWidth: i, _viewportHeight: o }, parent: s, font: n, embedFont: t.embedFont, debug: t.debug, graphemeImages: a, canLoadAdditionalAssets: !!t.loadAdditionalAsset, onNodeDetected: t.onNodeDetected, getTwStyles: (g2, y) => {
    let w2 = { ...ya({ width: i, height: o, config: t.tailwindConfig })([g2]) };
    return typeof w2.lineHeight == "number" && (w2.lineHeight = w2.lineHeight / (+w2.fontSize || y.fontSize || 16)), w2.shadowColor && w2.boxShadow && (w2.boxShadow = w2.boxShadow.replace(/rgba?\([^)]+\)/, w2.shadowColor)), w2;
  } }), f = (await l2.next()).value;
  if (t.loadAdditionalAsset && f.length) {
    let g2 = yv(f), y = [], x2 = {};
    await Promise.all(Object.entries(g2).flatMap(([w2, P2]) => P2.map((T) => {
      let A = `${w2}_${T}`;
      return u2.has(A) ? null : (u2.add(A), t.loadAdditionalAsset(w2, T).then((E) => {
        typeof E == "string" ? x2[T] = E : E && (Array.isArray(E) ? y.push(...E) : y.push(E));
      }));
    }))), n.addFonts(y), Object.assign(a, x2);
  }
  await l2.next(), s.calculateLayout(i, o, r.DIRECTION_LTR);
  let c2 = (await l2.next([0, 0])).value, m2 = s.getComputedWidth(), h2 = s.getComputedHeight();
  return s.freeRecursive(), Io({ width: m2, height: h2, content: c2 });
}
function bv(e, t) {
  if (t) {
    let r = e.Config.create();
    return r.setPointScaleFactor(t), e.Node.createWithConfig(r);
  } else
    return e.Node.create();
}
function yv(e) {
  let t = {}, r = {};
  for (let { word: n, locale: i } of e) {
    let o = ol(n, i).join("|");
    r[o] = r[o] || "", r[o] += n;
  }
  return Object.keys(r).forEach((n) => {
    t[n] = t[n] || [], n === "emoji" ? t[n].push(...Hc(De(r[n], "grapheme"))) : (t[n][0] = t[n][0] || "", t[n][0] += Hc(De(r[n], "grapheme", n === "unknown" ? void 0 : n)).join(""));
  }), t;
}
function Hc(e) {
  return Array.from(new Set(e));
}

// node_modules/.pnpm/@resvg+resvg-wasm@2.4.1/node_modules/@resvg/resvg-wasm/index.mjs
var resvg_wasm_exports = {};
__export(resvg_wasm_exports, {
  Resvg: () => Resvg2,
  initWasm: () => initWasm
});
var wasm;
var heap = new Array(128).fill(void 0);
heap.push(void 0, null, true, false);
var heap_next = heap.length;
function addHeapObject(obj) {
  if (heap_next === heap.length)
    heap.push(heap.length + 1);
  const idx = heap_next;
  heap_next = heap[idx];
  heap[idx] = obj;
  return idx;
}
function getObject(idx) {
  return heap[idx];
}
function dropObject(idx) {
  if (idx < 132)
    return;
  heap[idx] = heap_next;
  heap_next = idx;
}
function takeObject(idx) {
  const ret = getObject(idx);
  dropObject(idx);
  return ret;
}
var WASM_VECTOR_LEN = 0;
var cachedUint8Memory0 = null;
function getUint8Memory0() {
  if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
    cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8Memory0;
}
var cachedTextEncoder = new TextEncoder("utf-8");
var encodeString = typeof cachedTextEncoder.encodeInto === "function" ? function(arg, view) {
  return cachedTextEncoder.encodeInto(arg, view);
} : function(arg, view) {
  const buf = cachedTextEncoder.encode(arg);
  view.set(buf);
  return {
    read: arg.length,
    written: buf.length
  };
};
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length);
    getUint8Memory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len);
  const mem = getUint8Memory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3);
    const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
    const ret = encodeString(arg, view);
    offset += ret.written;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function isLikeNone(x2) {
  return x2 === void 0 || x2 === null;
}
var cachedInt32Memory0 = null;
function getInt32Memory0() {
  if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
    cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
  }
  return cachedInt32Memory0;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function getStringFromWasm0(ptr, len) {
  return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
  return instance.ptr;
}
var BBox = class {
  static __wrap(ptr) {
    const obj = Object.create(BBox.prototype);
    obj.ptr = ptr;
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.ptr;
    this.ptr = 0;
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_bbox_free(ptr);
  }
  /**
  * @returns {number}
  */
  get x() {
    const ret = wasm.__wbg_get_bbox_x(this.ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set x(arg0) {
    wasm.__wbg_set_bbox_x(this.ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get y() {
    const ret = wasm.__wbg_get_bbox_y(this.ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set y(arg0) {
    wasm.__wbg_set_bbox_y(this.ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get width() {
    const ret = wasm.__wbg_get_bbox_width(this.ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set width(arg0) {
    wasm.__wbg_set_bbox_width(this.ptr, arg0);
  }
  /**
  * @returns {number}
  */
  get height() {
    const ret = wasm.__wbg_get_bbox_height(this.ptr);
    return ret;
  }
  /**
  * @param {number} arg0
  */
  set height(arg0) {
    wasm.__wbg_set_bbox_height(this.ptr, arg0);
  }
};
var RenderedImage = class {
  static __wrap(ptr) {
    const obj = Object.create(RenderedImage.prototype);
    obj.ptr = ptr;
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.ptr;
    this.ptr = 0;
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_renderedimage_free(ptr);
  }
  /**
  * Get the PNG width
  * @returns {number}
  */
  get width() {
    const ret = wasm.renderedimage_width(this.ptr);
    return ret >>> 0;
  }
  /**
  * Get the PNG height
  * @returns {number}
  */
  get height() {
    const ret = wasm.renderedimage_height(this.ptr);
    return ret >>> 0;
  }
  /**
  * Write the image data to Uint8Array
  * @returns {Uint8Array}
  */
  asPng() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.renderedimage_asPng(retptr, this.ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      if (r2) {
        throw takeObject(r1);
      }
      return takeObject(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Get the RGBA pixels of the image
  * @returns {Uint8Array}
  */
  get pixels() {
    const ret = wasm.renderedimage_pixels(this.ptr);
    return takeObject(ret);
  }
};
var Resvg = class {
  static __wrap(ptr) {
    const obj = Object.create(Resvg.prototype);
    obj.ptr = ptr;
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.ptr;
    this.ptr = 0;
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_resvg_free(ptr);
  }
  /**
  * @param {Uint8Array | string} svg
  * @param {string | undefined} options
  */
  constructor(svg, options) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      var ptr0 = isLikeNone(options) ? 0 : passStringToWasm0(options, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      var len0 = WASM_VECTOR_LEN;
      wasm.resvg_new(retptr, addHeapObject(svg), ptr0, len0);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      if (r2) {
        throw takeObject(r1);
      }
      return Resvg.__wrap(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Get the SVG width
  * @returns {number}
  */
  get width() {
    const ret = wasm.resvg_width(this.ptr);
    return ret;
  }
  /**
  * Get the SVG height
  * @returns {number}
  */
  get height() {
    const ret = wasm.resvg_height(this.ptr);
    return ret;
  }
  /**
  * Renders an SVG in Wasm
  * @returns {RenderedImage}
  */
  render() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_render(retptr, this.ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      if (r2) {
        throw takeObject(r1);
      }
      return RenderedImage.__wrap(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * Output usvg-simplified SVG string
  * @returns {string}
  */
  toString() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_toString(retptr, this.ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      return getStringFromWasm0(r0, r1);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_free(r0, r1);
    }
  }
  /**
  * Calculate a maximum bounding box of all visible elements in this SVG.
  *
  * Note: path bounding box are approx values.
  * @returns {BBox | undefined}
  */
  innerBBox() {
    const ret = wasm.resvg_innerBBox(this.ptr);
    return ret === 0 ? void 0 : BBox.__wrap(ret);
  }
  /**
  * Calculate a maximum bounding box of all visible elements in this SVG.
  * This will first apply transform.
  * Similar to `SVGGraphicsElement.getBBox()` DOM API.
  * @returns {BBox | undefined}
  */
  getBBox() {
    const ret = wasm.resvg_getBBox(this.ptr);
    return ret === 0 ? void 0 : BBox.__wrap(ret);
  }
  /**
  * Use a given `BBox` to crop the svg. Currently this method simply changes
  * the viewbox/size of the svg and do not move the elements for simplicity
  * @param {BBox} bbox
  */
  cropByBBox(bbox) {
    _assertClass(bbox, BBox);
    wasm.resvg_cropByBBox(this.ptr, bbox.ptr);
  }
  /**
  * @returns {Array<any>}
  */
  imagesToResolve() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.resvg_imagesToResolve(retptr, this.ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      if (r2) {
        throw takeObject(r1);
      }
      return takeObject(r0);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  /**
  * @param {string} href
  * @param {Uint8Array} buffer
  */
  resolveImage(href, buffer) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      const ptr0 = passStringToWasm0(href, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      wasm.resvg_resolveImage(retptr, this.ptr, ptr0, len0, addHeapObject(buffer));
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      if (r1) {
        throw takeObject(r0);
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
};
async function load2(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        if (module.headers.get("Content-Type") != "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function getImports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_new_15d3966e9981a196 = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_memory = function() {
    const ret = wasm.memory;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_buffer_cf65c07de34b9a08 = function(arg0) {
    const ret = getObject(arg0).buffer;
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_newwithbyteoffsetandlength_9fb2f11355ecadf5 = function(arg0, arg1, arg2) {
    const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
    takeObject(arg0);
  };
  imports.wbg.__wbg_new_537b7341ce90bb31 = function(arg0) {
    const ret = new Uint8Array(getObject(arg0));
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_instanceof_Uint8Array_01cebe79ca606cca = function(arg0) {
    let result;
    try {
      result = getObject(arg0) instanceof Uint8Array;
    } catch (e) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
    const obj = getObject(arg1);
    const ret = typeof obj === "string" ? obj : void 0;
    var ptr0 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len0;
    getInt32Memory0()[arg0 / 4 + 0] = ptr0;
  };
  imports.wbg.__wbg_new_b525de17f44a8943 = function() {
    const ret = new Array();
    return addHeapObject(ret);
  };
  imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return addHeapObject(ret);
  };
  imports.wbg.__wbg_push_49c286f04dd3bf59 = function(arg0, arg1) {
    const ret = getObject(arg0).push(getObject(arg1));
    return ret;
  };
  imports.wbg.__wbg_length_27a2afe8ab42b09f = function(arg0) {
    const ret = getObject(arg0).length;
    return ret;
  };
  imports.wbg.__wbg_set_17499e8aa4003ebd = function(arg0, arg1, arg2) {
    getObject(arg0).set(getObject(arg1), arg2 >>> 0);
  };
  imports.wbg.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  return imports;
}
function initMemory(imports, maybe_memory) {
}
function finalizeInit(instance, module) {
  wasm = instance.exports;
  init.__wbindgen_wasm_module = module;
  cachedInt32Memory0 = null;
  cachedUint8Memory0 = null;
  return wasm;
}
async function init(input) {
  if (typeof input === "undefined") {
    input = new URL("index_bg.wasm", void 0);
  }
  const imports = getImports();
  if (typeof input === "string" || typeof Request === "function" && input instanceof Request || typeof URL === "function" && input instanceof URL) {
    input = fetch(input);
  }
  initMemory(imports);
  const { instance, module } = await load2(await input, imports);
  return finalizeInit(instance, module);
}
var dist_default = init;
var initialized = false;
var initWasm = async (module_or_path) => {
  if (initialized) {
    throw new Error("Already initialized. The `initWasm()` function can be used only once.");
  }
  await dist_default(await module_or_path);
  initialized = true;
};
var Resvg2 = class extends Resvg {
  /**
   * @param {Uint8Array | string} svg
   * @param {ResvgRenderOptions | undefined} options
   */
  constructor(svg, options) {
    if (!initialized)
      throw new Error("Wasm has not been initialized. Call `initWasm()` function.");
    super(svg, JSON.stringify(options));
  }
};

// src/index.edge.ts
import yoga_wasm from "./yoga.wasm?module";
import resvg_wasm from "./resvg.wasm?module";

// src/emoji/index.ts
var U200D = String.fromCharCode(8205);
var UFE0Fg = /\uFE0F/g;
function getIconCode(char) {
  return toCodePoint(char.indexOf(U200D) < 0 ? char.replace(UFE0Fg, "") : char);
}
function toCodePoint(unicodeSurrogates) {
  var r = [], c2 = 0, p = 0, i = 0;
  while (i < unicodeSurrogates.length) {
    c2 = unicodeSurrogates.charCodeAt(i++);
    if (p) {
      r.push((65536 + (p - 55296 << 10) + (c2 - 56320)).toString(16));
      p = 0;
    } else if (55296 <= c2 && c2 <= 56319) {
      p = c2;
    } else {
      r.push(c2.toString(16));
    }
  }
  return r.join("-");
}
var apis = {
  twemoji: (code) => "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/" + code.toLowerCase() + ".svg",
  openmoji: "https://cdn.jsdelivr.net/npm/@svgmoji/openmoji@2.0.0/svg/",
  blobmoji: "https://cdn.jsdelivr.net/npm/@svgmoji/blob@2.0.0/svg/",
  noto: "https://cdn.jsdelivr.net/gh/svgmoji/svgmoji/packages/svgmoji__noto/svg/",
  fluent: (code) => "https://cdn.jsdelivr.net/gh/shuding/fluentui-emoji-unicode/assets/" + code.toLowerCase() + "_color.svg",
  fluentFlat: (code) => "https://cdn.jsdelivr.net/gh/shuding/fluentui-emoji-unicode/assets/" + code.toLowerCase() + "_flat.svg"
};
function loadEmoji(code, type) {
  if (!type || !apis[type]) {
    type = "twemoji";
  }
  const api = apis[type];
  if (typeof api === "function") {
    return fetch(api(code));
  }
  return fetch(`${api}${code.toUpperCase()}.svg`);
}

// src/language/index.ts
var FontDetector = class {
  constructor() {
    this.rangesByLang = {};
  }
  async detect(text, fonts) {
    await this.load(fonts);
    const result = {};
    for (const segment of text) {
      const lang = this.detectSegment(segment, fonts);
      if (lang) {
        result[lang] = result[lang] || "";
        result[lang] += segment;
      }
    }
    return result;
  }
  detectSegment(segment, fonts) {
    for (const font of fonts) {
      const range = this.rangesByLang[font];
      if (range && checkSegmentInRange(segment, range)) {
        return font;
      }
    }
    return null;
  }
  async load(fonts) {
    let params = "";
    const existingLang = Object.keys(this.rangesByLang);
    const langNeedsToLoad = fonts.filter((font) => !existingLang.includes(font));
    if (langNeedsToLoad.length === 0) {
      return;
    }
    for (const font of langNeedsToLoad) {
      params += `family=${font}&`;
    }
    params += "display=swap";
    const API = `https://fonts.googleapis.com/css2?${params}`;
    const fontFace = await (await fetch(API, {
      headers: {
        // Make sure it returns TTF.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"
      }
    })).text();
    this.addDetectors(fontFace);
  }
  addDetectors(input) {
    const regex = /font-family:\s*'(.+?)';.+?unicode-range:\s*(.+?);/gms;
    const matches = input.matchAll(regex);
    for (const [, _lang, range] of matches) {
      const lang = _lang.replaceAll(" ", "+");
      if (!this.rangesByLang[lang]) {
        this.rangesByLang[lang] = [];
      }
      this.rangesByLang[lang].push(...convert(range));
    }
  }
};
function convert(input) {
  return input.split(", ").map((range) => {
    range = range.replaceAll("U+", "");
    const [start, end] = range.split("-").map((hex) => parseInt(hex, 16));
    if (isNaN(end)) {
      return start;
    }
    return [start, end];
  });
}
function checkSegmentInRange(segment, range) {
  const codePoint = segment.codePointAt(0);
  if (!codePoint)
    return false;
  return range.some((val) => {
    if (typeof val === "number") {
      return codePoint === val;
    } else {
      const [start, end] = val;
      return start <= codePoint && codePoint <= end;
    }
  });
}
var languageFontMap = {
  "ja-JP": "Noto+Sans+JP",
  "ko-KR": "Noto+Sans+KR",
  "zh-CN": "Noto+Sans+SC",
  "zh-TW": "Noto+Sans+TC",
  "zh-HK": "Noto+Sans+HK",
  "th-TH": "Noto+Sans+Thai",
  "bn-IN": "Noto+Sans+Bengali",
  "ar-AR": "Noto+Sans+Arabic",
  "ta-IN": "Noto+Sans+Tamil",
  "ml-IN": "Noto+Sans+Malayalam",
  "he-IL": "Noto+Sans+Hebrew",
  "te-IN": "Noto+Sans+Telugu",
  devanagari: "Noto+Sans+Devanagari",
  kannada: "Noto+Sans+Kannada",
  symbol: ["Noto+Sans+Symbols", "Noto+Sans+Symbols+2"],
  math: "Noto+Sans+Math",
  unknown: "Noto+Sans"
};

// src/og.ts
async function loadGoogleFont(font, text) {
  if (!font || !text)
    return;
  const API = `https://fonts.googleapis.com/css2?family=${font}&text=${encodeURIComponent(
    text
  )}`;
  const css = await (await fetch(API, {
    headers: {
      // Make sure it returns TTF.
      "User-Agent": "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1"
    }
  })).text();
  const resource = css.match(/src: url\((.+)\) format\('(opentype|truetype)'\)/);
  if (!resource)
    throw new Error("Failed to download dynamic font");
  const res = await fetch(resource[1]);
  if (!res.ok) {
    throw new Error("Failed to download dynamic font. Status: " + res.status);
  }
  return res.arrayBuffer();
}
var detector = new FontDetector();
var assetCache = /* @__PURE__ */ new Map();
var loadDynamicAsset = ({ emoji }) => {
  const fn = async (code, text) => {
    if (code === "emoji") {
      return `data:image/svg+xml;base64,` + btoa(await (await loadEmoji(getIconCode(text), emoji)).text());
    }
    const codes = code.split("|");
    const names = codes.map((code2) => languageFontMap[code2]).filter(Boolean).flat();
    if (names.length === 0)
      return [];
    try {
      const textByFont = await detector.detect(text, names);
      const fonts = Object.keys(textByFont);
      const fontData = await Promise.all(
        fonts.map((font) => loadGoogleFont(font, textByFont[font]))
      );
      return fontData.map((data, index) => ({
        name: `satori_${codes[index]}_fallback_${text}`,
        data,
        weight: 400,
        style: "normal",
        lang: codes[index] === "unknown" ? void 0 : codes[index]
      }));
    } catch (e) {
      console.error("Failed to load dynamic font for", text, ". Error:", e);
    }
  };
  return async (...args) => {
    const key = JSON.stringify(args);
    const cache = assetCache.get(key);
    if (cache)
      return cache;
    const asset = await fn(...args);
    assetCache.set(key, asset);
    return asset;
  };
};
async function render(satori, resvg, sharp, opts, defaultFonts, element) {
  const options = Object.assign(
    {
      width: 1200,
      height: 630,
      debug: false
    },
    opts
  );
  const svg = await satori(element, {
    width: options.width,
    height: options.height,
    debug: options.debug,
    fonts: options.fonts || defaultFonts,
    loadAdditionalAsset: loadDynamicAsset({
      emoji: options.emoji
    })
  });
  let pngBuffer;
  if (sharp) {
    pngBuffer = await sharp(new TextEncoder().encode(svg)).resize(options.width).png().toBuffer();
  } else {
    const resvgJS = new resvg.Resvg(svg, {
      fitTo: {
        mode: "width",
        value: options.width
      }
    });
    const pngData = resvgJS.render();
    pngBuffer = pngData.asPng();
    pngData.free();
    resvgJS.free();
  }
  return pngBuffer;
}

// src/index.edge.ts
var initializedResvg = initWasm(resvg_wasm);
var initializeSatori = Ad(yoga_wasm);
var fallbackFont = fetch(
  new URL("./Geist-Regular.ttf", import.meta.url)
).then((res) => res.arrayBuffer());
var ImageResponse = class extends Response {
  constructor(element, options = {}) {
    const result = new ReadableStream({
      async start(controller) {
        const [fontData] = await Promise.all([
          fallbackFont,
          initializeSatori,
          initializedResvg
        ]);
        const fonts = [
          {
            name: "geist",
            data: fontData,
            weight: 400,
            style: "normal"
          }
        ];
        const result2 = await render(
          Yc,
          resvg_wasm_exports,
          void 0,
          options,
          fonts,
          element
        );
        controller.enqueue(result2);
        controller.close();
      }
    });
    super(result, {
      headers: {
        "content-type": "image/png",
        "cache-control": process.env.NODE_ENV === "development" ? "no-cache, no-store" : "public, immutable, no-transform, max-age=31536000",
        ...options.headers
      },
      status: options.status,
      statusText: options.statusText
    });
  }
};
export {
  ImageResponse
};
/*! Copyright Twitter Inc. and other contributors. Licensed under MIT */
/*! Bundled license information:

escape-html/index.js:
  (*!
   * escape-html
   * Copyright(c) 2012-2013 TJ Holowaychuk
   * Copyright(c) 2015 Andreas Lubbe
   * Copyright(c) 2015 Tiancheng "Timothy" Gu
   * MIT Licensed
   *)

css-background-parser/index.js:
  (*!
   * https://github.com/gilmoreorless/css-background-parser
   * Copyright © 2015 Gilmore Davidson under the MIT license: http://gilmoreorless.mit-license.org/
   *)

parse-css-color/dist/index.esm.js:
  (**
   * parse-css-color
   * @version v0.2.1
   * @link http://github.com/noeldelgado/parse-css-color/
   * @license MIT
   *)
*/
