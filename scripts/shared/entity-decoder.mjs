// Safe numeric decoder - 
function decodeNumericReference(code) {
  try {
    // JavaScript support limit check
    if (code > 0x10FFFF) return String.fromCharCode(0xFFFD); 
    return String.fromCodePoint(code);
  } catch (e) {
    
    return String.fromCharCode(0xFFFD); 
  }
}

// Single-pass entity decoder - 
export function decodeHtmlEntities(s) {
  if (typeof s !== 'string') return s;
  
  return s.replace(/&(?:amp|lt|gt|quot|apos|#x([0-9a-fA-F]+)|#(\d+));/g, (m, hex, dec) => {
    if (hex !== undefined) return decodeNumericReference(parseInt(hex, 16));
    if (dec !== undefined) return decodeNumericReference(Number(dec));
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[m];
  });
}